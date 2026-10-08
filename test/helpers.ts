import { pkceS256 } from "../src/crypto";
import worker from "../src/index";

export const env = {
  OAUTH_JWT_SIGNING_KEY_B64: b64("oauth-signing-key-that-is-long-enough-for-hs256-tests"),
  NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64: b64Bytes(32),
  CSRF_SIGNING_KEY_B64: b64("csrf-signing-key-that-is-long-enough-for-hs256-tests"),
  OAUTH_ISSUER: "http://localhost:8787",
  MCP_RESOURCE: "http://localhost:8787/mcp",
  MCP_AUDIENCE: "http://localhost:8787/mcp",
  ACCESS_TOKEN_TTL_SECONDS: "3600",
  AUTH_CODE_TTL_SECONDS: "300",
  CONNECTOR_TTL_MAX_DAYS: "365",
  MOCK_NOTEBOOKLM_LIST_JSON: JSON.stringify([{ id: "nb-1", title: "Notebook One" }]),
  MOCK_NOTEBOOKLM_RENAME_JSON: JSON.stringify({ id: "nb-1", title: "Renamed Notebook" }),
  MOCK_NOTEBOOKLM_DELETE_JSON: JSON.stringify({ deleted: true, notebookId: "nb-1" })
} satisfies Record<string, unknown>;

export const sampleCookie = "SID=sid-test-value; __Secure-1PSID=psid-test-value; HSID=h";

export function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

export function b64Bytes(length: number): string {
  return Buffer.alloc(length, 7).toString("base64");
}

export function fakeKv(store = new Map<string, string>()): KVNamespace {
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async (options?: { prefix?: string; cursor?: string }) => ({
      keys: [...store.keys()].filter((name) => !options?.prefix || name.startsWith(options.prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: ""
    })
  } as unknown as KVNamespace;
}

export function fakeCtx(): ExecutionContext & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {}
  } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
}

export async function fetchWorker(path: string, init?: RequestInit, testEnv: Record<string, unknown> = env, ctx?: ExecutionContext): Promise<Response> {
  return worker.fetch(new Request(`http://localhost:8787${path}`, init), testEnv, ctx);
}

export async function registerClient(redirectUri = "http://127.0.0.1:3555/callback"): Promise<string> {
  const response = await fetchWorker("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })
  });
  const body = await response.json() as { client_id: string };
  return body.client_id;
}

export async function issueAccessToken(scope = "notebooklm:read notebooklm:chat notebooklm:write notebooklm:delete notebooklm:share"): Promise<string> {
  const redirectUri = "http://127.0.0.1:3555/callback";
  const clientId = await registerClient(redirectUri);
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~123";
  const challenge = await pkceS256(verifier);
  const state = "exact-state-+/=%26";
  const get = await fetchWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent(scope)}&resource=${encodeURIComponent(String(env.MCP_RESOURCE))}&state=${encodeURIComponent(state)}`);
  const html = await get.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    resource: String(env.MCP_RESOURCE),
    state,
    csrf,
    artifact: `curl 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute' -H 'cookie: ${sampleCookie}'`,
    ttl_preset_days: "30"
  });
  for (const grantedScope of scope.split(/\s+/).filter(Boolean)) {
    if (grantedScope !== "notebooklm:read") form.set(`scope_${grantedScope.replace(":", "_")}`, "on");
  }
  const post = await fetchWorker("/authorize", { method: "POST", body: form });
  const postHtml = await post.text();
  const location = post.headers.get("location") ?? /href="([^"]+)"/.exec(postHtml)?.[1]?.replace(/&amp;/g, "&");
  if (!location) throw new Error("missing redirect");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("missing code");
  const token = await fetchWorker("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: String(env.MCP_RESOURCE) })
  });
  const tokenBody = await token.json() as { access_token: string };
  return tokenBody.access_token;
}
