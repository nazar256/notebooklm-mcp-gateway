import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./config";
import type { NotebookLMCredentialEnvelope } from "./authArtifact";
import { readTextWithLimit } from "./http";
import { NotebookLMError } from "./notebooklm";
import { toolDefs, type ToolDef } from "./tools";
import { runSessionOperation, unwrapSessionResult } from "./sessionStore";
import { hasRequiredScopes, type NotebookLMScope } from "./scopes";

const MCP_JSON_MAX_BYTES = 1_000_000;


export async function handleMcpRequest(request: Request, env: Env, auth: { envelope: NotebookLMCredentialEnvelope; scopes: readonly NotebookLMScope[] }, ctx?: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  let parsedBody: unknown;
  try { parsedBody = JSON.parse(await readTextWithLimit(request, MCP_JSON_MAX_BYTES)); } catch (error) {
    if (error instanceof SyntaxError) return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    throw error;
  }

  const server = new McpServer({ name: "notebooklm-mcp-gateway", version: "0.0.0" });
  for (const def of toolDefs.filter((tool) => hasRequiredScopes(auth.scopes, tool.requiredScopes))) {
    server.registerTool(def.name, { title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations }, async (args) => {
      try {
        const payload = await runWithMocks(env, def, args as Record<string, unknown>, auth.envelope, ctx);
        return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (error) {
        const failure = describeFailure(error);
        const traceId = error instanceof Error && "traceId" in error ? String(error.traceId) : crypto.randomUUID();
        const cookieAgeDays = Math.floor((Date.now() - Date.parse(auth.envelope.createdAt)) / 86_400_000);
        // Message string carries the diagnostics: Cloudflare Observability does
        // not index structured log arguments.
        console.warn(`NotebookLM tool failed tool=${def.name} stage=${failure.stage} reason=${failure.reason ?? "-"} status=${failure.status ?? "-"} traceId=${traceId} cookieAgeDays=${Number.isFinite(cookieAgeDays) ? cookieAgeDays : "-"} cred=${(auth.envelope.credId ?? "-").slice(0, 8)}`);
        const hint = failureHint(failure.stage) + (def.annotations?.readOnlyHint === false && failure.stage !== "input_validation"
          ? " This operation may have partially completed. Inspect NotebookLM before retrying; do not repeat the whole operation blindly." : "");
        return { isError: true, content: [{ type: "text", text: `NotebookLM ${def.name} failed at ${failure.stage}${failure.reason ? ` (${failure.reason})` : ""}${failure.status ? ` (HTTP ${failure.status})` : ""}. Trace ID: ${traceId}. ${hint}` }] };
      }
    });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
  await server.connect(transport);
  const mcpRequest = makeMcpRequest(request, parsedBody);
  // The SDK transport expects an initialize request first. The MCP transport is request-local and
  // accepts per-request tool calls from clients that already know the server. This is
  // verified with @modelcontextprotocol/sdk 1.29.0; re-check the shim before upgrading.
  if (!isInitializeRequest(parsedBody)) (transport as unknown as { _initialized: boolean })._initialized = true;
  const response = await transport.handleRequest(mcpRequest, { parsedBody });
  await server.close();
  return response;
}

async function runWithMocks(env: Env, def: ToolDef, args: Record<string, unknown>, envelope: NotebookLMCredentialEnvelope, ctx?: ExecutionContext): Promise<Record<string, unknown>> {
  if (def.name === "list_notebooks" && env.MOCK_NOTEBOOKLM_LIST_JSON) return { notebooks: z.array(z.object({ id: z.string(), title: z.string() })).parse(JSON.parse(env.MOCK_NOTEBOOKLM_LIST_JSON)) };
  if (def.name === "rename_notebook" && env.MOCK_NOTEBOOKLM_RENAME_JSON) return { notebook: z.object({ id: z.string(), title: z.string() }).parse(JSON.parse(env.MOCK_NOTEBOOKLM_RENAME_JSON)) };
  if (def.name === "delete_notebook" && env.MOCK_NOTEBOOKLM_DELETE_JSON) return z.object({ deleted: z.literal(true), notebookId: z.string() }).parse(JSON.parse(env.MOCK_NOTEBOOKLM_DELETE_JSON));
  const result = await runSessionOperation(env, envelope, { kind: "tool", tool: def.name, args });
  return unwrapSessionResult(result).payload;
}

function isInitializeRequest(body: unknown): boolean {
  return typeof body === "object" && body !== null && "method" in body && (body as { method?: unknown }).method === "initialize";
}

function makeMcpRequest(request: Request, parsedBody: unknown): Request {
  const headers = new Headers(request.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json, text/event-stream");
  return new Request(request.url, { method: request.method, headers, body: JSON.stringify(parsedBody) });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describeFailure(error: unknown): { stage: string; reason?: string; status?: number } {
  if (error instanceof NotebookLMError) return { stage: error.stage, reason: error.reason, status: error.status };
  if (error instanceof z.ZodError) return { stage: "input_validation" };
  return { stage: "runtime" };
}

function failureHint(stage: string): string {
  if (stage === "auth_expired") return "The NotebookLM browser session appears expired. Reconnect with a fresh browser auth artifact.";
  if (stage === "session_store") return "Session storage failed; inspect the trace before retrying a mutation, which may already have completed upstream.";
  if (stage === "auth_challenge") return "Google requires an interactive challenge. Inspect get_auth_status for recovery evidence.";
  if (stage === "access_denied" || stage === "cookie_mismatch") return "Google denied access or rejected account routing. Inspect get_auth_status; reconnecting may not resolve a permission or policy restriction.";
  if (stage === "upstream_null") return "NotebookLM returned an empty result for a required RPC — often an expired session. Reconnect with a fresh browser auth artifact.";
  return "Check IDs, safety confirmations, and reconnect with a fresh browser auth artifact if this persists.";
}
