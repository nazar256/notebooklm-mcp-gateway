import { z } from "zod";
import type { Env } from "./config";
import { AuthArtifactError, parseCookieHeader, parseNotebookLMAuthArtifact } from "./authArtifact";
import { accessTokenClaimsSchema, authCodeClaimsSchema, clientClaimsSchema, csrfClaimsSchema, decryptEnvelope, encryptEnvelope, pkceS256, refreshTokenClaimsSchema, sha256Base64Url, signJwt, verifyJwt, type EncryptedEnvelope } from "./crypto";
import { parseUniqueUrlEncoded, readTextWithLimit } from "./http";
import { NotebookLMClient, NotebookLMError } from "./notebooklm";
import { loadSessionEnvelope, persistSessionEnvelope, seedSessionEnvelope } from "./sessionStore";
import { baselineScope, formatScopes, grantScopesFromConsent, notebookLmScopes, parseGrantedScopes, parseRequestedScopes, scopeLabels, type NotebookLMScope } from "./scopes";

const REGISTER_MAX_BYTES = 64_000;
const AUTHORIZE_POST_MAX_BYTES = 1_000_000;
const TOKEN_MAX_BYTES = 64_000;

const registerSchema = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.literal("none").optional()
}).passthrough();

const authorizeSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43),
  code_challenge_method: z.literal("S256"),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
  state: z.string().optional()
});

const authorizePostSchema = authorizeSchema.extend({
  artifact: z.string().min(1).max(200_000),
  ttl_preset_days: z.string().optional(),
  ttl_custom_days: z.string().optional(),
  csrf: z.string().min(1),
  scope_notebooklm_read: z.literal("on").optional(),
  scope_notebooklm_chat: z.literal("on").optional(),
  scope_notebooklm_write: z.literal("on").optional(),
  scope_notebooklm_delete: z.literal("on").optional(),
  scope_notebooklm_share: z.literal("on").optional()
});

const authorizationCodeTokenSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  client_id: z.string().min(1),
  code_verifier: z.string().min(43),
  resource: z.string().url().optional()
});

const refreshTokenSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
  resource: z.string().url().optional()
});

const tokenSchema = z.discriminatedUnion("grant_type", [authorizationCodeTokenSchema, refreshTokenSchema]);

export async function metadata(env: Env): Promise<Response> {
  return json({
    issuer: env.OAUTH_ISSUER,
    authorization_endpoint: `${env.OAUTH_ISSUER}/authorize`,
    token_endpoint: `${env.OAUTH_ISSUER}/token`,
    registration_endpoint: `${env.OAUTH_ISSUER}/register`,
    token_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: notebookLmScopes,
    resource_parameter_supported: true
  });
}

export function protectedResourceMetadata(env: Env): Response {
  return json({
    resource: env.MCP_RESOURCE,
    authorization_servers: [env.OAUTH_ISSUER],
    bearer_methods_supported: ["header"],
    resource_name: "NotebookLM MCP Gateway"
  });
}

export async function register(request: Request, env: Env): Promise<Response> {
  const body = registerSchema.parse(JSON.parse(await readTextWithLimit(request, REGISTER_MAX_BYTES)));
  for (const redirectUri of body.redirect_uris) validateRedirectUri(redirectUri, env);
  const clientId = await signJwt({ typ: "oauth-client", redirect_uris: body.redirect_uris, client_name: body.client_name }, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, 365 * 24 * 60 * 60);
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  }, 201);
}

export async function authorizeGet(request: Request, env: Env): Promise<Response> {
  const params = parseAuthorizeParams(new URL(request.url).searchParams);
  const requestedScopes = parseRequestedScopes(params.scope);
  validateResource(params.resource, env);
  await validateClient(params, env);
  const normalizedParams = { ...params, scope: formatScopes(requestedScopes) };
  const csrf = await signJwt({ typ: "csrf", ...normalizedParams }, env.CSRF_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, 600);
  return html(renderAuthorizePage(normalizedParams, requestedScopes, csrf));
}

