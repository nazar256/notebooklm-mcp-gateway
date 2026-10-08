# Decisions

## ADR-001: Keep the Worker stateless

The gateway does not use KV, Durable Objects, D1, R2, cache, or filesystem storage for NotebookLM credentials or OAuth session state.

This keeps deployment simple and avoids server-side credential persistence. The tradeoff is that authorization codes and refresh tokens cannot be revoked or replay-detected server-side before their JWT expiration.

## ADR-002: Store NotebookLM credentials only as encrypted token envelopes

NotebookLM browser credentials are parsed during OAuth authorization, minimally validated, encrypted with AES-GCM, and embedded in signed JWT artifacts.

The Worker must never log or return the decrypted envelope, raw cookies, Authorization headers, OAuth codes, access tokens, refresh tokens, or raw upstream response bodies.

## ADR-003: Require exact deployment URLs

Production `OAUTH_ISSUER`, `MCP_RESOURCE`, and `MCP_AUDIENCE` are explicit configuration values. They are not inferred from request host headers.

This avoids host-header trust issues and keeps OAuth issuer/audience validation deterministic.

## ADR-004: Enforce a narrow OAuth redirect allowlist

Dynamic Client Registration and `/authorize` validate redirect URIs against built-in ChatGPT, Claude, and loopback callback shapes. Additional hosted clients require explicit HTTPS regex patterns through `OAUTH_EXTRA_REDIRECT_URI_PATTERNS`.

The escape hatch cannot allow arbitrary non-loopback HTTP redirects.

## ADR-005: Keep front-channel OAuth callbacks compact

Some browser OAuth clients can fail or stall when callback URLs are too long. The stateless authorization code avoids duplicated large values and stores compact encrypted-envelope keys.

After `/authorize` POST succeeds, the Worker returns a small HTML page that navigates the top-level window to the callback URL and includes a fallback link. This is more robust than relying only on a long `303 Location` header.

## ADR-006: Treat NotebookLM RPCs as unstable

NotebookLM RPC IDs and payload shapes are reverse-engineered and undocumented. The gateway normalizes only the fields required by its MCP schemas and keeps parsers conservative.

When upstream behavior changes, prefer small compatibility fixes backed by tests rather than broad refactors.

## ADR-007: Guard destructive and permission-changing operations

Destructive tools require explicit `confirm: true`. Where practical, tools also verify an expected title before sending the upstream delete/change request.

`delete_notebook` requires exact `expectedTitle`. `delete_source` and `delete_note` can verify optional `expectedTitle`. `set_share_public` requires confirmation because it changes access permissions.

## ADR-008: Do not proxy large binary uploads/downloads yet

Browser file upload and binary artifact streaming are intentionally out of scope. Cloudflare Worker request size, CPU/time limits, trust boundaries, and resumable upload semantics require separate design work before exposing those flows.

## ADR-009: Do not return raw upstream payloads through MCP tools

NotebookLM responses can contain private notebook/source/user data beyond the normalized fields needed by the MCP contract. Public tool outputs therefore omit raw upstream blobs and return stable, schema-bound fields only. Debugging upstream shape changes should happen locally with sanitized traces, not by exposing raw payloads to MCP clients.

## ADR-010: Use a coarse OAuth grant for the first public release

The first public release does not implement per-tool OAuth scopes. Authorization grants access to the full MCP tool surface exposed by the Worker for the pasted NotebookLM browser session. Destructive and permission-changing actions remain guarded by explicit confirmation inputs. If future users need least-privilege consent, add a scoped grant model before widening deployment beyond self-hosted/experimental use.

## ADR-011: Rotate NotebookLM cookies through the refresh-token envelope

Google rotates NotebookLM session cookies (`SIDCC`, `__Secure-*PSIDCC`, `__Secure-*PSIDTS` families) via `Set-Cookie` on upstream responses; a pasted Copy-as-cURL snapshot goes stale within days while the browser session keeps working. To stay within the stateless design (ADR-001), rotated cookies are persisted inside the encrypted credential envelope rather than server-side storage:

- `NotebookLMClient` keeps a per-invocation cookie jar: every upstream response's allowlisted `Set-Cookie` updates are merged and sent on subsequent upstream calls. Expired `Set-Cookie` values (`Max-Age<=0`, past `Expires`) delete jar entries, and sign-in responses never contribute cookies — a dead session cannot leak another account's cookies into the jar.
- On every refresh-token exchange the Worker pings NotebookLM (bootstrap plus a read-only RPC, so batchexecute-level rotations are captured too) and bakes the merged cookie header into the re-encrypted envelope carried by the new access and refresh tokens. Failures reuse the previous envelope so token rotation never breaks.

Sessions can still expire when no refresh happens inside Google's grace window, or when Google invalidates the underlying session. Those cases surface as distinct failure stages (`auth_expired` for sign-in redirects/HTML/401/403, `upstream_null` for required RPC frames with null payloads) instead of a generic `upstream_parse`.

## ADR-012: Shared session jar in Workers KV with a cron keep-alive

ADR-011's stateless jar has a structural gap: the cookie jar lives only inside one invocation, so rotations captured during a call persist only when the MCP client happens to do a refresh-token exchange. Clients that rarely refresh leave every call starting from the stale token snapshot, and idle connectors die within Google's rotation grace window.

To close this, each parsed auth artifact now gets a stable `credId` (UUID) inside its encrypted envelope, and the Worker keeps one authoritative session envelope per credential in Workers KV (`NOTEBOOKLM_SESSION_KV`, keys `cred:<credId>`):

- KV values are the same AES-GCM envelope shape tokens carry — cookies are never stored in plaintext (ADR-002 still holds; only the storage location of ciphertext changed).
- `authenticateMcp` prefers the KV jar's `cookieHeader` over the token snapshot. Every successful tool call persists the rotated jar back via `waitUntil`. Refresh exchanges persist it too.
- `refreshCookies` persists the jar only on a fully successful upstream ping; on any failure the seeded jar is restored so a rejected or half-dead exchange can never poison stored cookies.
- An `auth_expired` result (sign-in redirect, login HTML, 401/403) evicts the KV entry — it is a reliable dead-session signal, and eviction stops further keep-alive churn.
- A `scheduled` trigger (`15 */3 * * *`) replays every stored credential through the same read-only ping, accumulating rotations while clients are idle and evicting expired credentials.

This intentionally relaxes ADR-001: the Worker keeps no OAuth state (tokens are still fully self-contained) but does keep server-side *session* state. Old envelopes without `credId` simply keep working statelessly.
