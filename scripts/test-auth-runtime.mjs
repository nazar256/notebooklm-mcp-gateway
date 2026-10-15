import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

// Real Worker + SQLite Durable Object + OAuth/MCP, offline Google fixture.
// No real credentials. All outbound traffic is handled by outboundService.
const scratch = await mkdtemp(join(tmpdir(), "notebooklm-auth-runtime-"));
const bundle = await build({ entryPoints: [resolve("src/index.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
const seen = [];
let rotations = 0, rpcReads = 0, mutations = 0, rejectNextRead = false, active = 0, maximumActive = 0;
const html = '<script>{"SNlM0e":"csrf","FdrFJe":"session"}</script>';
const rpc = (id, payload, status = null) => ")]}'\n" + JSON.stringify([["wrb.fr", id, payload === null ? null : JSON.stringify(payload), null, null, status, "generic"]]);
const outboundService = async request => {
  active++; maximumActive = Math.max(active, maximumActive);
  try {
    await new Promise(resolve => setTimeout(resolve, 5));
    const url = new URL(request.url), cookie = request.headers.get("cookie") ?? "";
    seen.push({ host: url.hostname, path: url.pathname, cookie });
    if (url.pathname === "/RotateCookies") {
      rotations++;
      return new Response('[["identity.hfcr",600]]', { headers: { "set-cookie": "__Secure-1PSIDTS=runtime-rotation; Domain=.google.com; Path=/; Secure; HttpOnly" } });
    }
    if (url.hostname === "notebooklm.google.com" && url.pathname === "/") {
      if (cookie.includes("OSID=runtime-binding")) return new Response(html);
      return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/ServiceLogin" } });
    }
    if (url.hostname === "accounts.google.com") {
      assert(!cookie.includes("OSID="), "app-only binding leaked to accounts");
      if (url.pathname === "/ServiceLogin") return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/SetOSID", "set-cookie": "LSID=runtime-bridge; Path=/; Secure; HttpOnly" } });
      assert(cookie.includes("LSID=runtime-bridge"), "intermediate cookie was lost");
      return new Response(null, { status: 302, headers: { location: "https://notebooklm.google.com/complete" } });
    }
    assert(!cookie.includes("LSID="), "accounts-only cookie leaked to app");
    if (url.pathname === "/complete") return new Response(html, { headers: { "set-cookie": "OSID=runtime-binding; Path=/; Secure; HttpOnly" } });
    if (url.pathname.endsWith("/batchexecute")) {
      assert(cookie.includes("__Secure-1PSIDTS=runtime-rotation"), "rotation was not routed to the app");
      const body = new URLSearchParams(await request.text());
      const id = JSON.parse(body.get("f.req"))[0][0][0];
      if (id === "wXbhsf") {
        rpcReads++;
        if (rejectNextRead) { rejectNextRead = false; return new Response(rpc(id, null, [16])); }
        return new Response(rpc(id, [[]]));
      }
      if (id === "CCqFvf") { mutations++; return new Response(rpc(id, null)); }
    }
    throw new Error("Unexpected fixture route");
  } finally { active--; }
};
const bindings = {
  OAUTH_JWT_SIGNING_KEY_B64: Buffer.alloc(32, 1).toString("base64"),
  NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64: Buffer.alloc(32, 2).toString("base64"),
  CSRF_SIGNING_KEY_B64: Buffer.alloc(32, 3).toString("base64"),
  OAUTH_ISSUER: "http://localhost", MCP_RESOURCE: "http://localhost/mcp", MCP_AUDIENCE: "http://localhost/mcp",
  ACCESS_TOKEN_TTL_SECONDS: "3600", AUTH_CODE_TTL_SECONDS: "300", CONNECTOR_TTL_MAX_DAYS: "365"
};
const options = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-05-03", bindings, outboundService,
  durableObjects: { NOTEBOOKLM_SESSIONS: { className: "NotebookLMSession", useSQLite: true } },
  durableObjectsPersist: join(scratch, "objects"), log: new Log(LogLevel.ERROR) };
let mf;
let runtimeLogs = "";
options.handleRuntimeStdio = (stdout, stderr) => {
  stdout.on("data", chunk => { runtimeLogs += chunk.toString(); });
  stderr.on("data", chunk => { runtimeLogs += chunk.toString(); });
};
try {
  mf = new Miniflare(options);
  const call = (path, init) => mf.dispatchFetch(`http://localhost${path}`, init);
  const redirectUri = "http://127.0.0.1:3555/callback";
  const registration = await (await call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) })).json();
  const verifier = "runtime-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", scope: "notebooklm:read notebooklm:write" });
  const page = await (await call(`/authorize?${params}`)).text();
  params.set("csrf", /name="csrf" value="([^"]+)"/.exec(page)[1]);
  params.set("scope_notebooklm_write", "on"); params.set("ttl_preset_days", "30");
  params.set("artifact", "curl 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute' -b 'SID=runtime-session; APISID=a; SAPISID=b; OSID=old-binding'");
  const authorization = await call("/authorize", { method: "POST", body: params });
  const authorizationHtml = await authorization.text();
  assert.equal(authorization.status, 200, authorizationHtml);
  const callback = /href="([^"]+)"/.exec(authorizationHtml)[1].replaceAll("&amp;", "&");
  const code = new URL(callback).searchParams.get("code");
  const tokenResponse = await call("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: registration.client_id, code_verifier: verifier }) });
  assert.equal(tokenResponse.status, 200);
  let tokens = await tokenResponse.json();
  const tool = async (name, args = {}) => {
    const response = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  assert.equal((await tool("list_notebooks")).isError, undefined);
  for (const secret of ["runtime-session", "runtime-rotation", "runtime-bridge", "runtime-binding", tokens.access_token, tokens.refresh_token]) assert(!runtimeLogs.includes(secret), "runtime logs exposed credential data");
  rejectNextRead = true;
  assert.equal((await tool("list_notebooks")).isError, undefined);
  const beforeStatus = seen.length;
  const status = (await tool("get_auth_status")).structuredContent.diagnostics;
  assert.equal(seen.length, beforeStatus, "diagnostics unexpectedly contacted Google");
  assert.equal(status.counters.recovery_successes, 1);
  assert.equal(status.inventory.lsid, true);
  assert.equal(rotations, 1, "rotation throttle did not span requests");
  const mutationFailure = await tool("create_notebook", { title: "fixture" });
  assert.equal(mutationFailure.isError, true);
  assert(mutationFailure.content[0].text.includes("Inspect NotebookLM before retrying"), "ambiguous write did not warn against blind client retries");
  assert.equal(mutations, 1, "ambiguous mutation was replayed");
  await Promise.all([tool("list_notebooks"), tool("list_notebooks"), tool("list_notebooks")]);
  assert.equal(maximumActive, 1, "session operations overlapped across awaits");
  await mf.dispose();
  mf = new Miniflare(options);
  assert.equal((await tool("list_notebooks")).isError, undefined, "persisted session did not survive runtime restart");
  assert.equal(rotations, 1, "restart lost the durable rotation throttle");
  const refreshed = await call("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: registration.client_id }) });
  assert.equal(refreshed.status, 200); tokens = await refreshed.json();
  assert.equal((await tool("list_notebooks")).isError, undefined);
  assert(runtimeLogs.includes("notebooklm_auth"), "runtime telemetry was not captured");
  for (const secret of ["runtime-session", "runtime-rotation", "runtime-bridge", "runtime-binding", tokens.access_token, tokens.refresh_token]) assert(!runtimeLogs.includes(secret), "runtime logs exposed credential data");
  console.log(JSON.stringify({ result: "passed", runtime: "workerd", storage: "sqlite-durable-object", checks: ["OAuth connect and refresh", "intermediate redirect cookies", "cookie domain isolation", "rotation persistence and throttle", "bounded RPC recovery", "no mutation replay", "concurrent requests serialized", "runtime restart", "secret-free auth status"], rotations, rpcReads, mutations, maximumConcurrentGoogleRequests: maximumActive }));
} finally {
  await mf?.dispose();
  await rm(scratch, { recursive: true, force: true });
}