export async function authorizePost(request: Request, env: Env): Promise<Response> {
  const parsed = authorizePostSchema.parse(parseUniqueUrlEncoded(await readTextWithLimit(request, AUTHORIZE_POST_MAX_BYTES)));
  const requestedScopes = parseRequestedScopes(parsed.scope);
  const grantedScope = formatScopes(grantScopesFromConsent(requestedScopes, selectedScopes(parsed)));
  validateResource(parsed.resource, env);
  const csrfClaims = await verifyJwt(parsed.csrf, env.CSRF_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, csrfClaimsSchema);
  if (csrfClaims.client_id !== parsed.client_id || csrfClaims.redirect_uri !== parsed.redirect_uri || csrfClaims.response_type !== parsed.response_type || csrfClaims.code_challenge !== parsed.code_challenge || csrfClaims.code_challenge_method !== parsed.code_challenge_method || csrfClaims.scope !== formatScopes(requestedScopes) || csrfClaims.resource !== parsed.resource || csrfClaims.state !== parsed.state) {
    throw new Error("invalid_request");
  }
  await validateClient(parsed, env);
  const ttlDays = parseTtlDays(parsed, env);
  let envelope: ReturnType<typeof parseNotebookLMAuthArtifact>;
  try {
    envelope = parseNotebookLMAuthArtifact(parsed.artifact);
  } catch (error) {
    if (error instanceof AuthArtifactError) return html(renderAuthorizeErrorPage(error.message), 400);
    throw error;
  }
  const validationError = await validateNotebookLMCredentials(envelope, env);
  if (validationError) return html(renderAuthorizeErrorPage(validationError), 400);
  const credential = await encryptEnvelope(envelope, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
  const codePayload = { typ: "ac3", c: await sha256Base64Url(parsed.client_id), r: await sha256Base64Url(parsed.redirect_uri), p: parsed.code_challenge, s: grantedScope, d: ttlDays, e: credential };
  const code = await signJwt(codePayload, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, env.AUTH_CODE_TTL_SECONDS);
  const redirect = new URL(parsed.redirect_uri);
  redirect.searchParams.set("code", code);
  if (parsed.state !== undefined) redirect.searchParams.set("state", parsed.state);
  return redirectAfterPost(redirect.toString());
}

export async function token(request: Request, env: Env): Promise<Response> {
  const parsed = tokenSchema.parse(parseUniqueUrlEncoded(await readTextWithLimit(request, TOKEN_MAX_BYTES)));

  if (parsed.grant_type === "refresh_token") {
    validateTokenResource(parsed.resource, env);
    const claims = await verifyJwt(parsed.refresh_token, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, refreshTokenClaimsSchema);
    if (claims.client_id !== parsed.client_id) throw new Error("invalid_grant");
    const ttlSeconds = secondsUntil(claims.connector_expires_at);
    if (ttlSeconds <= 0) throw new Error("invalid_grant");
    const credential = await refreshCredentialCookies(claims.credential, env);
    const tokenPayload = { typ: "access-token", client_id: claims.client_id, scope: claims.scope, connector_expires_at: claims.connector_expires_at, credential };
    const accessToken = await signJwt(tokenPayload, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.MCP_AUDIENCE, env.ACCESS_TOKEN_TTL_SECONDS);
    const refreshToken = await signJwt({ ...tokenPayload, typ: "refresh-token" }, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, ttlSeconds);
    return json({ access_token: accessToken, token_type: "Bearer", expires_in: env.ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope: claims.scope });
  }

  validateTokenResource(parsed.resource, env);
  const code = await verifyJwt(parsed.code, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, authCodeClaimsSchema);
  if ("client_id" in code) {
    if (code.client_id !== parsed.client_id || code.redirect_uri !== parsed.redirect_uri) throw new Error("invalid_grant");
  } else if (code.c !== await sha256Base64Url(parsed.client_id) || code.r !== await sha256Base64Url(parsed.redirect_uri)) {
    throw new Error("invalid_grant");
  }
  const challenge = await pkceS256(parsed.code_verifier);
  if (challenge !== ("code_challenge" in code ? code.code_challenge : code.p)) throw new Error("invalid_grant");
  const credential = resolveAuthCodeCredential(code);
  try {
    // Seed the session store at connect time so the cron keep-alive covers
    // this credential even before its first tool call or refresh exchange.
    await seedSessionEnvelope(env, await decryptEnvelope(credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64), credential);
  } catch {
    // Seeding is best-effort; token issuance must not fail over KV.
  }
  const ttlDays = "connector_ttl_days" in code ? code.connector_ttl_days : code.d;
  const scope = "scope" in code ? code.scope : code.s;
  const connectorExpiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const tokenPayload = { typ: "access-token", client_id: parsed.client_id, scope, connector_expires_at: connectorExpiresAt, credential };
  const accessToken = await signJwt(tokenPayload, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.MCP_AUDIENCE, env.ACCESS_TOKEN_TTL_SECONDS);
  const refreshToken = await signJwt({ ...tokenPayload, typ: "refresh-token" }, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, ttlDays * 24 * 60 * 60);
  return json({ access_token: accessToken, token_type: "Bearer", expires_in: env.ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope });
}

export async function authenticateMcp(request: Request, env: Env) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return null;
  const claims = await verifyJwt(match[1], env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.MCP_AUDIENCE, accessTokenClaimsSchema);
  if (Date.parse(claims.connector_expires_at) <= Date.now()) throw new Error("expired_connector");
  const envelope = await decryptEnvelope(claims.credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
  // The KV session store is authoritative for the rotating cookie jar; the
  // token-carried envelope is only the fallback snapshot.
  const stored = await loadSessionEnvelope(env, envelope.credId);
  return { envelope: stored ? { ...envelope, cookieHeader: stored.cookieHeader } : envelope, scopes: parseGrantedScopes(claims.scope) };
}

export function mcpChallenge(env: Env, error?: "invalid_token"): Response {
  const challenge = [`Bearer resource_metadata="${env.OAUTH_ISSUER}/.well-known/oauth-protected-resource/mcp"`];
  if (error) challenge.push(`error="${error}"`);
  return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": challenge.join(", ") } });
}

function parseAuthorizeParams(searchParams: URLSearchParams) {
  for (const key of ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "resource", "state"]) {
    if (searchParams.getAll(key).length > 1) throw new Error("invalid_request");
  }
  return authorizeSchema.parse(Object.fromEntries(searchParams.entries()));
}

