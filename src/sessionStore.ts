import { z } from "zod";
import { notebookLMCredentialEnvelopeSchema, parseCookieHeader, sessionCredentials, type NotebookLMCredentialEnvelope } from "./authArtifact";
import { parseEnv, type Env } from "./config";
import { base64ToBytes, decryptEnvelope, encryptedEnvelopeSchema, encryptEnvelope, type EncryptedEnvelope } from "./crypto";
import { NotebookLMClient, NotebookLMError, type NotebookLMFailureStage } from "./notebooklm";
import { inferHeaderCookies } from "./cookies";
import { logAuthEvent, type AuthEvent } from "./authTelemetry";
import { toolDefs } from "./tools";

const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connect") }), z.object({ kind: z.literal("refresh") }), z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("tool"), tool: z.string().max(100), args: z.record(z.string(), z.unknown()) })
]);
export type SessionOperation = z.infer<typeof operationSchema>;
export type SessionResult = {
  ok: boolean; envelope: NotebookLMCredentialEnvelope; payload: Record<string, unknown>; traceId: string;
  error?: { stage: NotebookLMFailureStage; reason: string; status?: number; rpcStatus?: number };
};
export type StoredSession = {
  encrypted: EncryptedEnvelope; version: number; expiresAt: number; lastRotationAttemptAt: number;
  counters: Record<string, number>; lastSuccessAt?: string; lastReason?: string; lastOutcome?: string;
  seedSource?: NotebookLMCredentialEnvelope["source"]; importedAt?: string; lastTraceId?: string;
  lastRotation?: { outcome?: string; status?: number; reason?: string; psidtsChanged?: boolean }; lastAttemptAt?: string;
};
export interface SessionPersistence {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: StoredSession): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm?(time: number): Promise<void>;
}
export function sessionKey(credId: string): string { return `cred:${credId}`; }

