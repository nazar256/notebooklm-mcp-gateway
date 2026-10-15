# Browser authentication port

Reference: [notebooklm-py v0.8.5](https://github.com/teng-lin/notebooklm-py/tree/v0.8.5), the user's working CLI version. This is a TypeScript port of its cookie-session behavior into the existing Cloudflare OAuth/MCP workflow. No user CLI installation, Python service, Docker host or master-token bootstrap is required by this implementation.

## Source and scope

| Reference | Gateway implementation |
| --- | --- |
| `_auth/cookie_policy.py`, `cookies.py`, cookie semantics | `cookies.ts`: domain/path identities, scope/expiry, complete export import, secondary-binding diagnostics |
| `_auth/psidts_recovery.py`, `keepalive.py`, `mint_service.py` | `NotebookLMClient.rotateCookies`: exact RotateCookies POST, recovery without PSIDTS when other bindings remain, durable 60-second attempt throttle |
| `_auth/refresh.py` | fresh bootstrap, account route, explicit cookie-aware redirect chain, /login probe for a tokenless app shell |
| `_web/transport/session_auth.py`, `executor.py` | bounded auth refresh/retry, distinction between permission, unauthenticated, null result and transport failure |
| file locks and snapshot/CAS persistence | `SessionCoordinator`: queue entire network operation and await encrypted Durable Object persistence |

The login acquisition mechanism differs: upstream headed login captures complete browser storage; the primary gateway flow accepts a request header snapshot. Browser recovery, operator refresh commands, Android and master-token rungs are not implemented. Diagnostics explicitly report unavailable capabilities. They are not silently emulated or claimed as equivalent.

## What cURL can and cannot contain

A Cookie request header contains name/value pairs for one destination, without original Domain, Path, expiration, Secure or HttpOnly attributes. It normally omits accounts-only LSID. The gateway infers known shared Google cookies, app-scoped OSID, and accounts-scoped identity names; unknown names remain scoped to the copied app host. Inferred rows remain visible as a count in diagnostics. Conflicting same-name authentication values are rejected as ambiguous rather than choosing an account silently.

A complete storage export preserves domain/path/expiry and same-name rows on different hosts. Only approved app/identity domains are imported. Real Set-Cookie values carry authoritative attributes and update the matching identity. Domain/path-specific deletion never deletes another identity with the same name.

Never promise that missing source credentials can be reconstructed. Google may mint new cookies from the remaining credentials; the service attempts supported recovery and records the result. A new Python runtime would not manufacture absent account credentials or device-bound signing keys either.

## Session ownership

One HMAC-derived Google-session owner coordinates all connectors importing the same SID-family identity. This prevents independent connectors on the gateway from rotating copies concurrently. It does not coordinate with the user's external browser or another external service using that session.

The authoritative envelope is AES-GCM encrypted in a SQLite-backed Durable Object. A per-owner queue spans reads, Google requests, and awaited persistence. The rotation attempt is committed before contacting Google, and a successful rotation is checkpointed before the next upstream request. `pending` with `rotation_attempt` or `rotation_checkpoint` means the final operation outcome has not been committed yet. Errors do not delete the jar. Accepted rotation and redirect-bridge cookies survive a later RPC failure. HTTP rejection, final sign-in cookies and malformed RPC response cookies do not replace accepted state.

A reconnect validates the newly pasted artifact. If it fails without receiving an accepted rotation, the previous owner's encrypted jar is retained. If Google did mint an update, retain it even when validation subsequently fails: restoring an older jar could lose a server-side session advance. Neither behavior changes the account route of existing connector grants.

Accepted Set-Cookie headers are harvested before reading the response body. A body timeout can therefore report a failed rotation request while still retaining and checkpointing its received cookie update. The `psidtsChanged` flag compares values, so an inferred-to-authoritative metadata update alone does not claim a new PSIDTS value.

Existing envelopes are accepted. Before its first active operation, an owner without state can import the previous encrypted KV entry. Once initialized, the owner ignores stale token and KV cookie snapshots. Read/decrypt/storage failure is reported explicitly and does not cause fallback to a potentially obsolete credential. Legacy envelopes without cookie metadata acquire inferred rows, not invented original attributes.

The owner retains a durable rotation-attempt timestamp, counters and last outcome across runtime eviction/restart. Expiration alarms clean inactive state. OAuth grant expiry and Google-session health remain separate.

## Request/recovery contract

Requests use manual redirects. At each approved HTTPS hop the service rebuilds the destination's cookie header, collects accepted Set-Cookie, strips cross-origin application/authorization headers, and applies redirect method semantics. External destinations and cross-origin 307/308 body replay are blocked. CookieMismatch is recognized before a support-page redirect hides it. HTTP timeouts include response-body consumption: 15 seconds for rotation, 30 for bootstrap/RPC and 180 for chat. The invocation has a 240-second aggregate network budget to bound owner queue occupancy. This is a bounded whole-response window; upstream's chat read timeout is an idle-read window, so arbitrarily long active streams are not claimed equivalent.

Fresh bootstrap honors authuser/account selection. Copied f.sid/at and arbitrary copied f.req are neither retained in new credentials nor used for recovery; old envelopes discard these fields when promoted to the session owner. This also prevents a copied notebook request body from inflating OAuth credentials. A tokenless app shell is checked through /login to distinguish sign-out from changed markup, and probe failures retain their own permission/challenge/HTTP classification. Chat obtains bootstrap tokens after conversation lookup and recovery, immediately before sending the prompt.

Recovery has one budget per tool invocation. A read can retry after explicit authentication rejection or an ambiguous null result. A mutation can retry its rejected RPC after explicit HTTP 401/UNAUTHENTICATED, or recover before submission when bootstrap failed. It is not replayed after an ambiguous null, HTML response, network failure or timeout. A multi-step tool is never restarted as a whole. A chat prompt is sent once after bootstrap recovery.

403, RPC permission denial, CookieMismatch and interactive challenges are distinct from session expiration. Auth code 16 means the current request was unauthenticated; it does not establish that all stored credentials are permanently unrecoverable.

## Diagnostics

`get_auth_status` requires `notebooklm:read` and does not contact Google. Its state is the last checked outcome, not a new live readiness probe. It returns the last health/reason/rotation, last trace/import/attempt/success times, the original seed and caller credential sources, cookie-presence and inferred-metadata counts, supported capabilities, and cumulative counters.

JSON log messages use `component: notebooklm_auth`, an operation trace ID and a truncated keyed session ID. Events are `import`, `rotation`, `http`, `recovery`, `storage`, `operation`. HTTP events contain a phase, allowlisted Google hostname, fixed route category, sent-cookie presence flags, hop, status and duration. The operation summary includes persisted version and counters:

- `rotation_attempts`, `rotation_updates`, `rotation_psidts_updates`, `rotation_failures`;
- `recovery_attempts`, `recovery_successes`, `redirect_hops`;
- `successful_operations`, `failed_operations`, typed `failure_*` counts;
- `persistence_failures` on the failed operation's log summary (a failed store cannot reliably persist this counter).

No cookie value, full URL/query, provider challenge, notebook ID/text, account email or OAuth token is logged. Cookie inventory is a fixed set of presence flags, not arbitrary upstream cookie names. A storage failure can occur after a mutation executed: inspect its trace and current upstream state before retrying.

| Evidence | Interpretation / next action |
| --- | --- |
| rotation 200 with cookie updates, then successful RPC | supported renewal succeeded for this sample; continue the idle/concurrency check |
| rotation `unchanged` | Google returned success without a jar change; not proof that freshness increased |
| missing rotation binding, inferred metadata, missing secondary binding | input may be insufficient; compare with a complete export before requiring a different auth method |
| rotation 401 + explicit device-bound challenge, recovery exhausted | this session requested a capability absent from the worker; this does not prove every cURL-created session requires a master token |
| plain rotation rejection followed by a successful RPC | rotation refusal alone is not an authentication outage |
| `google_login` after bounded recovery | reauthentication is required by the observed path; distinguish revocation/policy from incomplete input with a controlled comparison |
| 403 / permission denial / cookie mismatch | inspect account selection, permissions and policy; do not claim a generic cookie-expiry cause |
| owner unavailable, read/decrypt/persistence error | storage/rollout problem, not evidence against cURL authentication |
| missing WIZ fields without a sign-in result | possible protocol/markup change; do not recommend master-token migration from this signal alone |

## Deployment and acceptance

The existing deploy workflow now tests the actual Worker/DO runtime. Wrangler applies the `NOTEBOOKLM_SESSIONS` binding and `auth-sessions-v1` SQLite migration. Keep the KV binding for existing users. This uses Workers-managed services with free-plan quotas; no free-capacity or CPU-budget guarantee is inferred from local tests. Check account quotas and deployment output before release. A rollback to the old KV implementation can regress already-rotated sessions and is not a transparent rollback.

Before claiming the production fix, perform these read-only checks with an authorized real session:

1. Connect using the existing cURL form. Record trace/session IDs, presence flags, initial rotation result and a successful list. Retain no raw credential in logs or tickets.
2. Exercise multiple concurrent read calls and OAuth refresh. Verify one owner, persisted versions, bounded rotation attempts and no stale-snapshot regression.
3. Verify a later call after normal runtime eviction/restart. Local fixture coverage already checks this with real SQLite-backed workerd storage.
4. Leave the connector idle for at least 24 hours, then call list and inspect recovery. Continue for 48–72 hours if the intended reliability criterion spans several days. Do not use a cron to conceal idle behavior.
5. If recovery fails, inspect the actual provider signals. Test an independently logged-in browser session for the same account to separate a revoked/shared session from account policy. If needed, compare a cURL snapshot and a full export in isolated sessions; never actively rotate copies of one session from competing consumers.
6. Only attribute failure to missing credentials or an unavailable device-bound capability when the trace shows it after the supported recovery path. Document the session/account/provider scope and failed rungs. Failure of one session cannot establish universal impossibility of cURL auth or necessity of a master token.

The automated Google fixtures establish transport, persistence and retry behavior. They do not establish live session longevity, corporate SSO policy, Google egress risk checks, or the outcome of a device-bound challenge.