async function validateClient(params: { client_id: string; redirect_uri: string }, env: Env): Promise<void> {
  const client = await verifyJwt(params.client_id, env.OAUTH_JWT_SIGNING_KEY_B64, env.OAUTH_ISSUER, env.OAUTH_ISSUER, clientClaimsSchema);
  if (!client.redirect_uris.includes(params.redirect_uri)) throw new Error("invalid_redirect_uri");
  validateRedirectUri(params.redirect_uri, env);
}

function validateRedirectUri(redirectUri: string, env: Env): void {
  const url = new URL(redirectUri);
  if (isBuiltInRedirectUri(url)) return;
  if (url.protocol === "https:" && matchesExtraRedirectPattern(redirectUri, env)) return;
  throw new Error("invalid_redirect_uri");
}

function validateResource(resource: string | undefined, env: Env): void {
  if (resource !== undefined && resource !== env.MCP_RESOURCE) throw new Error("invalid_request");
}

function validateTokenResource(resource: string | undefined, env: Env): void {
  if (resource !== undefined && resource !== env.MCP_RESOURCE) throw new Error("invalid_grant");
}

function isBuiltInRedirectUri(url: URL): boolean {
  if (url.protocol === "https:") return isChatGptModernRedirect(url) || isExactHttpsRedirect(url, "chatgpt.com", "/connector_platform_oauth_redirect") || isExactHttpsRedirect(url, "claude.ai", "/api/mcp/auth_callback");
  if (url.protocol === "http:") return isLoopbackRedirect(url);
  return false;
}

function isChatGptModernRedirect(url: URL): boolean {
  if (url.hostname !== "chatgpt.com" || url.search || url.hash) return false;
  return /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname);
}

function isExactHttpsRedirect(url: URL, host: string, pathname: string): boolean {
  return url.hostname === host && url.pathname === pathname && !url.search && !url.hash;
}

function isLoopbackRedirect(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) && url.pathname === "/callback" && !url.search && !url.hash;
}

function matchesExtraRedirectPattern(redirectUri: string, env: Env): boolean {
  const patterns = env.OAUTH_EXTRA_REDIRECT_URI_PATTERNS?.split(",").map((pattern) => pattern.trim()).filter(Boolean) ?? [];
  if (patterns.length > 20) throw new Error("invalid_redirect_uri");
  return patterns.some((pattern) => {
    if (pattern.length > 500) throw new Error("invalid_redirect_uri");
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw new Error("invalid_redirect_uri");
    }
    return regex.test(redirectUri);
  });
}

function parseTtlDays(parsed: z.infer<typeof authorizePostSchema>, env: Env): number {
  const raw = parsed.ttl_custom_days?.trim() || parsed.ttl_preset_days || "30";
  const days = z.coerce.number().int().min(1).max(env.CONNECTOR_TTL_MAX_DAYS).parse(raw);
  return days;
}

function selectedScopes(parsed: z.infer<typeof authorizePostSchema>): NotebookLMScope[] {
  const selected: NotebookLMScope[] = [baselineScope];
  if (parsed.scope_notebooklm_chat === "on") selected.push("notebooklm:chat");
  if (parsed.scope_notebooklm_write === "on") selected.push("notebooklm:write");
  if (parsed.scope_notebooklm_delete === "on") selected.push("notebooklm:delete");
  if (parsed.scope_notebooklm_share === "on") selected.push("notebooklm:share");
  return selected;
}