// Coordinate copies of one Google session, not all logins on an account.
// A keyed identifier avoids storing or logging an unkeyed hash of SID.
export async function identifySession(env: Env, envelope: NotebookLMCredentialEnvelope): Promise<string> {
  if (envelope.sessionKey) return envelope.sessionKey;
  const cookies = envelope.cookieJar ?? inferHeaderCookies(envelope.cookieHeader, envelope.baseUrl);
  const identity = cookies.find((c) => c.name === "SID" && c.domain.replace(/^\./, "") === "google.com")?.value
    ?? parseCookieHeader(envelope.cookieHeader).get("SID") ?? parseCookieHeader(envelope.cookieHeader).get("__Secure-1PSID") ?? envelope.credId;
  if (!identity) throw new NotebookLMError("Session identity missing", "session_store", { reason: "identity_missing" });
  const key = await crypto.subtle.importKey("raw", base64ToBytes(env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`notebooklm-session-v1\0${identity}`));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SessionCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private store: SessionPersistence, private env: Env, private backend: "durable-object" | "memory") {}
  run(envelope: NotebookLMCredentialEnvelope, operation: SessionOperation): Promise<SessionResult> {
    // DO requests can interleave across await. Serialize the whole operation.
    const next = this.tail.then(() => this.execute(envelope, operation));
    this.tail = next.catch(() => {});
    return next;
  }
  async expire(): Promise<void> {
    const next = this.tail.then(async () => {
      const state = await this.store.get<StoredSession>("session");
      if (state && state.expiresAt <= Date.now()) await this.store.deleteAll();
      else if (state) await this.store.setAlarm?.(state.expiresAt);
    });
    this.tail = next.catch(() => {});
    await next;
  }
  private async execute(input: NotebookLMCredentialEnvelope, operation: SessionOperation): Promise<SessionResult> {
    const traceId = crypto.randomUUID();
    const owner = await identifySession(this.env, input);
    let state: StoredSession | undefined;
    let seedSource = input.source;
    let envelope = { ...sessionCredentials(input), sessionKey: owner };
    try {
      state = await this.store.get<StoredSession>("session");
      if (state && state.expiresAt <= Date.now()) { await this.store.deleteAll(); state = undefined; }
      if (state && operation.kind !== "connect") {
        seedSource = state.seedSource ?? input.source;
        const latest = await decryptEnvelope(encryptedEnvelopeSchema.parse(state.encrypted), this.env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
        // Account route remains grant-specific; cookie state is session-wide.
        const sameProduct = latest.baseUrl.includes("cloud.google.com") === input.baseUrl.includes("cloud.google.com");
        envelope = { ...envelope, cookieJar: latest.cookieJar, cookieHeader: latest.cookieHeader, baseUrl: sameProduct ? latest.baseUrl : input.baseUrl };
      } else if (!state && operation.kind !== "connect" && input.credId && this.env.NOTEBOOKLM_SESSION_KV) {
        const legacy = await this.env.NOTEBOOKLM_SESSION_KV.get(sessionKey(input.credId));
        if (legacy !== null) {
          const migrated = await decryptEnvelope(encryptedEnvelopeSchema.parse(JSON.parse(legacy)), this.env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
          seedSource = migrated.source;
          envelope = { ...envelope, cookieJar: migrated.cookieJar, cookieHeader: migrated.cookieHeader };
          logAuthEvent({ event: "storage", traceId, session: owner.slice(0, 12), reason: "migrated_from_kv", backend: this.backend });
        }
      }
    } catch {
      logAuthEvent({ event: "storage", traceId, session: owner.slice(0, 12), outcome: "failed", reason: "read_failed", backend: this.backend });
      return { ok: false, envelope, payload: {}, traceId, error: { stage: "session_store", reason: "read_failed" } };
    }
    const counters = { ...state?.counters };
    const count = (name: string) => { counters[name] = (counters[name] ?? 0) + 1; };
    let lastRotationAttemptAt = state?.lastRotationAttemptAt ?? 0;
    let lastRotation = state?.lastRotation;
    let currentDeviceChallenge = false;
    let recoveryAttempted = false;
    const observe = (event: AuthEvent) => {
      if (event.event === "rotation" && event.reason === "dbsc_challenge") currentDeviceChallenge = true;
      if (event.event === "rotation" && event.outcome !== "skipped") {
        lastRotation = { outcome: event.outcome, status: event.status, reason: event.reason, psidtsChanged: event.psidtsChanged };
        if (event.psidtsChanged) count("rotation_psidts_updates");
        if (event.outcome === "rotated") count("rotation_updates");
        if (event.outcome === "failed" || event.outcome === "expired") count("rotation_failures");
      }
      if (event.event === "recovery" && event.outcome === "started") { recoveryAttempted = true; count("recovery_attempts"); }
      if (event.event === "recovery" && event.outcome === "success") count("recovery_successes");
      if (event.event === "http" && event.hop && event.hop > 0) count("redirect_hops");
      logAuthEvent({ ...event, traceId, session: owner.slice(0, 12), backend: this.backend });
    };
    const version = (state?.version ?? 0) + 1;
    let rotationMinted = false;
    const checkpoint = async (reason: "rotation_attempt" | "rotation_checkpoint") => {
      // An unsuccessful reconnect must not seed its obsolete cURL over an
      // existing owner's accepted jar. The attempt timestamp still survives.
      const preserveExisting = reason === "rotation_attempt" && operation.kind === "connect" && !!state;
      try {
        const snapshot = { ...envelope, cookieJar: client.getCookieJar(), cookieHeader: client.getCookieHeader() || envelope.cookieHeader, baseUrl: client.getBaseUrl() };
        const pending: StoredSession = {
          encrypted: preserveExisting ? state!.encrypted : await encryptEnvelope(snapshot, this.env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64), version,
          expiresAt: Date.now() + this.env.CONNECTOR_TTL_MAX_DAYS * 86_400_000, lastRotationAttemptAt, lastRotation, counters,
          seedSource: preserveExisting ? state!.seedSource : seedSource,
          importedAt: preserveExisting ? state!.importedAt : operation.kind === "connect" ? new Date().toISOString() : state?.importedAt ?? input.createdAt,
          lastTraceId: traceId, lastOutcome: "pending", lastReason: reason, lastSuccessAt: state?.lastSuccessAt, lastAttemptAt: new Date().toISOString()
        };
        await this.store.put("session", pending);
        await this.store.setAlarm?.(pending.expiresAt);
      } catch {
        count("persistence_failures"); observe({ event: "storage", outcome: "failed", reason: `${reason}_failed` });
        throw new NotebookLMError("Session checkpoint failed", "session_store", { reason: `${reason}_failed` });
      }
      observe({ event: "storage", outcome: "success", reason, version });
    };
    const client: NotebookLMClient = new NotebookLMClient({ ...envelope, fetch: (input, init) => fetch(input, init), observe,
      rotationNotBefore: lastRotationAttemptAt + 60_000,
      onRotateAttempt: async () => { lastRotationAttemptAt = Date.now(); count("rotation_attempts"); await checkpoint("rotation_attempt"); },
      onRotation: () => { rotationMinted = true; return checkpoint("rotation_checkpoint"); }
    });
    if (operation.kind === "status" || operation.kind === "tool" && operation.tool === "get_auth_status") return { ok: true, envelope, traceId, payload: { diagnostics: {
      backend: this.backend, source: seedSource, callerSource: input.source, importedAt: state?.importedAt ?? null,
      lastTraceId: state?.lastTraceId ?? null, state: state?.lastOutcome ?? "unverified", reason: state?.lastReason ?? null,
      lastAttemptAt: state?.lastAttemptAt ?? null, lastSuccessAt: state?.lastSuccessAt ?? null, counters, rotation: lastRotation ?? null,
      inventory: client.getInventory(), capabilities: { browserReauth: false, masterToken: false },
      interpretation: "A failed session does not establish that every cURL session is unsupported."
    } } };
    let payload: Record<string, unknown> = {};
    let failure: SessionResult["error"];
    try {
      if (operation.kind === "connect") observe({ event: "import", source: envelope.source, inventory: client.getInventory() });
      await client.rotateCookies();
      if (operation.kind === "connect" || operation.kind === "refresh") await client.validateAuthentication();
      else if (operation.kind === "tool") {
        const def = toolDefs.find((d) => d.name === operation.tool);
        if (!def) throw new Error("unknown_tool");
        payload = await def.run(client, z.object(def.inputSchema).parse(operation.args));
      }
      count("successful_operations");
    } catch (error) {
      count("failed_operations");
      failure = error instanceof NotebookLMError ? { stage: error.stage, reason: error.reason, status: error.status, rpcStatus: error.rpcStatus }
        : { stage: "upstream_parse", reason: error instanceof z.ZodError ? "input_validation" : "runtime" };
      count(`failure_${failure.reason}`);
    }
    // Accepted intermediate rotations survive downstream auth rejection.
    envelope = { ...envelope, cookieJar: client.getCookieJar(), cookieHeader: client.getCookieHeader() || envelope.cookieHeader, baseUrl: client.getBaseUrl() };
    const reason = failure?.stage === "auth_expired" && currentDeviceChallenge ? "device_bound_challenge" : failure?.reason;
    const lastOutcome = !failure ? "healthy" : recoveryAttempted ? "recovery_exhausted"
      : ["auth_challenge", "access_denied", "cookie_mismatch", "upstream_redirect"].includes(failure.stage) ? "blocked" : "failed";
    const preserveExisting = !!failure && operation.kind === "connect" && !!state && !rotationMinted;
    const next: StoredSession = { encrypted: preserveExisting ? state!.encrypted : await encryptEnvelope(envelope, this.env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64),
      version, expiresAt: Date.now() + this.env.CONNECTOR_TTL_MAX_DAYS * 86_400_000,
      counters, lastRotationAttemptAt, lastRotation, lastOutcome, lastReason: reason,
      seedSource: preserveExisting ? state!.seedSource : seedSource,
      importedAt: preserveExisting ? state!.importedAt : operation.kind === "connect" ? new Date().toISOString() : state?.importedAt ?? input.createdAt, lastTraceId: traceId,
      lastSuccessAt: failure ? state?.lastSuccessAt : new Date().toISOString(), lastAttemptAt: new Date().toISOString() };
    try { await this.store.put("session", next); await this.store.setAlarm?.(next.expiresAt); }
    catch {
      count("persistence_failures");
      observe({ event: "storage", outcome: "failed", reason: "persist_failed_after_upstream" });
      if (failure?.stage !== "session_store") failure = { stage: "session_store", reason: "persist_failed_after_upstream" };
    }
    observe({ event: "operation", outcome: failure ? "failed" : "success", stage: failure?.stage, reason: failure?.reason,
      status: failure?.status, rpcStatus: failure?.rpcStatus, source: seedSource, version: next.version, counters, lastSuccessAt: next.lastSuccessAt, inventory: client.getInventory() });
    return { ok: !failure, envelope, payload, traceId, error: failure };
  }
}

// SQLite-backed DO, compatible with Workers Free. Credentials are encrypted at
// rest. This internal object has no public route on the Worker.
export class NotebookLMSession {
  private coordinator: SessionCoordinator;
  constructor(state: DurableObjectState, env: unknown) { this.coordinator = new SessionCoordinator(state.storage as SessionPersistence, parseEnv(env), "durable-object"); }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    try {
      const body = await request.json() as { envelope: unknown; operation: unknown };
      return Response.json(await this.coordinator.run(notebookLMCredentialEnvelopeSchema.parse(body.envelope), operationSchema.parse(body.operation)));
    } catch {
      logAuthEvent({ event: "storage", outcome: "failed", reason: "owner_request_failed" });
      return new Response("Session operation unavailable", { status: 503 });
    }
  }
  async alarm(): Promise<void> { await this.coordinator.expire(); }
}

