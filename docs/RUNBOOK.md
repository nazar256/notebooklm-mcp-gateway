# Runbook

## Local development

Install dependencies and run checks:

```bash
npm ci
npm run check
```

Start the local Worker:

```bash
npm run dev
```

`npm run dev` binds dummy local-only secrets and localhost OAuth URLs. Do not copy those values into a deployment.

Basic local probes:

```bash
curl -i http://localhost:8787/health
curl http://localhost:8787/.well-known/oauth-authorization-server
curl -i http://localhost:8787/mcp
```

## Creating a local NotebookLM auth artifact

1. Open NotebookLM in a browser where you are signed in. Start at `https://notebooklm.google.com`; some accounts redirect to `https://notebook.google.com` (Gemini Notebook rebrand) — stay on whichever host the address bar shows.
2. Open DevTools and the Network tab.
3. Filter for `batchexecute`.
4. Open or click a NotebookLM notebook until a `batchexecute` request appears on that host.
5. Right-click the request and choose **Copy → Copy as cURL**.
6. Paste it only into the gateway's OAuth authorization form.

Do not commit, upload, log, or paste Copy-as-cURL output anywhere else. Do not store it in the repository root. If a temporary local file is unavoidable, keep it under ignored `.tmp/` and remove it when finished.

## MCP client smoke test

The exact client commands depend on the MCP client you use. A typical validation sequence is:

1. Complete OAuth against `http://localhost:8787/mcp`.
2. List available tools.
3. Call `list_notebooks` first.
4. Use only a clearly disposable notebook for mutation/destructive tests.
5. For delete/share operations, pass the required confirmation fields.

Example destructive guard shape:

```json
{
  "notebookId": "<disposable-notebook-id>",
  "confirm": true,
  "expectedTitle": "<exact current title>"
}
```

## Deployment

Production deploys run from GitHub Actions (`.github/workflows/deploy.yml`) on push to `main` or via **workflow_dispatch**. The workflow runs tests/typecheck, bootstraps the Worker if missing, initializes any missing Worker secrets, then runs `npx wrangler deploy`.

### One-time GitHub setup

1. Create a GitHub Environment named `production` on this repository.
2. Add these environment secrets (same values as your other Cloudflare MCP gateways if scoped to the same account):
   - `CLOUDFLARE_API_TOKEN` — Edit Cloudflare Workers token
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id

### Worker URLs

`wrangler.jsonc` must use the exact deployed host:

```text
OAUTH_ISSUER=https://notebooklm-mcp-gateway.xyofn8h7t.workers.dev
MCP_RESOURCE=https://notebooklm-mcp-gateway.xyofn8h7t.workers.dev/mcp
MCP_AUDIENCE=https://notebooklm-mcp-gateway.xyofn8h7t.workers.dev/mcp
```

### Worker secrets

On first deploy, Actions generates any missing secrets automatically:

- `OAUTH_JWT_SIGNING_KEY_B64`
- `NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64`
- `CSRF_SIGNING_KEY_B64`

Existing secrets are left unchanged. To set or rotate manually:

```bash
openssl rand -base64 32 | wrangler secret put OAUTH_JWT_SIGNING_KEY_B64
openssl rand -base64 32 | wrangler secret put NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64
openssl rand -base64 32 | wrangler secret put CSRF_SIGNING_KEY_B64
```

### Manual local deploy (optional)

```bash
npm run check
npx wrangler deploy
```

## Troubleshooting

- `invalid_artifact`: the pasted value was malformed or looked like Copy-as-URL instead of Copy-as-cURL.
- NotebookLM credential rejection during OAuth: open NotebookLM in the same browser (including on `notebook.google.com` if redirected there), confirm you are signed in, and copy a fresh `batchexecute` request. The error page may include a failure stage such as `auth_bootstrap_parse` or `upstream_http`.
- MCP tool error at `auth_bootstrap_http` or `auth_bootstrap_parse`: the stored browser session is stale or NotebookLM returned an unexpected sign-in/interstitial page.
- MCP tool error at `upstream_http` or `upstream_parse`: the private NotebookLM RPC may have changed or the specific notebook/source/artifact ID may be invalid.
- Old MCP profiles can hold expired access tokens. Re-run OAuth if refresh fails.

When reporting a bug, include sanitized request shapes, tool names, status codes, trace IDs, and reproduction steps. Do not include cookies, tokens, private notebook data, or raw upstream bodies.

## Authentication troubleshooting

Call `get_auth_status` first. It does not contact Google or expose credentials.
Inspect `state`, `reason`, `rotation`, `counters`, `inventory`, and last success.
The token grant can still be valid while Google-session recovery is exhausted.

- `auth_expired`: Google sign-in or explicit UNAUTHENTICATED after bounded recovery.
- `auth_challenge`: an interactive Google challenge.
- `access_denied`: HTTP 403, RPC permission denial, or an access gate; not proof of session expiry.
- `cookie_mismatch`: Google rejected cookie/account context on a bridge.
- `auth_bootstrap_parse`: missing fresh WIZ fields after the /login probe.
- `upstream_null`: a required RPC has no result; inspect `rpcStatus` and account route.
- `upstream_redirect`: a blocked external redirect or exhausted hop budget.
- `upstream_timeout`: connection/response body exceeded the bounded request deadline.
- `session_store`: storage/binding failure. An upstream mutation may already have
  completed; do not blindly retry it.

## Session owner deployment and migration

`wrangler.jsonc` declares the `NOTEBOOKLM_SESSIONS` binding and the
`auth-sessions-v1` SQLite Durable Object migration. Normal Wrangler deployment
applies both. This uses Cloudflare-managed storage, with Workers Free quotas;
there is no container or external server. `SESSION_STORE_MODE` defaults to
`durable-object` and production fails closed without its owner binding.

Keep `NOTEBOOKLM_SESSION_KV` and its existing namespace while old OAuth tokens
migrate. The existing deploy workflow resolves that namespace as before. New
operations never write KV. Do not remove the binding or roll back to a KV-only
build while active sessions have rotated only in Durable Objects.

There is no keep-alive cron. Active tool calls/refresh exchanges rotate lazily,
with a persisted 60-second attempt guard. This does not guarantee survival of
an idle, revoked, device-bound, or policy-expired session. The inactivity alarm
cleans session storage after the configured maximum connector lifetime.

Run `npm run check` and `npm run test:runtime` before deployment. The runtime
check needs a loopback socket and uses no real Google credentials. The unit
suite's explicit `memory` mode is not a production fallback.

## Logs and evidence

Search Worker/Durable Object log message text for `notebooklm_auth`, then
correlate the `session` and `traceId` values inside the JSON message. Events cover
`import`, `rotation`, `http`, `recovery`, `storage`, and `operation`.
Only fixed route categories, status codes, counts and presence flags are logged;
there are no raw URLs/query strings, cookie values, challenges or notebook text.
See [AUTHENTICATION.md](AUTHENTICATION.md) for the diagnostic decision table,
controlled comparison and idle/concurrency acceptance procedure.