function resolveAuthCodeCredential(code: z.infer<typeof authCodeClaimsSchema>) {
  if ("credential" in code && code.credential) return code.credential;
  if ("e" in code && code.e) return code.e;
  throw new Error("invalid_grant");
}

function secondsUntil(isoDate: string): number {
  const expiresAt = Date.parse(isoDate);
  if (Number.isNaN(expiresAt)) return 0;
  return Math.ceil((expiresAt - Date.now()) / 1000);
}

// Google rotates NotebookLM session cookies via Set-Cookie on upstream responses,
// so the pasted snapshot goes stale within days. Each refresh-token exchange is a
// chance to ping NotebookLM, harvest the rotated cookies, and bake them into the
// re-encrypted credential envelope carried by the new tokens. Best effort only: on
// any failure the previous envelope is reused so token rotation never breaks.
async function refreshCredentialCookies(credential: EncryptedEnvelope, env: Env): Promise<EncryptedEnvelope> {
  if (env.MOCK_NOTEBOOKLM_LIST_JSON) return credential;
  try {
    const envelope = await decryptEnvelope(credential, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
    // Seed the ping from the shared jar — it may be newer than the snapshot
    // inside this refresh token, and persisting an older jar would regress it.
    const stored = await loadSessionEnvelope(env, envelope.credId);
    const safeFetch: typeof fetch = (input, init) => fetch(input, init);
    const seedHeader = stored?.cookieHeader ?? envelope.cookieHeader;
    const client = new NotebookLMClient({ baseUrl: envelope.baseUrl, cookieHeader: seedHeader, sessionId: envelope.sessionId, csrfToken: envelope.csrfToken, validationRpcId: envelope.validationRpcId, validationFReq: envelope.validationFReq, fetch: safeFetch });
    const ping = await client.refreshCookies();
    const cookieHeader = client.getCookieHeader();
    console.log("NotebookLM credential refresh", {
      ping,
      credId: envelope.credId,
      cookieDiff: sanitizeCookieDiff(envelope.cookieHeader, cookieHeader)
    });
    if (ping === "alive") {
      // Persist the rotated jar into the shared session store so subsequent
      // calls pick it up without waiting for the next token exchange.
      await persistSessionEnvelope(env, envelope, client, seedHeader);
    }
    if (!cookieHeader || cookieHeader === envelope.cookieHeader) return credential;
    return await encryptEnvelope({ ...envelope, cookieHeader }, env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64);
  } catch (error) {
    console.warn("NotebookLM credential refresh failed", { error: error instanceof Error ? error.name : "unknown" });
    return credential;
  }
}

// Names-only diff of two cookie headers — never log cookie values.
function sanitizeCookieDiff(before: string, after: string): { updated: string[]; deleted: string[]; added: string[] } {
  const oldCookies = parseCookieHeader(before);
  const newCookies = parseCookieHeader(after);
  const updated: string[] = [];
  const deleted: string[] = [];
  const added: string[] = [];
  for (const [name, value] of newCookies) {
    if (!oldCookies.has(name)) added.push(name);
    else if (oldCookies.get(name) !== value) updated.push(name);
  }
  for (const name of oldCookies.keys()) if (!newCookies.has(name)) deleted.push(name);
  return { updated, deleted, added };
}

async function validateNotebookLMCredentials(envelope: ReturnType<typeof parseNotebookLMAuthArtifact>, env: Env): Promise<string | null> {
  if (env.MOCK_NOTEBOOKLM_LIST_JSON) {
    z.array(z.object({ id: z.string(), title: z.string() })).parse(JSON.parse(env.MOCK_NOTEBOOKLM_LIST_JSON));
    return null;
  }
  const safeFetch: typeof fetch = (input, init) => fetch(input, init);
  const client = new NotebookLMClient({ baseUrl: envelope.baseUrl, cookieHeader: envelope.cookieHeader, sessionId: envelope.sessionId, csrfToken: envelope.csrfToken, validationRpcId: envelope.validationRpcId, validationFReq: envelope.validationFReq, fetch: safeFetch });
  try {
    await client.validateAuthentication();
    return null;
  } catch (error) {
    const stage = error instanceof NotebookLMError ? ` (${error.stage})` : "";
    return `NotebookLM rejected the pasted credentials${stage}. Open NotebookLM in the same browser, confirm you are signed in, then copy a fresh batchexecute request with Copy as cURL.`;
  }
}

function renderAuthorizeErrorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NotebookLM authorization failed</title></head><body><main><h1>NotebookLM authorization failed</h1><p>${escapeHtml(message)}</p><p>Go back, paste a fresh artifact, and try Authorize again.</p></main></body></html>`;
}

function renderAuthorizePage(params: z.infer<typeof authorizeSchema> & { scope: string }, requestedScopes: NotebookLMScope[], csrf: string): string {
  const requested = new Set(requestedScopes);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect NotebookLM</title></head><body><main><h1>How to connect NotebookLM</h1><section aria-label="Important security notice"><h2>Important security notice</h2><p>This is an unofficial connector that uses reverse-engineered, undocumented NotebookLM browser APIs. It is not affiliated with or supported by Google or NotebookLM.</p><p>Only continue if you trust the operator of this Worker. The pasted browser request contains account session material. This connector will only expose the NotebookLM tools allowed by the scopes you grant below, but the issued token still contains encrypted browser session material and must be protected as sensitive.</p></section><ol><li>Open https://notebooklm.google.com (or https://notebook.google.com if your account redirects there — Gemini Notebook rebrand) in the browser where you are logged in.</li><li>Open DevTools.</li><li>Go to the Network tab.</li><li>Type batchexecute into the Network filter.</li><li>Open or click any NotebookLM notebook until a batchexecute request appears.</li><li>Right-click the batchexecute request on the host shown in the address bar.</li><li>Choose Copy → Copy as cURL.</li><li>Paste the full cURL command below.</li></ol><p><strong>Important: choose “Copy as cURL”, not “Copy as URL”.</strong></p><form method="post" action="/authorize" target="_top"><label for="artifact">Paste Copy-as-cURL output here</label><br><textarea id="artifact" name="artifact" rows="12" cols="80" required></textarea><p><small>Advanced: this field also accepts a raw Cookie header value or notebooklm-py storage_state.json.</small></p><fieldset><legend>NotebookLM access</legend>${notebookLmScopes.map((scope) => renderScopeCheckbox(scope, requested.has(scope))).join("")}</fieldset><fieldset><legend>Connector expiration</legend><label><input type="radio" name="ttl_preset_days" value="30" checked> 30 days</label><label><input type="radio" name="ttl_preset_days" value="90"> 90 days</label><label><input type="radio" name="ttl_preset_days" value="365"> 365 days</label><label>Custom days <input type="number" min="1" name="ttl_custom_days"></label><p><small>The selected expiration is the connector grant lifetime: ChatGPT or another MCP client can renew short-lived access tokens without returning to this page until this date, unless your Google/NotebookLM browser session expires earlier.</small></p></fieldset>${hidden("response_type", params.response_type)}${hidden("client_id", params.client_id)}${hidden("redirect_uri", params.redirect_uri)}${hidden("code_challenge", params.code_challenge)}${hidden("code_challenge_method", params.code_challenge_method)}${hidden("scope", params.scope)}${params.resource ? hidden("resource", params.resource) : ""}${params.state !== undefined ? hidden("state", params.state) : ""}${hidden("csrf", csrf)}<button type="submit">Authorize NotebookLM connector</button></form></main></body></html>`;
}

