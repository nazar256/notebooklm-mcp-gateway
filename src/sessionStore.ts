import type { NotebookLMCredentialEnvelope } from "./authArtifact";
import { parseCookieHeader } from "./authArtifact";
import type { Env } from "./config";
import { decryptEnvelope, encryptedEnvelopeSchema, encryptEnvelope, type EncryptedEnvelope } from "./crypto";
import { NotebookLMClient } from "./notebooklm";

// Per-connector session store in Workers KV. Values are the same AES-GCM
// envelope shape the OAuth tokens carry, so cookies are never stored in
// plaintext. The store is authoritative for the rotating cookie jar; tokens
// stay the fallback snapshot for envelopes minted before this store existed.

const KEY_PREFIX = "cred:";

export function sessionKey(credId: string): string {
  return `${KEY_PREFIX}${credId}`;
}

export function sessionKv(env: Env): KVNamespace | undefined {
  return env.NOTEBOOKLM_SESSION_KV;
}

export async function loadSessionEnvelope(env: Env, credId: string | undefined): Promise<NotebookLMCredentialEnvelope | null> {
  const kv = sessionKv(env);
  if (!kv || !credId) return null;
  try {
    const raw = await kv.get(sessionKey(credId));
    if (!raw) return null;
    return await decryptEnvelope(encryptedEnvelopeSchema.parse(JSON.parse(raw)), env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
  } catch {
    return null;
  }
}

export async function persistSessionEnvelope(env: Env, envelope: NotebookLMCredentialEnvelope, client: NotebookLMClient, seedHeader?: string): Promise<void> {
  const kv = sessionKv(env);
  if (!kv || !envelope.credId) return;
  const cookieHeader = client.getCookieHeader();
  if (!cookieHeader) return;
  // Three-way merge: cookies this call rotated relative to its seed win;
  // untouched names keep whatever the store has (a concurrent call's newer
  // rotation); deletions the call observed remove stored entries.
  const stored = await loadSessionEnvelope(env, envelope.credId);
  const mergedHeader = stored ? mergeCookieHeaders(cookieHeader, seedHeader ?? envelope.cookieHeader, stored.cookieHeader) : cookieHeader;
  const encrypted = await encryptEnvelope({ ...envelope, cookieHeader: mergedHeader }, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
  await kv.put(sessionKey(envelope.credId), JSON.stringify(encrypted), { expirationTtl: sessionTtlSeconds(env) });
}

function mergeCookieHeaders(latest: string, seed: string, stored: string): string {
  const latestCookies = parseCookieHeader(latest);
  const seedCookies = parseCookieHeader(seed);
  const storedCookies = parseCookieHeader(stored);
  const merged = new Map(storedCookies);
  for (const [name, value] of latestCookies) {
    // The call rotated this cookie during the request — its value is newest.
    if (seedCookies.get(name) !== value || !storedCookies.has(name)) merged.set(name, value);
  }
  for (const name of seedCookies.keys()) {
    // The call deleted this cookie (e.g. expired Set-Cookie) — drop it even
    // when a concurrent writer still has it.
    if (!latestCookies.has(name)) merged.delete(name);
  }
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

// Seeds the store for a freshly connected credential so the cron keep-alive
// covers it even before the first tool call or refresh exchange.
export async function seedSessionEnvelope(env: Env, envelope: NotebookLMCredentialEnvelope, encrypted: EncryptedEnvelope): Promise<void> {
  const kv = sessionKv(env);
  if (!kv || !envelope.credId) return;
  if (await kv.get(sessionKey(envelope.credId))) return;
  await kv.put(sessionKey(envelope.credId), JSON.stringify(encrypted), { expirationTtl: sessionTtlSeconds(env) });
}

export async function deleteSession(env: Env, credId: string | undefined): Promise<void> {
  const kv = sessionKv(env);
  if (!kv || !credId) return;
  await kv.delete(sessionKey(credId));
}

function sessionTtlSeconds(env: Env): number {
  return Math.max(86_400, env.CONNECTOR_TTL_MAX_DAYS * 86_400);
}

// Cron keep-alive: replays every stored credential through a read-only ping so
// Google cookie rotations accumulate while clients are idle. Live credentials
// are re-persisted with their rotated jar; expired ones are evicted.
export async function keepAliveSessions(env: Env): Promise<{ kept: number; expired: number; failed: number }> {
  const kv = sessionKv(env);
  const counts = { kept: 0, expired: 0, failed: 0 };
  if (!kv) return counts;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: KEY_PREFIX, cursor });
    for (const key of page.keys) {
      const outcome = await keepAliveOne(env, kv, key.name);
      counts[outcome] += 1;
      console.log("NotebookLM session keep-alive", { credId: key.name.slice(KEY_PREFIX.length), outcome });
    }
    cursor = page.list_complete ? undefined : page.cursor || undefined;
  } while (cursor);
  console.log("NotebookLM session keep-alive done", counts);
  return counts;
}

async function keepAliveOne(env: Env, kv: KVNamespace, keyName: string): Promise<"kept" | "expired" | "failed"> {
  const stored = await loadSessionEnvelope(env, keyName.slice(KEY_PREFIX.length));
  if (!stored) return "failed";
  try {
    const client = new NotebookLMClient({
      baseUrl: stored.baseUrl,
      cookieHeader: stored.cookieHeader,
      sessionId: stored.sessionId,
      csrfToken: stored.csrfToken,
      validationRpcId: stored.validationRpcId,
      validationFReq: stored.validationFReq,
      fetch: (input, init) => fetch(input, init)
    });
    const ping = await client.refreshCookies();
    if (ping === "alive") {
      await persistSessionEnvelope(env, stored, client, stored.cookieHeader);
      return "kept";
    }
    if (ping === "expired") {
      await kv.delete(keyName);
      return "expired";
    }
    return "failed";
  } catch {
    return "failed";
  }
}
