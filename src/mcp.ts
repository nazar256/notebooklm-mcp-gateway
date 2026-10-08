import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./config";
import type { NotebookLMCredentialEnvelope } from "./authArtifact";
import { readTextWithLimit } from "./http";
import { NotebookLMClient, NotebookLMError } from "./notebooklm";
import { hasRequiredScopes, requiredScopesForTool, type NotebookLMScope } from "./scopes";

const MCP_JSON_MAX_BYTES = 1_000_000;

const notebookSchema = z.object({ id: z.string(), title: z.string() });
const notebookDetailSchema = notebookSchema.extend({ sourcesCount: z.number(), createdAt: z.string().nullable(), isOwner: z.boolean() });
const sourceSchema = z.object({ id: z.string(), title: z.string().nullable(), url: z.string().nullable(), type: z.string(), status: z.string() });
const noteSchema = z.object({ id: z.string(), notebookId: z.string(), title: z.string(), content: z.string() });
const artifactSchema = z.object({ id: z.string(), title: z.string(), type: z.string(), status: z.string(), url: z.string().nullable() });
const researchTaskSchema = z.object({ taskId: z.string(), status: z.string(), query: z.string(), sources: z.array(z.object({ title: z.string(), url: z.string(), type: z.string() })) });

type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  outputSchema: Record<string, z.ZodType>;
  annotations?: Record<string, boolean>;
  requiredScopes: readonly NotebookLMScope[];
  run: (client: NotebookLMClient, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const notebookId = z.string().trim().min(1);
const sourceId = z.string().trim().min(1);
const noteId = z.string().trim().min(1);
const artifactId = z.string().trim().min(1);

const toolDefs: ToolDef[] = ([
  { name: "list_notebooks", title: "List NotebookLM notebooks", description: "List NotebookLM notebooks visible to the pasted browser session.", inputSchema: {}, outputSchema: { notebooks: z.array(notebookSchema) }, annotations: { readOnlyHint: true }, run: async (c) => ({ notebooks: await c.listNotebooks() }) },
  { name: "get_notebook", title: "Get NotebookLM notebook", description: "Get NotebookLM notebook metadata by ID, including basic source count and owner status.", inputSchema: { notebookId }, outputSchema: { notebook: notebookDetailSchema }, annotations: { readOnlyHint: true }, run: async (c, a) => ({ notebook: await c.getNotebook(String(a.notebookId)) }) },
  { name: "create_notebook", title: "Create NotebookLM notebook", description: "Create a NotebookLM notebook. This modifies NotebookLM state.", inputSchema: { title: z.string().trim().min(1).max(200) }, outputSchema: { notebook: notebookSchema }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => ({ notebook: await c.createNotebook({ title: String(a.title) }) }) },
  { name: "rename_notebook", title: "Rename a NotebookLM notebook", description: "Rename an existing NotebookLM notebook by ID. This modifies NotebookLM state.", inputSchema: { notebookId, title: z.string().trim().min(1).max(200) }, outputSchema: { notebook: notebookSchema }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => ({ notebook: await c.renameNotebook({ notebookId: String(a.notebookId), title: String(a.title) }) }) },
  { name: "delete_notebook", title: "Delete a NotebookLM notebook", description: "Delete a notebook. Destructive: requires confirm=true and expectedTitle exact match.", inputSchema: { notebookId, confirm: z.literal(true), expectedTitle: z.string() }, outputSchema: { deleted: z.literal(true), notebookId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true }, run: async (c, a) => c.deleteNotebook({ notebookId: String(a.notebookId), confirm: true, expectedTitle: String(a.expectedTitle) }) },

  { name: "list_sources", title: "List notebook sources", description: "List sources in a NotebookLM notebook.", inputSchema: { notebookId }, outputSchema: { sources: z.array(sourceSchema) }, annotations: { readOnlyHint: true }, run: async (c, a) => ({ sources: await c.listSources(String(a.notebookId)) }) },
  { name: "add_url_source", title: "Add URL source", description: "Add a URL or YouTube URL source to a notebook. YouTube URLs are detected and sent as the YouTube source variant.", inputSchema: { notebookId, url: z.string().url().max(4000) }, outputSchema: { source: sourceSchema }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => ({ source: await c.addUrlSource({ notebookId: String(a.notebookId), url: String(a.url) }) }) },
  { name: "add_youtube_source", title: "Add YouTube source", description: "Add a YouTube video URL as a NotebookLM source. Uses the same ADD_SOURCE RPC with YouTube URL detection.", inputSchema: { notebookId, url: z.string().url().max(4000) }, outputSchema: { source: sourceSchema }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => ({ source: await c.addUrlSource({ notebookId: String(a.notebookId), url: String(a.url) }) }) },
  { name: "add_text_source", title: "Add pasted text source", description: "Add pasted text as a NotebookLM source. Non-idempotent; callers should avoid retrying blindly.", inputSchema: { notebookId, title: z.string().trim().min(1).max(300), content: z.string().min(1).max(200_000) }, outputSchema: { source: sourceSchema }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => ({ source: await c.addTextSource({ notebookId: String(a.notebookId), title: String(a.title), content: String(a.content) }) }) },
  { name: "add_drive_source", title: "Add Google Drive source", description: "Add a Google Drive file source by Drive file ID. Requires the pasted Google browser session to have access to that file.", inputSchema: { notebookId, fileId: z.string().trim().min(1).max(300), title: z.string().trim().min(1).max(300), mimeType: z.string().trim().min(1).max(200).optional() }, outputSchema: { source: sourceSchema }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => ({ source: await c.addDriveSource({ notebookId: String(a.notebookId), fileId: String(a.fileId), title: String(a.title), mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined }) }) },
  { name: "get_source_guide", title: "Get source guide", description: "Get NotebookLM's AI-generated source guide/summary and keywords for one source.", inputSchema: { notebookId, sourceId }, outputSchema: { guide: z.object({ summary: z.string(), keywords: z.array(z.string()) }) }, annotations: { readOnlyHint: true }, run: async (c, a) => ({ guide: await c.getSourceGuide({ notebookId: String(a.notebookId), sourceId: String(a.sourceId) }) }) },
  { name: "get_source_content", title: "Get source content", description: "Get source full text/content. Markdown requests are converted from upstream HTML to plain text in Worker-safe mode.", inputSchema: { notebookId, sourceId, format: z.enum(["text", "markdown"]).optional() }, outputSchema: { source: z.object({ sourceId: z.string(), title: z.string(), content: z.string(), url: z.string().nullable(), charCount: z.number() }) }, annotations: { readOnlyHint: true }, run: async (c, a) => ({ source: await c.getSourceContent({ notebookId: String(a.notebookId), sourceId: String(a.sourceId), format: a.format === "markdown" ? "markdown" : "text" }) }) },
  { name: "refresh_source", title: "Refresh source", description: "Refresh a URL/Drive source if NotebookLM supports refreshing it.", inputSchema: { notebookId, sourceId }, outputSchema: { refreshed: z.literal(true), sourceId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => c.refreshSource({ notebookId: String(a.notebookId), sourceId: String(a.sourceId) }) },
  { name: "delete_source", title: "Delete source", description: "Delete a source. Destructive: requires confirm=true and optionally verifies expectedTitle before deletion.", inputSchema: { notebookId, sourceId, confirm: z.literal(true), expectedTitle: z.string().optional() }, outputSchema: { deleted: z.literal(true), sourceId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true }, run: async (c, a) => c.deleteSource({ notebookId: String(a.notebookId), sourceId: String(a.sourceId), confirm: true, expectedTitle: typeof a.expectedTitle === "string" ? a.expectedTitle : undefined }) },

  { name: "ask_notebook", title: "Ask notebook", description: "Ask a NotebookLM notebook a question. Returns answer text, conversation id if available, and parsed citation references when the stream exposes them.", inputSchema: { notebookId, question: z.string().trim().min(1).max(20_000), sourceIds: z.array(z.string().trim().min(1)).max(100).optional(), conversationId: z.string().trim().min(1).optional() }, outputSchema: { answer: z.string(), conversationId: z.string().nullable(), references: z.array(z.object({ sourceId: z.string().nullable(), text: z.string().nullable(), citationNumber: z.number().nullable() })) }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => c.askNotebook({ notebookId: String(a.notebookId), question: String(a.question), sourceIds: Array.isArray(a.sourceIds) ? a.sourceIds.map(String) : undefined, conversationId: typeof a.conversationId === "string" ? a.conversationId : undefined }) },
  { name: "get_last_conversation_id", title: "Get last conversation ID", description: "Get the most recent conversation ID for a notebook if NotebookLM returns one.", inputSchema: { notebookId }, outputSchema: { conversationId: z.string().nullable() }, annotations: { readOnlyHint: true }, run: async (c, a) => ({ conversationId: await c.getLastConversationId(String(a.notebookId)) }) },
  { name: "get_conversation_turns", title: "Get conversation turns", description: "Get raw conversation turns for a conversation. Shape is minimally normalized because upstream turn rows are unstable.", inputSchema: { notebookId, conversationId: z.string().trim().min(1), limit: z.number().int().min(1).max(50).optional() }, outputSchema: { turns: z.array(z.unknown()) }, annotations: { readOnlyHint: true }, run: async (c, a) => c.getConversationTurns({ notebookId: String(a.notebookId), conversationId: String(a.conversationId), limit: typeof a.limit === "number" ? a.limit : undefined }) },

  { name: "list_notes", title: "List notes", description: "List user-created text notes in a notebook.", inputSchema: { notebookId }, outputSchema: { notes: z.array(noteSchema) }, annotations: { readOnlyHint: true }, run: async (c, a) => ({ notes: await c.listNotes(String(a.notebookId)) }) },
  { name: "create_note", title: "Create note", description: "Create a text note in a notebook.", inputSchema: { notebookId, title: z.string().trim().min(1).max(300), content: z.string().max(100_000) }, outputSchema: { note: noteSchema }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => ({ note: await c.createNote({ notebookId: String(a.notebookId), title: String(a.title), content: String(a.content ?? "") }) }) },
  { name: "update_note", title: "Update note", description: "Update a note's title and content.", inputSchema: { notebookId, noteId, title: z.string().trim().min(1).max(300), content: z.string().max(100_000) }, outputSchema: { updated: z.literal(true), noteId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => c.updateNote({ notebookId: String(a.notebookId), noteId: String(a.noteId), title: String(a.title), content: String(a.content ?? "") }) },
  { name: "delete_note", title: "Delete note", description: "Soft-delete a note. Destructive: requires confirm=true and optionally expectedTitle verification.", inputSchema: { notebookId, noteId, confirm: z.literal(true), expectedTitle: z.string().optional() }, outputSchema: { deleted: z.literal(true), noteId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true }, run: async (c, a) => c.deleteNote({ notebookId: String(a.notebookId), noteId: String(a.noteId), confirm: true, expectedTitle: typeof a.expectedTitle === "string" ? a.expectedTitle : undefined }) },

  { name: "list_artifacts", title: "List Studio artifacts", description: "List NotebookLM Studio artifacts such as audio, video, reports, quizzes, flashcards, infographics, slide decks, data tables, and mind maps.", inputSchema: { notebookId, artifactType: z.string().optional() }, outputSchema: { artifacts: z.array(artifactSchema) }, annotations: { readOnlyHint: true }, run: async (c, a) => ({ artifacts: await c.listArtifacts(String(a.notebookId), typeof a.artifactType === "string" ? a.artifactType : undefined) }) },
  { name: "generate_artifact", title: "Generate Studio artifact", description: "Generate an artifact: audio, video, slide_deck, infographic, quiz, flashcards, report/briefing_doc/study_guide, data_table, or mind_map. For audio and slide_deck you can set length to short/medium/long (medium is default). Returns kickoff status; poll with list_artifacts.", inputSchema: { notebookId, artifactType: z.enum(["audio", "video", "slide_deck", "infographic", "quiz", "flashcards", "report", "briefing_doc", "study_guide", "data_table", "mind_map"]), sourceIds: z.array(z.string().trim().min(1)).max(100).optional(), instructions: z.string().max(10_000).optional(), language: z.string().min(2).max(20).optional(), length: z.enum(["short", "medium", "long"]).optional() }, outputSchema: { taskId: z.string(), status: z.string(), artifactId: z.string().nullable() }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => c.generateArtifact({ notebookId: String(a.notebookId), artifactType: String(a.artifactType), sourceIds: Array.isArray(a.sourceIds) ? a.sourceIds.map(String) : undefined, instructions: typeof a.instructions === "string" ? a.instructions : undefined, language: typeof a.language === "string" ? a.language : undefined, length: typeof a.length === "string" ? a.length : undefined }) },
  { name: "download_artifact", title: "Export artifact", description: "Request an artifact export/download URL where NotebookLM exposes one. Binary download/streaming and raw upstream export payloads are intentionally not proxied by this Worker.", inputSchema: { notebookId, artifactId, exportType: z.string().optional() }, outputSchema: { artifactId: z.string(), exportUrl: z.string().nullable() }, annotations: { readOnlyHint: true }, run: async (c, a) => c.exportArtifact({ notebookId: String(a.notebookId), artifactId: String(a.artifactId), exportType: typeof a.exportType === "string" ? a.exportType : undefined }) },

  { name: "start_research", title: "Start research", description: "Start NotebookLM web or Drive research in fast or deep mode.", inputSchema: { notebookId, query: z.string().trim().min(1).max(4000), source: z.enum(["web", "drive"]).optional(), mode: z.enum(["fast", "deep"]).optional() }, outputSchema: { taskId: z.string().nullable(), status: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => c.startResearch({ notebookId: String(a.notebookId), query: String(a.query), source: a.source === "drive" ? "drive" : "web", mode: a.mode === "deep" ? "deep" : "fast" }) },
  { name: "poll_research", title: "Poll research", description: "Poll NotebookLM research tasks/results.", inputSchema: { notebookId, taskId: z.string().optional() }, outputSchema: { tasks: z.array(researchTaskSchema) }, annotations: { readOnlyHint: true }, run: async (c, a) => c.pollResearch({ notebookId: String(a.notebookId), taskId: typeof a.taskId === "string" ? a.taskId : undefined }) },
  { name: "import_research_sources", title: "Import research sources", description: "Import selected web research result sources into a notebook.", inputSchema: { notebookId, taskId: z.string().trim().min(1), sources: z.array(z.object({ title: z.string().max(500), url: z.string().url().max(4000) })).min(1).max(25) }, outputSchema: { imported: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: false }, run: async (c, a) => c.importResearch({ notebookId: String(a.notebookId), taskId: String(a.taskId), sources: z.array(z.object({ title: z.string(), url: z.string() })).parse(a.sources) }) },

  { name: "get_share_status", title: "Get sharing status", description: "Get notebook public-link sharing status without returning raw upstream permission rows.", inputSchema: { notebookId }, outputSchema: { notebookId: z.string(), isPublic: z.boolean(), shareUrl: z.string().nullable() }, annotations: { readOnlyHint: true }, run: async (c, a) => c.getShareStatus(String(a.notebookId)) },
  { name: "set_share_public", title: "Set public sharing", description: "Enable or disable public link sharing. Requires confirm=true because it changes access permissions.", inputSchema: { notebookId, public: z.boolean(), confirm: z.literal(true) }, outputSchema: { notebookId: z.string(), isPublic: z.boolean(), shareUrl: z.string().nullable() }, annotations: { readOnlyHint: false, destructiveHint: true }, run: async (c, a) => c.setSharePublic({ notebookId: String(a.notebookId), public: Boolean(a.public), confirm: true }) }
] as Array<Omit<ToolDef, "requiredScopes">>).map((def) => ({ ...def, requiredScopes: requiredScopesForTool(def.name) }));

export async function handleMcpRequest(request: Request, env: Env, auth: { envelope: NotebookLMCredentialEnvelope; scopes: readonly NotebookLMScope[] }): Promise<Response> {
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
        const payload = await runWithMocks(env, def, args as Record<string, unknown>, auth.envelope);
        return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (error) {
        const failure = describeFailure(error);
        const traceId = crypto.randomUUID();
        const cookieAgeDays = Math.floor((Date.now() - Date.parse(auth.envelope.createdAt)) / 86_400_000);
        console.warn("NotebookLM tool failed", { tool: def.name, traceId, stage: failure.stage, status: failure.status, cookieAgeDays: Number.isFinite(cookieAgeDays) ? cookieAgeDays : undefined });
        const hint = failureHint(failure.stage);
        return { isError: true, content: [{ type: "text", text: `NotebookLM ${def.name} failed at ${failure.stage}${failure.status ? ` (HTTP ${failure.status})` : ""}. Trace ID: ${traceId}. ${hint}` }] };
      }
    });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
  await server.connect(transport);
  const mcpRequest = makeMcpRequest(request, parsedBody);
  // The SDK transport expects an initialize request first. This Worker is stateless and
  // accepts per-request tool calls from clients that already know the server. This is
  // verified with @modelcontextprotocol/sdk 1.29.0; re-check the shim before upgrading.
  if (!isInitializeRequest(parsedBody)) (transport as unknown as { _initialized: boolean })._initialized = true;
  const response = await transport.handleRequest(mcpRequest, { parsedBody });
  await server.close();
  return response;
}

async function runWithMocks(env: Env, def: ToolDef, args: Record<string, unknown>, envelope: NotebookLMCredentialEnvelope): Promise<Record<string, unknown>> {
  if (def.name === "list_notebooks" && env.MOCK_NOTEBOOKLM_LIST_JSON) return { notebooks: z.array(notebookSchema).parse(JSON.parse(env.MOCK_NOTEBOOKLM_LIST_JSON)) };
  if (def.name === "rename_notebook" && env.MOCK_NOTEBOOKLM_RENAME_JSON) return { notebook: notebookSchema.parse(JSON.parse(env.MOCK_NOTEBOOKLM_RENAME_JSON)) };
  if (def.name === "delete_notebook" && env.MOCK_NOTEBOOKLM_DELETE_JSON) return z.object({ deleted: z.literal(true), notebookId: z.string() }).parse(JSON.parse(env.MOCK_NOTEBOOKLM_DELETE_JSON));
  const safeFetch: typeof fetch = (input, init) => fetch(input, init);
  const client = new NotebookLMClient({ baseUrl: envelope.baseUrl, cookieHeader: envelope.cookieHeader, sessionId: envelope.sessionId, csrfToken: envelope.csrfToken, validationRpcId: envelope.validationRpcId, validationFReq: envelope.validationFReq, fetch: safeFetch });
  return def.run(client, args);
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

function describeFailure(error: unknown): { stage: string; status?: number } {
  if (error instanceof NotebookLMError) return { stage: error.stage, status: error.status };
  if (error instanceof z.ZodError) return { stage: "input_validation" };
  return { stage: "runtime" };
}

function failureHint(stage: string): string {
  if (stage === "auth_expired") return "The NotebookLM browser session appears expired. Reconnect with a fresh browser auth artifact.";
  if (stage === "upstream_null") return "NotebookLM returned an empty result for a required RPC — often an expired session. Reconnect with a fresh browser auth artifact.";
  return "Check IDs, safety confirmations, and reconnect with a fresh browser auth artifact if this persists.";
}
