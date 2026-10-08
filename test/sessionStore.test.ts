import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { parseNotebookLMAuthArtifact } from "../src/authArtifact";
import { parseEnv } from "../src/config";
import { decryptEnvelope } from "../src/crypto";
import { buildNotebookLMRpcResponse, NotebookLMClient } from "../src/notebooklm";
import { authenticateMcp } from "../src/oauth";
import { keepAliveSessions, loadSessionEnvelope, persistSessionEnvelope, sessionKey } from "../src/sessionStore";
import { env, fakeCtx, fakeKv, fetchWorker, issueAccessToken, sampleCookie } from "./helpers";

const bootstrapHtml = `<!doctype html><script>{"SNlM0e":"csrf","FdrFJe":"sid"}</script>`;
const liveFetch: typeof fetch = (input, init) => fetch(input, init);

function parseEnvelope() {
  return parseNotebookLMAuthArtifact(`curl 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute' -H 'cookie: ${sampleCookie}'`);
}

function envWithKv(kv: KVNamespace, dropMocks = false) {
  const raw = dropMocks ? Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("MOCK_"))) : env;
  return parseEnv({ ...raw, NOTEBOOKLM_SESSION_KV: kv });
}

function jarClient(baseUrl: string, cookieHeader: string) {
  return new NotebookLMClient({ baseUrl, cookieHeader, fetch: liveFetch });
}

