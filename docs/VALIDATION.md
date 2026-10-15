# Validation

## Automated checks

Run before publishing or deploying:

```bash
npm test
npm run typecheck
npm run test:runtime
```

The tests cover:

- OAuth metadata, Dynamic Client Registration, redirect validation, state preservation, PKCE, token exchange, and stateless refresh tokens;
- duplicate OAuth parameter rejection, resource validation, request-body limits, and invalid bearer-token challenges;
- auth artifact parsing for Copy-as-cURL (including `notebook.google.com`), raw Cookie headers, and `storage_state.json`;
- safe artifact reporting without cookie-value leakage;
- bootstrap redirect adoption from `notebooklm.google.com` to `notebook.google.com`;
- MCP unauthenticated challenge and authenticated `tools/list`;
- MCP input/output schema advertising and successful `structuredContent` for mocked tools, without raw upstream blobs in stable output schemas;
- destructive tool confirmation requirements;
- sanitized MCP error behavior;
- NotebookLM RPC request-shape builders and parsers using mocked upstream responses.

## Manual validation guidance

Use only disposable notebooks and sources for write/destructive tests. A recommended smoke sequence is:

1. Complete OAuth with a fresh Copy-as-cURL artifact.
2. List tools and confirm the expected tool count.
3. Call `list_notebooks`.
4. Create a disposable notebook.
5. Add a small text source or `https://example.com` URL source.
6. List sources and call one read-only source helper.
7. Optionally start a report/study-guide artifact generation.
8. Delete only the disposable source/notebook with `confirm: true` and title verification where available.

Do not run destructive tools against non-disposable notebooks. Do not make notebooks public unless they contain no sensitive data and the sharing change is intentional.

## Disclosure scan before public release

Before making a repository public, scan for accidental disclosures. At minimum, look for:

- browser cookie names and raw cookie values;
- OAuth/JWT-looking tokens;
- Copy-as-cURL artifacts;
- private Cloudflare account/deployment IDs, API tokens, and non-public Worker hostnames;
- real notebook, source, artifact, or ChatGPT app IDs;
- local machine paths and user names;
- private support/debug transcripts.

Intended public `*.workers.dev` service URLs in `wrangler.jsonc` (OAuth issuer/resource/audience) are expected and not accidental disclosures. Keep secrets and private identifiers out of the tree; use synthetic fixtures in tests.

## Authentication acceptance

Unit tests cover cookie identity/routing, expiry and prefix semantics, blocked
redirects, missing-PSIDTS recovery, bounded retries and mutation non-replay,
legacy migration, owner restart, persistence failure and diagnostic secrecy.

`npm run test:runtime` bundles the real Worker and runs its OAuth and MCP flows
with a SQLite Durable Object in workerd. Google traffic is replaced with an
in-process fixture; it checks redirect bridges, cookie isolation, concurrent
calls, rotation throttling, runtime restart, refresh and ambiguous mutations.

These checks do not establish that a real Google session survives 24 hours.
Use the staged production acceptance protocol in AUTHENTICATION.md. A long
soak, Workspace policies and device-bound rotation remain live validations.

## Behavioral review coverage

The authentication review follows the acquisition → transport → recovery →
persistence → OAuth/MCP consumer path against notebooklm-py v0.8.5. The
following failure boundaries have executable coverage, rather than relying on
the happy-path list fixture alone:

| Scenario | Evidence |
| --- | --- |
| Domain/path/expiry, ambiguous headers, inferred versus exported metadata | `cookies.test.ts`, `authArtifact.test.ts` |
| Missing PSIDTS, identity bridges, account routing and escaped bootstrap tokens | `authParity.test.ts`, `authRecovery.test.ts`, workerd fixture |
| Durable attempt claim, mint checkpoint, storage failure and runtime recreation | `sessionStore.test.ts`, workerd/SQLite restart |
| Old token/KV snapshots and unsuccessful reconnects | `sessionStore.test.ts` |
| Concurrent callers and throttle across requests | `sessionStore.test.ts`, workerd fixture |
| Rejected/null/HTML mutations, partial operation and client retry guidance | `authRecovery.test.ts`, workerd MCP fixture |
| Chat bootstrap ordering, streamed auth errors, separate generation timeout | `authRecovery.test.ts` |
| Accepted rotation headers followed by a body timeout | `authRecovery.test.ts` |
| Permission, sign-out, device challenge, CookieMismatch and blocked redirect | `authRecovery.test.ts`, `sessionStore.test.ts` |
| Diagnostics and logs without credentials, notebook data or challenge contents | `sessionStore.test.ts`, workerd fixture |

This closes the implementation review for the supported cookie workflow. It
does not close production longevity acceptance. Fresh real credentials,
corporate sign-out policy and 24–72 hours of idle-session behavior cannot be
established by fixture tests. Deployment and a successful live read are separate
evidence stages; neither alone proves that the next day's read will succeed.
