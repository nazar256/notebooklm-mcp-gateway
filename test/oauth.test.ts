import { decodeJwt, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { base64ToBytes, decryptEnvelope, encryptEnvelope, pkceS256, signJwt } from "../src/crypto";
import { buildNotebookLMRpcResponse } from "../src/notebooklm";
import { env, fetchWorker, registerClient, sampleCookie } from "./helpers";

async function authorizeAndExchange(scope: string, selectedScopes = scope) {
  const redirectUri = "http://127.0.0.1:3555/callback";
  const clientId = await registerClient(redirectUri);
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
  const challenge = await pkceS256(verifier);
  const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent(scope)}`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
  const body = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope, csrf, artifact: `curl 'https://notebooklm.google.com' -H 'cookie: ${sampleCookie}'`, ttl_preset_days: "30" });
  for (const selected of selectedScopes.split(/\s+/).filter(Boolean)) {
    if (selected !== "notebooklm:read") body.set(`scope_${selected.replace(":", "_")}`, "on");
  }
  const auth = await fetchWorker("/authorize", { method: "POST", body });
  const redirect = /href="([^"]+)"/.exec(await auth.text())?.[1]?.replace(/&amp;/g, "&") ?? "";
  const code = new URL(redirect).searchParams.get("code") ?? "";
  const token = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }) });
  return { clientId, token, tokenBody: await token.json() as { access_token: string; refresh_token: string; scope: string } };
}

describe("OAuth", () => {
  it("metadata endpoints return expected fields", async () => {
    const auth = await (await fetchWorker("/.well-known/oauth-authorization-server")).json() as Record<string, unknown>;
    expect(auth.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(auth.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(auth.code_challenge_methods_supported).toEqual(["S256"]);
    expect(auth.scopes_supported).toEqual(["notebooklm:read", "notebooklm:chat", "notebooklm:write", "notebooklm:delete", "notebooklm:share"]);
    expect(auth.resource_parameter_supported).toBe(true);
    const resource = await (await fetchWorker("/.well-known/oauth-protected-resource/mcp")).json() as Record<string, unknown>;
    expect(resource.resource).toBe(env.MCP_RESOURCE);
  });

  it("dynamic registration accepts valid public client", async () => {
    const response = await fetchWorker("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:3000/callback"], token_endpoint_auth_method: "none" }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  });

  it("dynamic registration accepts built-in hosted and loopback redirect URIs", async () => {
    for (const redirectUri of [
      "https://chatgpt.com/connector/oauth/callback_ABC-123",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://claude.ai/api/mcp/auth_callback",
      "http://localhost:1010/callback",
      "http://127.0.0.1:2020/callback",
      "http://[::1]:3030/callback"
    ]) {
      const response = await fetchWorker("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) });
      expect(response.status, redirectUri).toBe(201);
    }
  });

  it("dynamic registration rejects invalid ChatGPT modern redirect URIs", async () => {
    for (const redirectUri of [
      "https://chatgpt.com/connector/oauth/",
      "https://chatgpt.com/connector/oauth/bad.id",
      "https://chatgpt.com/connector/oauth/good/extra",
      "https://chatgpt.com/connector/oauth/good?x=1"
    ]) {
      const response = await fetchWorker("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) });
      expect(response.status, redirectUri).toBe(400);
    }
  });

  it("dynamic registration rejects untrusted redirects by default", async () => {
    for (const redirectUri of [
      "http://evil.example/callback",
      "http://localhost:3000/not-callback",
      "https://example.com/callback",
      "https://chatgpt.evil.example/connector/oauth/callback"
    ]) {
      const response = await fetchWorker("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) });
      expect(response.status, redirectUri).toBe(400);
    }
  });

  it("dynamic registration supports HTTPS-only extra redirect patterns", async () => {
    const testEnv = { ...env, OAUTH_EXTRA_REDIRECT_URI_PATTERNS: "^https://trusted\\.example/client/oauth/callback$" };
    const accepted = await fetchWorker("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://trusted.example/client/oauth/callback"] }) }, testEnv);
    expect(accepted.status).toBe(201);

    const rejectedHttp = await fetchWorker("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://trusted.example/client/oauth/callback"] }) }, { ...env, OAUTH_EXTRA_REDIRECT_URI_PATTERNS: "^http://trusted\\.example/client/oauth/callback$" });
    expect(rejectedHttp.status).toBe(400);
  });

  it("dynamic registration binds redirect URI into the signed client_id", async () => {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const response = await fetchWorker("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) });
    expect(response.status).toBe(201);
    const body = await response.json() as { client_id: string };
    expect(decodeJwt(body.client_id)).toMatchObject({ typ: "oauth-client", redirect_uris: [redirectUri] });
  });

  it("authorize rejects redirect URI different from signed client registration", async () => {
    const clientId = await registerClient("https://chatgpt.com/connector/oauth/registered_id");
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const response = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("https://chatgpt.com/connector/oauth/other_id")}&code_challenge=${challenge}&code_challenge_method=S256`);
    expect(response.status).toBe(400);
  });

  it("authorize GET renders form and hidden original state", async () => {
    const clientId = await registerClient();
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const state = "abc+/%26==";
    const response = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:3555/callback")}&code_challenge=${challenge}&code_challenge_method=S256&state=${encodeURIComponent(state)}`);
    const html = await response.text();
    expect(html).toContain("Paste Copy-as-cURL output here");
    expect(html).toContain("unofficial connector that uses reverse-engineered, undocumented NotebookLM browser APIs");
    expect(html).toContain("Read notebooks, sources, notes, chats, artifacts, and sharing status");
    expect(html).toContain("Change public link sharing");
    expect(html).toContain("ChatGPT or another MCP client can renew short-lived access tokens without returning to this page until this date");
    expect(html).toContain('name="scope" value="notebooklm:read"');
    expect(html).toContain('name="scope_notebooklm_read" checked required');
    expect(html).toContain('name="scope_notebooklm_chat" disabled');
    expect(html).toContain('target="_top"');
    expect(html).toContain(`name="state" value="${state.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
  });

  it("authorize GET pre-checks requested optional scopes", async () => {
    const clientId = await registerClient();
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const scope = "notebooklm:read notebooklm:chat notebooklm:write";
    const response = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:3555/callback")}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent(scope)}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`name="scope" value="${scope}"`);
    expect(html).toContain('name="scope_notebooklm_chat" checked');
    expect(html).toContain('name="scope_notebooklm_write" checked');
    expect(html).toContain('name="scope_notebooklm_delete" disabled');
  });

  it("authorize rejects unknown and duplicate scopes", async () => {
    const clientId = await registerClient();
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const base = `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:3555/callback")}&code_challenge=${challenge}&code_challenge_method=S256`;
    const unknown = await fetchWorker(`${base}&scope=${encodeURIComponent("notebooklm:read notebooklm:admin")}`);
    const duplicate = await fetchWorker(`${base}&scope=${encodeURIComponent("notebooklm:read")}&scope=${encodeURIComponent("notebooklm:chat")}`);
    const missingRead = await fetchWorker(`${base}&scope=${encodeURIComponent("notebooklm:chat")}`);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "invalid_request" });
    expect(duplicate.status).toBe(400);
    expect(missingRead.status).toBe(400);
  });

  it("authorize rejects an unexpected resource", async () => {
    const clientId = await registerClient();
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const response = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:3555/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent("http://localhost:8787/not-mcp")}`);
    expect(response.status).toBe(400);
  });

  it("authorize POST rejects bad or missing artifact", async () => {
    const response = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({}) });
    expect(response.status).toBe(400);
  });

  it("authorize POST rejects duplicate security parameters", async () => {
    const clientId = await registerClient();
    const redirectUri = "http://127.0.0.1:3555/callback";
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const body = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", csrf, artifact: `curl 'https://notebooklm.google.com' -H 'cookie: ${sampleCookie}'`, ttl_preset_days: "30" });
    body.append("client_id", clientId);
    const response = await fetchWorker("/authorize", { method: "POST", body });
    expect(response.status).toBe(400);
  });

  it("authorize POST renders actionable HTML for malformed artifacts", async () => {
    const clientId = await registerClient();
    const redirectUri = "http://127.0.0.1:3555/callback";
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const response = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", csrf, artifact: "https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=wXbhsf", ttl_preset_days: "30" }) });
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("NotebookLM authorization failed");
    expect(html).toContain("Copy as cURL");
  });

  it("authorize GET mentions notebook.google.com rebrand host", async () => {
    const clientId = await registerClient();
    const redirectUri = "http://127.0.0.1:3555/callback";
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const html = await get.text();
    expect(html).toContain("https://notebook.google.com");
    expect(html).toContain("https://notebooklm.google.com");
  });

  it("authorize POST surfaces NotebookLMError stage when live validation fails", async () => {
    const clientId = await registerClient();
    const redirectUri = "http://127.0.0.1:3555/callback";
    const challenge = await pkceS256("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123");
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const { MOCK_NOTEBOOKLM_LIST_JSON: _mock, ...liveEnv } = env;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("no wiz", { status: 200 })) as typeof fetch;
    try {
      const response = await fetchWorker("/authorize", {
        method: "POST",
        body: new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          csrf,
          artifact: `curl 'https://notebook.google.com/_/LabsTailwindUi/data/batchexecute' -H 'cookie: ${sampleCookie}'`,
          ttl_preset_days: "30"
        })
      }, liveEnv);
      const html = await response.text();
      expect(response.status).toBe(400);
      expect(html).toContain("NotebookLM rejected the pasted credentials");
      expect(html).toContain("auth_bootstrap_parse");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("authorize POST redirects with exact original state", async () => {
    const clientId = await registerClient();
    const redirectUri = "http://127.0.0.1:3555/callback";
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
    const challenge = await pkceS256(verifier);
    const state = "state-with-+/=%26";
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=${encodeURIComponent(state)}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const response = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, csrf, artifact: `curl 'https://notebooklm.google.com' -H 'cookie: ${sampleCookie}'`, ttl_preset_days: "30" }) });
    expect(response.status).toBe(200);
    const redirect = /href="([^"]+)"/.exec(await response.text())?.[1]?.replace(/&amp;/g, "&") ?? "";
    expect(new URL(redirect).searchParams.get("state")).toBe(state);
  });

  it("authorize POST returns a stateless auth code carrying the encrypted credential", async () => {
    const redirectUri = "https://chatgpt.com/connector/oauth/test";
    const clientId = await registerClient(redirectUri);
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
    const challenge = await pkceS256(verifier);
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const largeArtifact = `curl 'https://notebooklm.google.com' -H 'cookie: ${"SID=sid-test-value; ".repeat(10)}__Secure-1PSID=psid-test-value; HSID=h'`;
    const auth = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", csrf, artifact: largeArtifact, ttl_preset_days: "30" }) });
    const authHtml = await auth.text();
    const location = /href="([^"]+)"/.exec(authHtml)?.[1]?.replace(/&amp;/g, "&") ?? "";
    const code = new URL(location).searchParams.get("code") ?? "";
    expect(auth.status).toBe(200);
    expect(decodeJwt(code)).toMatchObject({ typ: "ac3", e: { v: 3, z: "deflate-raw" } });
    expect(location.length).toBeLessThan(3500);
    expect(decodeJwt(code)).not.toHaveProperty("credential_ref");

    const token = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }) });
    expect(token.status).toBe(200);
    const tokenBody = await token.json() as Record<string, unknown>;
    expect(typeof tokenBody.access_token).toBe("string");
    expect(typeof tokenBody.refresh_token).toBe("string");
    const replay = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }) });
    expect(replay.status).toBe(200);
  });

  it("token endpoint refreshes access tokens with a stateless refresh token", async () => {
    const redirectUri = "http://127.0.0.1:3555/callback";
    const clientId = await registerClient(redirectUri);
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
    const challenge = await pkceS256(verifier);
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(env.MCP_RESOURCE)}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const auth = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource: env.MCP_RESOURCE, csrf, artifact: `curl 'https://notebooklm.google.com' -H 'cookie: ${sampleCookie}'`, ttl_preset_days: "30" }) });
    const redirect = /href="([^"]+)"/.exec(await auth.text())?.[1]?.replace(/&amp;/g, "&") ?? "";
    const code = new URL(redirect).searchParams.get("code") ?? "";
    const token = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: env.MCP_RESOURCE }) });
    const tokenBody = await token.json() as { refresh_token: string };

    const refreshed = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenBody.refresh_token, client_id: clientId }) });
    const refreshedBody = await refreshed.json() as Record<string, unknown>;

    expect(refreshed.status).toBe(200);
    expect(typeof refreshedBody.access_token).toBe("string");
    expect(typeof refreshedBody.refresh_token).toBe("string");
    expect(refreshedBody.expires_in).toBe(3600);
    expect(decodeJwt(String(refreshedBody.access_token))).toMatchObject({ typ: "access-token", aud: env.MCP_AUDIENCE });
    expect(decodeJwt(String(refreshedBody.refresh_token))).toMatchObject({ typ: "refresh-token", aud: env.OAUTH_ISSUER });
  });

  it("refresh exchange bakes rotated upstream cookies into the credential envelope", async () => {
    const { clientId, tokenBody } = await authorizeAndExchange("notebooklm:read");
    const noMockEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("MOCK_")));
    const bootstrapHtml = `<!doctype html><script>{"SNlM0e":"csrf","FdrFJe":"sid"}</script>`;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      const headers = new Headers();
      if (url.endsWith("/")) {
        headers.append("set-cookie", "__Secure-1PSIDTS=rotated-ts; Expires=Thu, 01 Jan 2032 00:00:00 GMT; Path=/; Secure; HttpOnly");
        headers.append("set-cookie", "SIDCC=rotated-sidcc; Path=/");
        headers.append("set-cookie", "unrelated_tracker=x; Path=/");
        return new Response(bootstrapHtml, { headers });
      }
      return new Response(buildNotebookLMRpcResponse("wXbhsf", [[["nb-1", "Notebook 1"]]]));
    });
    try {
      const refreshed = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenBody.refresh_token, client_id: clientId }) }, noMockEnv);
      expect(refreshed.status).toBe(200);
      const refreshedBody = await refreshed.json() as { refresh_token: string };
      const claims = decodeJwt(refreshedBody.refresh_token) as { credential: Parameters<typeof decryptEnvelope>[0] };
      const envelope = await decryptEnvelope(claims.credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
      expect(envelope.cookieHeader).toContain("__Secure-1PSIDTS=rotated-ts");
      expect(envelope.cookieHeader).toContain("SIDCC=rotated-sidcc");
      expect(envelope.cookieHeader).toContain("SID=sid-test-value");
      expect(envelope.cookieHeader).not.toContain("unrelated_tracker");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refresh exchange keeps the previous envelope when upstream is unreachable", async () => {
    const { clientId, tokenBody } = await authorizeAndExchange("notebooklm:read");
    const noMockEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("MOCK_")));
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    try {
      const refreshed = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenBody.refresh_token, client_id: clientId }) }, noMockEnv);
      expect(refreshed.status).toBe(200);
      const refreshedBody = await refreshed.json() as { refresh_token: string };
      const claims = decodeJwt(refreshedBody.refresh_token) as { credential: Parameters<typeof decryptEnvelope>[0] };
      const envelope = await decryptEnvelope(claims.credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
      expect(envelope.cookieHeader).toContain("SID=sid-test-value");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("token exchange returns selected scope and embeds it in access and refresh JWTs", async () => {
    const { token, tokenBody } = await authorizeAndExchange("notebooklm:read notebooklm:chat notebooklm:write", "notebooklm:read notebooklm:chat");
    expect(token.status).toBe(200);
    expect(tokenBody.scope).toBe("notebooklm:read notebooklm:chat");
    expect(decodeJwt(tokenBody.access_token)).toMatchObject({ typ: "access-token", scope: "notebooklm:read notebooklm:chat" });
    expect(decodeJwt(tokenBody.refresh_token)).toMatchObject({ typ: "refresh-token", scope: "notebooklm:read notebooklm:chat" });
  });

  it("refresh exchange preserves the exact original scope snapshot", async () => {
    const { clientId, tokenBody } = await authorizeAndExchange("notebooklm:read notebooklm:write notebooklm:delete", "notebooklm:read notebooklm:write");
    const refreshed = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenBody.refresh_token, client_id: clientId }) });
    const refreshedBody = await refreshed.json() as { access_token: string; refresh_token: string; scope: string };
    expect(refreshed.status).toBe(200);
    expect(refreshedBody.scope).toBe("notebooklm:read notebooklm:write");
    expect(decodeJwt(refreshedBody.access_token)).toMatchObject({ scope: "notebooklm:read notebooklm:write" });
    expect(decodeJwt(refreshedBody.refresh_token)).toMatchObject({ scope: "notebooklm:read notebooklm:write" });
  });

  it("authorize POST rejects CSRF scope tampering", async () => {
    const redirectUri = "http://127.0.0.1:3555/callback";
    const clientId = await registerClient(redirectUri);
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
    const challenge = await pkceS256(verifier);
    const requestedScope = "notebooklm:read notebooklm:write";
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent(requestedScope)}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const tampered = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope: "notebooklm:read", csrf, artifact: `curl 'https://notebooklm.google.com' -H 'cookie: ${sampleCookie}'`, ttl_preset_days: "30" }) });
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toEqual({ error: "invalid_request" });
  });

  it("no-scope legacy access and refresh tokens are rejected", async () => {
    const credential = await encryptEnvelope({ format: "notebooklm-mcp-gateway/notebooklm-auth/v1", source: "raw-cookie-header", baseUrl: "https://notebooklm.google.com", cookieHeader: sampleCookie, createdAt: new Date().toISOString() }, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
    const legacyAccess = await signJwt({ typ: "access-token", client_id: "legacy-client", connector_expires_at: new Date(Date.now() + 60_000).toISOString(), credential }, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.MCP_AUDIENCE, 300);
    const legacyRefresh = await signJwt({ typ: "refresh-token", client_id: "legacy-client", connector_expires_at: new Date(Date.now() + 60_000).toISOString(), credential }, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, 300);
    const mcp = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${legacyAccess}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    const refresh = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: legacyRefresh, client_id: "legacy-client" }) });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toEqual({ error: "invalid_request" });
  });

  it("token endpoint rejects authorization_code requests with a wrong resource", async () => {
    const redirectUri = "http://127.0.0.1:3555/callback";
    const clientId = await registerClient(redirectUri);
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
    const challenge = await pkceS256(verifier);
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const auth = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", csrf, artifact: `curl 'https://notebooklm.google.com' -H 'cookie: ${sampleCookie}'`, ttl_preset_days: "30" }) });
    const redirect = /href="([^"]+)"/.exec(await auth.text())?.[1]?.replace(/&amp;/g, "&") ?? "";
    const code = new URL(redirect).searchParams.get("code") ?? "";
    const rejected = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: "http://localhost:8787/not-mcp" }) });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "invalid_grant" });
  });

  it("token endpoint rejects duplicate parameters", async () => {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "not-a-token", client_id: "client" });
    body.append("client_id", "client");
    const response = await fetchWorker("/token", { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("request body limits reject oversized registration payloads before parsing", async () => {
    const response = await fetchWorker("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:3000/callback"], padding: "x".repeat(70_000) }) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
  });

  it("token endpoint rejects refresh tokens for a different client", async () => {
    const redirectUri = "http://127.0.0.1:3555/callback";
    const clientId = await registerClient(redirectUri);
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
    const challenge = await pkceS256(verifier);
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const auth = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", csrf, artifact: `curl 'https://notebooklm.google.com' -H 'cookie: ${sampleCookie}'`, ttl_preset_days: "30" }) });
    const redirect = /href="([^"]+)"/.exec(await auth.text())?.[1]?.replace(/&amp;/g, "&") ?? "";
    const code = new URL(redirect).searchParams.get("code") ?? "";
    const token = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }) });
    const tokenBody = await token.json() as { refresh_token: string };

    const rejected = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenBody.refresh_token, client_id: "other-client" }) });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "invalid_grant" });
  });

  it("token endpoint validates PKCE", async () => {
    const clientId = await registerClient();
    const redirectUri = "http://127.0.0.1:3555/callback";
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
    const challenge = await pkceS256(verifier);
    const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await get.text())?.[1] ?? "";
    const auth = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", csrf, artifact: `curl 'https://notebooklm.google.com' -H 'cookie: ${sampleCookie}'`, ttl_preset_days: "30" }) });
    const authHtml = await auth.text();
    const redirect = /href="([^"]+)"/.exec(authHtml)?.[1]?.replace(/&amp;/g, "&") ?? "";
    const code = new URL(redirect).searchParams.get("code") ?? "";
    const bad = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: `${verifier}bad` }) });
    expect(bad.status).toBe(400);
    const good = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }) });
    expect(good.status).toBe(200);
  });

  it("invalid or expired auth code is rejected", async () => {
    const expired = await new SignJWT({ typ: "auth-code", client_id: "client", redirect_uri: "http://127.0.0.1/cb", code_challenge: "a".repeat(43), connector_ttl_days: 30, credential: { v: 1, iv: "a", ciphertext: "b" } })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(env.OAUTH_ISSUER!)
      .setAudience(env.OAUTH_ISSUER!)
      .setIssuedAt()
      .setExpirationTime("-1s")
      .sign(base64ToBytes(env.OAUTH_JWT_SIGNING_KEY_B64!));
    const response = await fetchWorker("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: expired, redirect_uri: "http://127.0.0.1/cb", client_id: "client", code_verifier: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123" }) });
    expect(response.status).toBe(400);
  });
});