describe("session store", () => {
  it("assigns a stable credId to parsed artifacts", () => {
    const envelope = parseEnvelope();
    expect(envelope.credId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("round-trips the rotated jar through encrypted KV entries", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    const envelope = parseEnvelope();
    const client = jarClient(envelope.baseUrl, `${sampleCookie}; SIDCC=rotated`);

    await persistSessionEnvelope(testEnv, envelope, client);
    const loaded = await loadSessionEnvelope(testEnv, envelope.credId);

    expect(loaded?.cookieHeader).toContain("SIDCC=rotated");
    expect(loaded?.cookieHeader).toContain("SID=sid-test-value");
    // Stored blob is the encrypted envelope — plaintext cookies never hit KV.
    const raw = await kv.get(sessionKey(envelope.credId!));
    expect(raw).not.toContain("sid-test-value");
  });

  it("token exchange seeds the session store for keep-alive coverage", async () => {
    const kv = fakeKv();
    const accessToken = await issueAccessToken("notebooklm:read", envWithKv(kv));
    const claims = decodeJwt(accessToken) as { credential: Parameters<typeof decryptEnvelope>[0] };
    const tokenEnvelope = await decryptEnvelope(claims.credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
    const stored = await loadSessionEnvelope(envWithKv(kv), tokenEnvelope.credId);
    expect(stored?.cookieHeader).toContain("SID=sid-test-value");
  });

  it("persist lets a call's own rotations win over the stored jar", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    const envelope = parseEnvelope();
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, `${sampleCookie}; SIDCC=seeded`));
    // The call seeded with SIDCC=seeded and rotated it mid-request.
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, `${sampleCookie}; SIDCC=call-rotated`), `${sampleCookie}; SIDCC=seeded`);
    const loaded = await loadSessionEnvelope(testEnv, envelope.credId);
    expect(loaded?.cookieHeader).toContain("SIDCC=call-rotated");
  });

  it("persist unions with a concurrently written jar instead of overwriting it", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    const envelope = parseEnvelope();
    // A faster call already persisted its newer rotation.
    const kvHeader = `${sampleCookie}; SIDCC=kv-newer`;
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, kvHeader));
    // A slower call seeded from that same jar did not touch SIDCC but rotated OTCSR.
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, `${sampleCookie}; SIDCC=kv-newer; OTCSR=call-rotated`), kvHeader);
    const loaded = await loadSessionEnvelope(testEnv, envelope.credId);
    expect(loaded?.cookieHeader).toContain("SIDCC=kv-newer");
    expect(loaded?.cookieHeader).toContain("OTCSR=call-rotated");
  });

  it("persist applies deletions the call observed to the stored jar", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    const envelope = parseEnvelope();
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, `${sampleCookie}; SIDCC=seeded`));
    // The call deleted SIDCC mid-request (e.g. an expired Set-Cookie).
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, sampleCookie), `${sampleCookie}; SIDCC=seeded`);
    const loaded = await loadSessionEnvelope(testEnv, envelope.credId);
    expect(loaded?.cookieHeader).not.toContain("SIDCC");
  });

  it("returns null for unknown or missing credentials", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    expect(await loadSessionEnvelope(testEnv, "missing-cred")).toBeNull();
    expect(await loadSessionEnvelope(testEnv, undefined)).toBeNull();
  });

  it("authenticateMcp prefers the KV jar over the token snapshot", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    const accessToken = await issueAccessToken("notebooklm:read");
    const claims = decodeJwt(accessToken) as { credential: Parameters<typeof decryptEnvelope>[0] };
    const tokenEnvelope = await decryptEnvelope(claims.credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
    expect(tokenEnvelope.credId).toBeTruthy();

    const client = jarClient(tokenEnvelope.baseUrl, `${sampleCookie}; __Secure-1PSIDTS=kv-freshest`);
    await persistSessionEnvelope(testEnv, tokenEnvelope, client);

    const auth = await authenticateMcp(new Request("http://localhost:8787/mcp", { headers: { authorization: `Bearer ${accessToken}` } }), testEnv);
    expect(auth?.envelope.cookieHeader).toContain("__Secure-1PSIDTS=kv-freshest");
  });

  it("keep-alive refreshes live credentials and persists their rotation", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    const envelope = parseEnvelope();
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, envelope.cookieHeader));

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/")) {
        const headers = new Headers();
        headers.append("set-cookie", "__Secure-1PSIDTS=cron-rotated; Path=/");
        return new Response(bootstrapHtml, { headers });
      }
      return new Response(buildNotebookLMRpcResponse("wXbhsf", [[["nb-1", "Notebook 1"]]]));
    });
    try {
      const counts = await keepAliveSessions(testEnv);
      expect(counts).toEqual({ kept: 1, expired: 0, failed: 0 });
      const loaded = await loadSessionEnvelope(testEnv, envelope.credId);
      expect(loaded?.cookieHeader).toContain("__Secure-1PSIDTS=cron-rotated");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keep-alive evicts credentials whose session Google rejects", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    const envelope = parseEnvelope();
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, envelope.cookieHeader));

    vi.stubGlobal("fetch", async () => new Response('<html><form action="https://accounts.google.com/ServiceLogin"></form></html>'));
    try {
      const counts = await keepAliveSessions(testEnv);
      expect(counts).toEqual({ kept: 0, expired: 1, failed: 0 });
      expect(await kv.get(sessionKey(envelope.credId!))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keep-alive keeps credentials on transient upstream failures", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv);
    const envelope = parseEnvelope();
    await persistSessionEnvelope(testEnv, envelope, jarClient(envelope.baseUrl, envelope.cookieHeader));

    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    try {
      const counts = await keepAliveSessions(testEnv);
      expect(counts).toEqual({ kept: 0, expired: 0, failed: 1 });
      expect(await kv.get(sessionKey(envelope.credId!))).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a successful tool call persists jar rotations into KV", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv, true);
    const accessToken = await issueAccessToken("notebooklm:read");
    const claims = decodeJwt(accessToken) as { credential: Parameters<typeof decryptEnvelope>[0] };
    const tokenEnvelope = await decryptEnvelope(claims.credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/")) {
        const headers = new Headers();
        headers.append("set-cookie", "SIDCC=call-rotated; Path=/");
        return new Response(bootstrapHtml, { headers });
      }
      return new Response(buildNotebookLMRpcResponse("wXbhsf", [[["nb-1", "Notebook 1"]]]));
    });
    try {
      const response = await fetchWorker("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_notebooks", arguments: {} } })
      }, testEnv);
      expect(response.status).toBe(200);
      const loaded = await loadSessionEnvelope(testEnv, tokenEnvelope.credId);
      expect(loaded?.cookieHeader).toContain("SIDCC=call-rotated");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an auth_expired tool call evicts the stored session", async () => {
    const kv = fakeKv();
    const testEnv = envWithKv(kv, true);
    const accessToken = await issueAccessToken("notebooklm:read");
    const claims = decodeJwt(accessToken) as { credential: Parameters<typeof decryptEnvelope>[0] };
    const tokenEnvelope = await decryptEnvelope(claims.credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
    await persistSessionEnvelope(testEnv, tokenEnvelope, jarClient(tokenEnvelope.baseUrl, tokenEnvelope.cookieHeader));

    vi.stubGlobal("fetch", async () => new Response('<html><form action="https://accounts.google.com/ServiceLogin"></form></html>'));
    try {
      const ctx = fakeCtx();
      const response = await fetchWorker("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_notebooks", arguments: {} } })
      }, testEnv, ctx);
      await Promise.all(ctx.pending);
      expect(response.status).toBe(200);
      expect(await kv.get(sessionKey(tokenEnvelope.credId!))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
