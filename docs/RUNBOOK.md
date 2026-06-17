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

1. Open NotebookLM in a browser where you are signed in.
2. Open DevTools and the Network tab.
3. Filter for `batchexecute`.
4. Open or click a NotebookLM notebook until a `batchexecute` request appears.
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

Before deploying, set exact Worker URLs in `wrangler.jsonc`:

```text
OAUTH_ISSUER=https://<your-worker-host>
MCP_RESOURCE=https://<your-worker-host>/mcp
MCP_AUDIENCE=https://<your-worker-host>/mcp
```

Initialize secrets through stdin only:

```bash
openssl rand -base64 48 | wrangler secret put OAUTH_JWT_SIGNING_KEY_B64
openssl rand -base64 32 | wrangler secret put NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64
openssl rand -base64 48 | wrangler secret put CSRF_SIGNING_KEY_B64
```

Run checks and deploy:

```bash
npm run check
npx wrangler deploy
```

If Wrangler requires a first deploy before secrets can be created, deploy once only with placeholder URLs and no real users, set secrets immediately, update `wrangler.jsonc` to the exact deployed Worker URL, then deploy again before connecting MCP clients.

## Troubleshooting

- `invalid_artifact`: the pasted value was malformed or looked like Copy-as-URL instead of Copy-as-cURL.
- NotebookLM credential rejection during OAuth: open NotebookLM in the same browser, confirm you are signed in, and copy a fresh `batchexecute` request.
- MCP tool error at `auth_bootstrap_http` or `auth_bootstrap_parse`: the stored browser session is stale or NotebookLM returned an unexpected sign-in/interstitial page.
- MCP tool error at `upstream_http` or `upstream_parse`: the private NotebookLM RPC may have changed or the specific notebook/source/artifact ID may be invalid.
- Old MCP profiles can hold expired access tokens. Re-run OAuth if refresh fails.

When reporting a bug, include sanitized request shapes, tool names, status codes, trace IDs, and reproduction steps. Do not include cookies, tokens, private notebook data, or raw upstream bodies.