const memory = new Map<string, { coordinator: SessionCoordinator; expiresAt: number }>();
export async function runSessionOperation(env: Env, input: NotebookLMCredentialEnvelope, operation: SessionOperation): Promise<SessionResult> {
  const owner = await identifySession(env, input);
  const envelope = { ...input, sessionKey: owner };
  if (env.NOTEBOOKLM_SESSIONS) {
    try {
      const stub = env.NOTEBOOKLM_SESSIONS.get(env.NOTEBOOKLM_SESSIONS.idFromName(owner));
      const response = await stub.fetch("https://session.internal/operation", { method: "POST", body: JSON.stringify({ envelope, operation }) });
      if (!response.ok) throw new Error("session_rpc_failed");
      return await response.json() as SessionResult;
    } catch { throw new NotebookLMError("Session storage unavailable", "session_store", { reason: "owner_unavailable" }); }
  }
  if (env.SESSION_STORE_MODE !== "memory") throw new NotebookLMError("Session binding missing", "session_store", { reason: "binding_missing" });
  // Explicit local/test mode only. Production never falls back to local state.
  for (const [key, entry] of memory) if (entry.expiresAt < Date.now()) memory.delete(key);
  const key = input.credId ?? owner;
  let entry = memory.get(key);
  if (!entry) {
    if (memory.size >= 1000) throw new NotebookLMError("Local session limit", "session_store", { reason: "local_capacity" });
    let value: StoredSession | undefined;
    const store: SessionPersistence = { get: async <T>() => value as T | undefined, put: async (_key, v) => { value = v; }, deleteAll: async () => { value = undefined; } };
    entry = { coordinator: new SessionCoordinator(store, env, "memory"), expiresAt: Date.now() + 86_400_000 };
    memory.set(key, entry);
  }
  return entry.coordinator.run(envelope, operation);
}
export function unwrapSessionResult(result: SessionResult): SessionResult {
  if (result.ok) return result;
  const failure = result.error!;
  const error = new NotebookLMError("NotebookLM session operation failed", failure.stage, failure);
  Object.assign(error, { traceId: result.traceId });
  throw error;
}
