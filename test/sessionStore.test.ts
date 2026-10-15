import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNotebookLMAuthArtifact } from "../src/authArtifact";
import { parseEnv } from "../src/config";
import { decryptEnvelope, encryptEnvelope } from "../src/crypto";
import { buildNotebookLMRpcResponse } from "../src/notebooklm";
import { SessionCoordinator, identifySession, runSessionOperation, sessionKey, type SessionPersistence, type StoredSession } from "../src/sessionStore";
import { env, fakeKv } from "./helpers";

const testEnv = () => parseEnv(Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("MOCK_"))));
const artifact = () => parseNotebookLMAuthArtifact("SID=synthetic; __Secure-1PSIDTS=seed; OSID=binding");
const html = '<script>{"SNlM0e":"csrf","FdrFJe":"session"}</script>';
function storage() {
  let record: StoredSession | undefined;
  const store: SessionPersistence = { get: async <T>() => structuredClone(record) as T | undefined, put: async (_key, value) => { record = structuredClone(value); }, deleteAll: async () => { record = undefined; } };
  return { store, record: () => record };
}
function upstream(rotate = "fresh") {
  return async (input: RequestInfo | URL) => String(input).includes("RotateCookies")
    ? new Response('[["identity.hfcr",600]]', { headers: { "set-cookie": `__Secure-1PSIDTS=${rotate}; Domain=.google.com; Path=/; Secure; HttpOnly` } })
    : new Response(String(input).includes("batchexecute") ? buildNotebookLMRpcResponse("wXbhsf", [[]]) : html);
}
afterEach(() => vi.unstubAllGlobals());

