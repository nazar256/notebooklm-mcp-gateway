# Validation

## Automated checks

Run before publishing or deploying:

```bash
npm test
npm run typecheck
```

The tests cover:

- OAuth metadata, Dynamic Client Registration, redirect validation, state preservation, PKCE, token exchange, and stateless refresh tokens;
- duplicate OAuth parameter rejection, resource validation, request-body limits, and invalid bearer-token challenges;
- auth artifact parsing for Copy-as-cURL, raw Cookie headers, and `storage_state.json`;
- safe artifact reporting without cookie-value leakage;
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
- live Worker URLs and deployment IDs;
- real notebook, source, artifact, or ChatGPT app IDs;
- local machine paths and user names;
- private support/debug transcripts.

The public tree should contain only placeholder deployment URLs and synthetic test fixtures.
