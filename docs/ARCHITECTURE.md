# Architecture

## Runtime model

The gateway is a Cloudflare Worker that exposes:

- OAuth metadata and protected-resource metadata;
- Dynamic Client Registration;
- OAuth Authorization Code + PKCE;
- a bearer-protected Streamable HTTP MCP endpoint at `/mcp`.

OAuth and MCP are served by the TypeScript Worker. Each Google session has a
SQLite-backed `NotebookLMSession` Durable Object. No external server, Docker,
Python runtime, browser, or CLI is required in the deployment.

## Authentication flow

1. The MCP client discovers metadata and registers its redirect URI.
2. The user grants scopes and pastes Copy-as-cURL (or a browser storage export).
3. The Worker parses cookies/account routing and obtains a keyed session owner ID.
4. The owner serializes import, best-effort rotation, fresh bootstrap, and a known
   read-only authentication probe, then awaits encrypted persistence.
5. The actual updated envelope is encrypted into the signed auth code.
6. PKCE exchange issues access/refresh tokens with the original grant's scopes.
7. Tool calls and OAuth refresh load authoritative owner state, rotate when due,
   perform bounded recovery, and save accepted changes before returning.
8. `get_auth_status` reads safe diagnostics without a Google request.

The owner ID is derived from a domain-separated HMAC of the Google session's
SID-family identity. Copies imported through different connectors coordinate
with one owner; separate Google logins on one account remain separate.
Account routing is grant-specific and is not replaced by another connector's
selected account when loading shared cookie state.

## State and compatibility

The owner queue spans network awaits as well as storage reads/writes. Durable
Objects alone do not serialize asynchronous operations automatically. KV's
read-merge-write behavior is no longer used for active sessions.

Pre-port tokens remain accepted. An uninitialized owner reads the legacy
`cred:<credId>` KV entry once, if available, then becomes authoritative. A failed
read/decrypt never silently downgrades to an older token snapshot. The legacy KV
binding must remain during migration; new production operations do not write it.

OAuth codes and refresh tokens remain self-contained and replayable until JWT
expiry. This work changes Google-session ownership, not OAuth revocation.
Google errors retain the jar and diagnosis rather than evicting it. An inactivity
alarm eventually removes expired session storage.

See [AUTHENTICATION.md](AUTHENTICATION.md) for source mapping, scope inference,
recovery rules, metrics and the boundary of cURL-based authentication.

## NotebookLM API boundary

NotebookLM calls are reverse-engineered from browser RPC traffic and public unofficial projects. The code normalizes only the fields used by the MCP contract and treats upstream response shapes as unstable.

Failures are returned as sanitized MCP tool errors with a coarse failure stage and trace ID. Cookies, raw upstream bodies, JWTs, decrypted envelopes, and Authorization headers are not returned to clients.

Stable tool outputs intentionally omit raw upstream response blobs. If upstream shape debugging is needed, reproduce locally with sanitized logs rather than returning private NotebookLM payloads through MCP.
