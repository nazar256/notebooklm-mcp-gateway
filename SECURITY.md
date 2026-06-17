# Security

## Trust boundary

This project is an unofficial gateway for a reverse-engineered NotebookLM browser API. Users authorize the gateway by pasting browser authentication material from an active NotebookLM session. Treat that material like a password for the affected Google/NotebookLM account.

Use only a Worker deployment that you operate yourself or a deployment run by someone you explicitly trust.

## Sensitive material

Never commit, upload, log, or paste into issues:

- Copy-as-cURL output from NotebookLM requests;
- raw Cookie headers;
- browser `storage_state.json` files;
- OAuth authorization codes, access tokens, or refresh tokens;
- Wrangler secrets or environment files;
- raw upstream NotebookLM response bodies that may contain private notebook data.

The repository ignores common local artifact names, including `curl_request.sh`, `*.cookie`, `cookie.txt`, `*.auth.json`, `.env`, `.dev.vars`, `.wrangler/`, and `.tmp/`.

## Credential model

The Worker does not store NotebookLM credentials in KV, Durable Objects, D1, R2, cache, or the filesystem. Instead, it encrypts a compact credential envelope into signed JWT artifacts.

This keeps deployment simple and stateless, but it has important consequences:

- authorization codes are replayable until their short expiration;
- refresh tokens cannot be revoked or replay-detected server-side before expiration;
- OAuth/MCP scopes limit which tools this Worker exposes to a token, but every issued token still contains encrypted NotebookLM browser session material; protect even read-only tokens as sensitive account credentials;
- rotating Worker signing/encryption secrets invalidates existing connector sessions;
- if a user's browser session expires or is revoked by Google, the connector must be reauthorized with a fresh artifact.

## Secret setup and rotation

Generate and pass secrets through stdin. Do not save them to disk.

```bash
openssl rand -base64 48 | wrangler secret put OAUTH_JWT_SIGNING_KEY_B64
openssl rand -base64 32 | wrangler secret put NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64
openssl rand -base64 48 | wrangler secret put CSRF_SIGNING_KEY_B64
```

To rotate secrets, run the same commands again one at a time and redeploy if needed. Existing OAuth codes, access tokens, and refresh tokens will stop working.

## Reporting vulnerabilities

If you find a vulnerability, do not include secrets, cookies, tokens, or private notebook data in a public issue. Open a minimal report with reproduction steps using placeholders, or contact the maintainer privately if the repository publishes a preferred security contact.
