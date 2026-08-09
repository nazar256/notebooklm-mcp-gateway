# NotebookLM MCP Gateway

Unofficial TypeScript Cloudflare Worker that exposes a remote Streamable HTTP MCP gateway for NotebookLM.

The gateway lets an MCP client complete OAuth against the Worker, paste a fresh NotebookLM browser request artifact during authorization, and then call NotebookLM through MCP tools. The Worker is intentionally stateless: NotebookLM browser credentials are encrypted into signed OAuth/MCP token artifacts and are not stored in KV, Durable Objects, D1, R2, cache, or the filesystem.

## Important disclaimer

This project uses reverse-engineered, undocumented NotebookLM/Google browser APIs.

- It is **not affiliated with, endorsed by, or supported by Google, NotebookLM, OpenAI, Anthropic, or Cloudflare**.
- NotebookLM internal endpoints, RPC IDs, payload shapes, authentication requirements, quotas, and product behavior may change without notice.
- The MCP tools may break, return partial data, or behave differently across account tiers, regions, languages, and future NotebookLM releases.
- Users paste browser authentication material into the OAuth page. Only self-host this Worker, or use deployments operated by someone you explicitly trust.
- This is best treated as experimental software for personal projects, prototypes, and research automation. There are no stability, availability, or data-loss guarantees.

See [SECURITY.md](SECURITY.md) before deploying or connecting real accounts.

## Features

- Remote MCP endpoint at `/mcp` using Streamable HTTP.
- OAuth Authorization Code + PKCE for public clients.
- Dynamic Client Registration at `POST /register`.
- Short-lived MCP bearer access tokens and stateless refresh tokens bounded by the selected connector expiration.
- Encrypted NotebookLM credential envelopes inside signed OAuth artifacts.
- Supports consumer hosts `notebooklm.google.com` and `notebook.google.com` (Gemini Notebook redirect), plus `notebooklm.cloud.google.com`.
- Server-enforced OAuth/MCP scopes so users can grant read-only or selected chat/write/delete/share capabilities at consent time.
- Zod-backed MCP input/output schemas and `structuredContent` on successful tool calls.
- Sanitized MCP tool errors and tool outputs that avoid exposing cookies, Authorization headers, JWTs, or raw upstream response bodies.
- Explicit guards for destructive or permission-changing tools.

## Tools

The current MCP tool surface covers notebooks, sources, chat, notes, Studio artifacts, research, and sharing:

```text
list_notebooks, get_notebook, create_notebook, rename_notebook, delete_notebook,
list_sources, add_url_source, add_youtube_source, add_text_source, add_drive_source,
get_source_guide, get_source_content, refresh_source, delete_source,
ask_notebook, get_last_conversation_id, get_conversation_turns,
list_notes, create_note, update_note, delete_note,
list_artifacts, generate_artifact, download_artifact,
start_research, poll_research, import_research_sources,
get_share_status, set_share_public
```

See [docs/TOOLS.md](docs/TOOLS.md) for read/write/destructive markers and known limitations.

## OAuth and MCP scopes

OAuth consent is least-privilege by default. If the client omits `scope` or sends it blank, the Worker grants only `notebooklm:read`. Unknown scopes or duplicate `scope` parameters are rejected with `400 invalid_request`.

Supported scopes:

- `notebooklm:read` — required baseline; read notebooks, sources, notes, chats, artifacts, and sharing status.
- `notebooklm:chat` — ask questions, start research, and generate Studio artifacts.
- `notebooklm:write` — create/edit notebooks, sources, notes, refresh sources, and import research sources.
- `notebooklm:delete` — delete notebooks, sources, and notes.
- `notebooklm:share` — change public link sharing.

The authorization page renders human-readable scope checkboxes. Optional scopes requested by the client are pre-checked and can be deselected before granting. Auth codes, access tokens, and refresh tokens carry the granted scope snapshot; refresh-token exchange preserves that exact snapshot and cannot widen access. `/token` responses include the granted `scope` string. MCP `tools/list` only advertises tools allowed by the token scopes, and direct calls to ungranted tools fail without invoking NotebookLM.

## Limitations

- NotebookLM APIs are private and can break without warning.
- Browser file upload is not implemented; safe Worker proxying needs additional size, streaming, and trust-boundary work.
- Binary artifact downloads are not proxied. `download_artifact` requests export metadata/URLs where available.
- Stateless auth codes and refresh tokens cannot be server-side revoked or replay-detected before JWT expiry.
- OAuth/MCP scopes are capability-level only. Object-level authorization still relies on the pasted NotebookLM browser session and upstream NotebookLM permissions.
- Fine-grained user permission management is intentionally limited; only public/private link sharing is exposed through `notebooklm:share`.

## Local development

```bash
npm ci
npm run dev
npm test
npm run typecheck
```

`npm run dev` uses dummy local-only signing/encryption values and localhost OAuth issuer/resource/audience overrides. Never reuse those values in a deployed Worker.

## Deployment overview

Production deploys via GitHub Actions on push to `main` (or manual **workflow_dispatch**): test/typecheck, then Cloudflare Workers deploy. Configure a `production` GitHub Environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Missing Worker secrets are initialized on first deploy; existing secrets are not rotated.

`wrangler.jsonc` already points `OAUTH_ISSUER` / `MCP_RESOURCE` / `MCP_AUDIENCE` at `https://notebooklm-mcp-gateway.xyofn8h7t.workers.dev`. Keep those URLs exact after any host change.

Optional local deploy:

```bash
npm run check
npx wrangler deploy
```

Do not store real secrets, browser cookies, Copy-as-cURL artifacts, or MCP/OAuth tokens in `.env`, `.dev.vars`, docs, logs, or git.

## OAuth redirect policy

Dynamic Client Registration and `/authorize` enforce a narrow redirect allowlist:

- `https://chatgpt.com/connector/oauth/{callback_id}` where `{callback_id}` matches `[A-Za-z0-9_-]+`
- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://claude.ai/api/mcp/auth_callback`
- loopback `http://localhost:{port}/callback`, `http://127.0.0.1:{port}/callback`, and `http://[::1]:{port}/callback`

Optional `OAUTH_EXTRA_REDIRECT_URI_PATTERNS` can add tested HTTPS clients. It cannot allow arbitrary non-loopback HTTP redirects.

## Credits and prior art

This gateway was built with protocol and UX inspiration from:

- [`teng-lin/notebooklm-py`](https://github.com/teng-lin/notebooklm-py) — comprehensive unofficial NotebookLM Python API/CLI/MCP project.
- [`jacob-bd/notebooklm-mcp-cli`](https://github.com/jacob-bd/notebooklm-mcp-cli) — unofficial NotebookLM CLI and MCP server.

Those projects are independent; credit here does not imply endorsement or shared maintainership.

## License

MIT. See [LICENSE](LICENSE).