function renderScopeCheckbox(scope: NotebookLMScope, requested: boolean): string {
  const label = scopeLabels[scope];
  const name = `scope_${scope.replace(":", "_")}`;
  const checked = requested ? " checked" : "";
  const readonlyBaseline = scope === baselineScope ? " checked required onclick=\"return false\"" : "";
  const disabled = scope !== baselineScope && !requested ? " disabled" : "";
  const note = scope === baselineScope ? " Required baseline scope." : requested ? " You can deselect this optional scope." : " Not requested by this client.";
  return `<label><input type="checkbox" name="${escapeHtml(name)}"${scope === baselineScope ? readonlyBaseline : `${checked}${disabled}`}> <strong>${escapeHtml(label.title)}</strong> <code>${escapeHtml(scope)}</code><br><small>${escapeHtml(label.description)}${escapeHtml(note)}</small></label><br>`;
}

function redirectAfterPost(location: string): Response {
  const escaped = escapeHtml(location);
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization complete</title></head><body><main><p>Authorization complete. Continuing to ChatGPT…</p><p>If you are not redirected automatically, <a id="continue" href="${escaped}" target="_top" rel="noreferrer">continue to ChatGPT</a>.</p><script>window.top.location.replace(${JSON.stringify(location)});</script></main></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'",
      "referrer-policy": "no-referrer"
    }
  });
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html;charset=UTF-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
}
