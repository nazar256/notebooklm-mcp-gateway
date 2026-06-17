# Architecture

## Runtime model

The gateway is a Cloudflare Worker that exposes:

- OAuth metadata and protected-resource metadata;
- Dynamic Client Registration;
- OAuth Authorization Code + PKCE;
- a bearer-protected Streamable HTTP MCP endpoint at `/mcp`.

The Worker is stateless. It creates a request-local MCP server/transport for every authenticated MCP request and does not depend on KV, Durable Objects, D1, R2, cache, or filesystem storage.

## Authentication flow

1. The MCP client discovers OAuth metadata from the Worker.
2. The client dynamically registers a public OAuth client.
3. The user opens `/authorize` and pastes a fresh NotebookLM Copy-as-cURL artifact from a live `batchexecute` request.
4. The Worker parses and minimally validates the artifact against NotebookLM.
5. The Worker encrypts a compact NotebookLM credential envelope and returns a signed authorization code.
6. The client exchanges the code with PKCE for a short-lived MCP access token and a stateless refresh token.
7. MCP tool calls decrypt the envelope from the access token and call NotebookLM's browser endpoints.

The current OAuth grant is coarse-grained: once connected, the client can request any MCP tool exposed by this Worker. Tool-level safety is enforced with input schemas and explicit confirmations for destructive or sharing-changing operations, not with per-tool OAuth scopes.

## Stateless tradeoffs

Keeping auth artifacts inside signed JWTs avoids server-side credential persistence, but it means:

- auth codes cannot be marked as used;
- refresh-token replay cannot be detected;
- revocation is limited to secret rotation or upstream Google/NotebookLM session invalidation;
- callback URLs must stay compact enough for real OAuth clients.

The implementation deliberately compacts large OAuth-bound values and returns a small HTML success page after authorization so browser clients do not depend on very long `303 Location` redirects.

## NotebookLM API boundary

NotebookLM calls are reverse-engineered from browser RPC traffic and public unofficial projects. The code normalizes only the fields used by the MCP contract and treats upstream response shapes as unstable.

Failures are returned as sanitized MCP tool errors with a coarse failure stage and trace ID. Cookies, raw upstream bodies, JWTs, decrypted envelopes, and Authorization headers are not returned to clients.

Stable tool outputs intentionally omit raw upstream response blobs. If upstream shape debugging is needed, reproduce locally with sanitized logs rather than returning private NotebookLM payloads through MCP.