describe("serialized Google session owner", () => {
  it("coordinates copies of one SID and isolates separate Google sessions", async () => {
    expect(await identifySession(testEnv(), artifact())).toBe(await identifySession(testEnv(), artifact()));
    expect(await identifySession(testEnv(), artifact())).not.toBe(await identifySession(testEnv(), parseNotebookLMAuthArtifact("SID=another; OSID=b")));
  });
  it("persists rotated cookies encrypted before returning connect success", async () => {
    const s = storage(); vi.stubGlobal("fetch", upstream());
    const result = await new SessionCoordinator(s.store, testEnv(), "durable-object").run(artifact(), { kind: "connect" });
    expect(result.ok).toBe(true);
    expect(result.envelope.cookieHeader).toContain("fresh");
    expect(JSON.stringify(s.record())).not.toContain("SID=synthetic");
    expect((await decryptEnvelope(s.record()!.encrypted, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64)).cookieHeader).toContain("fresh");
  });
  it("loads the saved jar after owner recreation instead of regressing to the token", async () => {
    const s = storage(); const seed = artifact(); vi.stubGlobal("fetch", upstream());
    await new SessionCoordinator(s.store, testEnv(), "durable-object").run(seed, { kind: "connect" });
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("cookie") ?? ""); return upstream()(input);
    });
    const result = await new SessionCoordinator(s.store, testEnv(), "durable-object").run(seed, { kind: "refresh" });
    expect(result.ok).toBe(true); expect(seen[0]).toContain("__Secure-1PSIDTS=fresh");
    expect(s.record()?.counters.rotation_attempts).toBe(1);
  });
  it("serializes concurrent requests across Google I/O and save", async () => {
    const s = storage(); const seed = artifact(); const owner = new SessionCoordinator(s.store, testEnv(), "durable-object");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let rotations = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("RotateCookies")) { rotations++; firstStarted(); await gate; }
      return upstream()(input);
    });
    const first = owner.run(seed, { kind: "connect" }); await started;
    const second = owner.run(seed, { kind: "refresh" });
    await Promise.resolve(); expect(rotations).toBe(1);
    release(); const results = await Promise.all([first, second]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(rotations).toBe(1); expect(s.record()?.version).toBe(2);
  });
  it("keeps a successful mint when subsequent RPC authentication is rejected", async () => {
    const s = storage(); vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("batchexecute")) return new Response(")]}'\n" + JSON.stringify([["wrb.fr", "wXbhsf", null, null, null, [16], "generic"]]));
      return upstream()(input);
    });
    const result = await new SessionCoordinator(s.store, testEnv(), "durable-object").run(artifact(), { kind: "connect" });
    expect(result.ok).toBe(false); expect(result.error?.reason).toBe("rpc_unauthenticated");
    expect(result.envelope.cookieHeader).toContain("fresh"); expect(s.record()).toBeDefined();
    expect(s.record()?.counters.recovery_attempts).toBe(1);
  });
  it("fails closed on unreadable stored state without overwriting it or contacting Google", async () => {
    const s = storage(); vi.stubGlobal("fetch", upstream());
    const owner = new SessionCoordinator(s.store, testEnv(), "durable-object");
    const seed = artifact(); await owner.run(seed, { kind: "connect" });
    s.record()!.encrypted = { v: 1, iv: "bad", ciphertext: "bad" };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await owner.run(seed, { kind: "refresh" });
    expect(result.error?.reason).toBe("read_failed"); expect(fetch).not.toHaveBeenCalled();
    expect(s.record()?.encrypted).toEqual({ v: 1, iv: "bad", ciphertext: "bad" });
  });
  it("migrates the legacy KV jar once, then ignores the stale KV snapshot", async () => {
    const s = storage(); const seed = artifact(); const kv = fakeKv();
    await kv.put(sessionKey(seed.credId!), JSON.stringify(await encryptEnvelope({ ...seed, cookieJar: undefined, cookieHeader: "SID=synthetic; OSID=b; __Secure-1PSIDTS=legacy-new" }, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64)));
    const e = parseEnv({ ...testEnv(), NOTEBOOKLM_SESSION_KV: kv });
    const seen: string[] = []; vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Headers(init?.headers).get("cookie") ?? ""); return upstream()(input); });
    const owner = new SessionCoordinator(s.store, e, "durable-object");
    await owner.run(seed, { kind: "refresh" }); expect(seen[0]).toContain("legacy-new");
    await kv.put(sessionKey(seed.credId!), "invalid");
    expect((await owner.run(seed, { kind: "refresh" })).ok).toBe(true);
  });
  it("reports storage failure instead of claiming a mutation was safely persisted", async () => {
    const s = storage(); vi.stubGlobal("fetch", upstream());
    s.store.put = async () => { throw new Error("disk unavailable"); };
    const result = await new SessionCoordinator(s.store, testEnv(), "durable-object").run(parseNotebookLMAuthArtifact("SID=synthetic"), { kind: "connect" });
    expect(result.error?.reason).toBe("persist_failed_after_upstream");
  });
  it("checkpoints rotation before the next upstream request", async () => {
    const s = storage(); const seed = artifact();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (!String(input).includes("RotateCookies")) {
        expect(s.record()?.lastOutcome).toBe("pending");
        expect((await decryptEnvelope(s.record()!.encrypted, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64)).cookieHeader).toContain("fresh");
      }
      return upstream()(input);
    });
    expect((await new SessionCoordinator(s.store, testEnv(), "durable-object").run(seed, { kind: "connect" })).ok).toBe(true);
  });
  it("durably claims a rotation attempt before contacting Google", async () => {
    const s = storage(); const seed = artifact();
    let atRequest: StoredSession | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("RotateCookies")) atRequest = s.record();
      return upstream()(input);
    });
    expect((await new SessionCoordinator(s.store, testEnv(), "durable-object").run(seed, { kind: "connect" })).ok).toBe(true);
    expect(atRequest?.lastReason).toBe("rotation_attempt");
    expect(atRequest?.lastRotationAttemptAt).toBeGreaterThan(0);
    expect(atRequest?.counters.rotation_attempts).toBe(1);
  });
  it("does not replace the accepted jar after a failed reconnect with an obsolete snapshot", async () => {
    const s = storage(); const seed = artifact(); const owner = new SessionCoordinator(s.store, testEnv(), "durable-object");
    vi.stubGlobal("fetch", upstream());
    expect((await owner.run(seed, { kind: "connect" })).ok).toBe(true);
    vi.stubGlobal("fetch", async () => new Response("signed out", { status: 401 }));
    expect((await owner.run(seed, { kind: "connect" })).ok).toBe(false);
    const saved = await decryptEnvelope(s.record()!.encrypted, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
    expect(saved.cookieHeader).toContain("__Secure-1PSIDTS=fresh");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Headers(init?.headers).get("cookie") ?? ""); return upstream()(input); });
    expect((await owner.run(seed, { kind: "refresh" })).ok).toBe(true);
    expect(seen[0]).toContain("__Secure-1PSIDTS=fresh");
  });
  it("does not submit a mutation when the rotation checkpoint fails", async () => {
    const s = storage(); const put = s.store.put; let writes = 0;
    s.store.put = async (key, value) => { if (++writes > 1) throw new Error("disk unavailable"); await put(key, value); };
    const fetch = vi.fn(upstream()); vi.stubGlobal("fetch", fetch);
    const result = await new SessionCoordinator(s.store, testEnv(), "durable-object").run(artifact(), { kind: "tool", tool: "create_notebook", args: { title: "fixture" } });
    expect(result.error?.reason).toBe("rotation_checkpoint_failed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("RotateCookies");
  });
  it("does not contact Google when the durable attempt claim fails", async () => {
    const s = storage(); s.store.put = async () => { throw new Error("disk unavailable"); };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await new SessionCoordinator(s.store, testEnv(), "durable-object").run(artifact(), { kind: "refresh" });
    expect(result.error?.reason).toBe("rotation_attempt_failed"); expect(fetch).not.toHaveBeenCalled();
  });
  it("retains a received reconnect mint if its first checkpoint fails but the final save succeeds", async () => {
    const s = storage(); const seed = artifact(); vi.stubGlobal("fetch", upstream());
    const owner = new SessionCoordinator(s.store, testEnv(), "durable-object");
    await owner.run(seed, { kind: "connect" });
    s.record()!.lastRotationAttemptAt = 0;
    const put = s.store.put; let writes = 0;
    s.store.put = async (key, value) => { if (++writes === 2) throw new Error("transient write failure"); await put(key, value); };
    vi.stubGlobal("fetch", upstream("newer"));
    const result = await owner.run(seed, { kind: "connect" });
    expect(result.error?.reason).toBe("rotation_checkpoint_failed");
    expect((await decryptEnvelope(s.record()!.encrypted, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64)).cookieHeader).toContain("__Secure-1PSIDTS=newer");
  });
  it("exposes secret-free diagnostics even after Google recovery is exhausted", async () => {
    const s = storage(); const seed = artifact();
    vi.stubGlobal("fetch", async () => new Response("", { status: 401, headers: { "Sec-Session-Google-Challenge": "SECRET_CHALLENGE" } }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const owner = new SessionCoordinator(s.store, testEnv(), "durable-object");
      await owner.run(seed, { kind: "connect" });
      const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
      const result = await owner.run(seed, { kind: "status" });
      const diagnostic = JSON.stringify(result.payload);
      expect(diagnostic).toContain("device_bound_challenge");
      expect(diagnostic).not.toContain("synthetic"); expect(diagnostic).not.toContain("SECRET_CHALLENGE");
      expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET_CHALLENGE"); expect(fetch).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("never substitutes an ephemeral store when the production binding is missing", async () => {
    await expect(runSessionOperation(parseEnv({ ...testEnv(), SESSION_STORE_MODE: "durable-object" }), artifact(), { kind: "refresh" })).rejects.toMatchObject({ reason: "binding_missing" });
  });
});
