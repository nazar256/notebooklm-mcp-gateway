import { z } from "zod";
import { allowedNotebookLMBaseUrls, notebookLmCookieAllowlist, parseCookieHeader } from "./authArtifact";

export type NotebookSummary = { id: string; title: string };
export type Notebook = NotebookSummary & { sourcesCount: number; createdAt: string | null; isOwner: boolean };
export type Source = { id: string; title: string | null; url: string | null; type: string; status: string };
export type SourceGuide = { summary: string; keywords: string[] };
export type SourceContent = { sourceId: string; title: string; content: string; url: string | null; charCount: number };
export type Note = { id: string; notebookId: string; title: string; content: string };
export type Artifact = { id: string; title: string; type: string; status: string; url: string | null };
export type GenerationStatus = { taskId: string; status: string; artifactId: string | null };
export type ResearchTask = { taskId: string; status: string; query: string; sources: Array<{ title: string; url: string; type: string }> };
export type AskResult = { answer: string; conversationId: string | null; references: Array<{ sourceId: string | null; text: string | null; citationNumber: number | null }> };
export type NotebookLMFailureStage = "auth_bootstrap_http" | "auth_bootstrap_parse" | "auth_expired" | "upstream_http" | "upstream_null" | "upstream_parse";

export class NotebookLMError extends Error {
  readonly stage: NotebookLMFailureStage;
  readonly status?: number;

  constructor(message: string, stage: NotebookLMFailureStage, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "NotebookLMError";
    this.stage = stage;
    this.status = options.status;
  }
}

const notebookSchema = z.object({ id: z.string(), title: z.string() });
const renameInputSchema = z.object({ notebookId: z.string().trim().min(1), title: z.string().trim().min(1).max(200) });
const deleteInputSchema = z.object({ notebookId: z.string().trim().min(1), confirm: z.literal(true), expectedTitle: z.string() });
const idPairSchema = z.object({ notebookId: z.string().trim().min(1), sourceId: z.string().trim().min(1) });
const rpcMethods = {
  listNotebooks: "wXbhsf",
  createNotebook: "CCqFvf",
  getNotebook: "rLM1Ne",
  renameNotebook: "s0tc2d",
  deleteNotebook: "WWINqb",
  addSource: "izAoDd",
  deleteSource: "tGMBJ",
  getSource: "hizoJc",
  refreshSource: "FLmJqe",
  getSourceGuide: "tr032e",
  createArtifact: "R7cb6c",
  listArtifacts: "gArtLc",
  exportArtifact: "Krh3pd",
  startFastResearch: "Ljjv0c",
  startDeepResearch: "QA9ei",
  pollResearch: "e3bVqc",
  importResearch: "LBwxtb",
  createNote: "CYK0Xb",
  getNotesAndMindMaps: "cFji9",
  updateNote: "cYAfTb",
  deleteNote: "AH0mwd",
  getLastConversationId: "hPTbtc",
  getConversationTurns: "khqZz",
  shareNotebook: "QDyure",
  getShareStatus: "JFMDGd"
} as const;

const sourceTypeByCode: Record<number, string> = { 1: "google_docs", 2: "google_slides", 3: "pdf", 4: "pasted_text", 5: "web_page", 8: "markdown", 9: "youtube", 10: "media", 11: "docx", 13: "image", 14: "google_spreadsheet", 16: "csv", 17: "epub" };
const sourceStatusByCode: Record<number, string> = { 1: "processing", 2: "ready", 3: "error" };
const artifactStatusByCode: Record<number, string> = { 1: "in_progress", 2: "pending", 3: "completed", 4: "failed" };
const artifactTypeByCode: Record<number, string> = { 1: "audio", 2: "report", 3: "video", 4: "quiz", 5: "mind_map", 7: "infographic", 8: "slide_deck", 9: "data_table" };
const artifactTypeCodeByName: Record<string, number> = { audio: 1, report: 2, briefing_doc: 2, study_guide: 2, video: 3, quiz: 4, flashcards: 4, mind_map: 5, infographic: 7, slide_deck: 8, data_table: 9 };

// Last-resort boq build label; the live value is read from the bootstrap HTML (cfb2h).
const fallbackBuildLabel = "boq_labs-tailwind-frontend_20260108.06_p0";

export class NotebookLMClient {
  private baseUrl: (typeof allowedNotebookLMBaseUrls)[number];
  private readonly cookieHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly copiedSessionId?: string;
  private readonly copiedCsrfToken?: string;
  private readonly validationRpcId?: string;
  private readonly validationFReq?: string;
  private readonly cookieJar: Map<string, string>;

  constructor(options: { baseUrl: string; cookieHeader: string; fetch: typeof fetch; sessionId?: string; csrfToken?: string; validationRpcId?: string; validationFReq?: string }) {
    const baseUrl = z.enum(allowedNotebookLMBaseUrls).parse(options.baseUrl);
    this.baseUrl = baseUrl;
    this.cookieHeader = options.cookieHeader;
    this.fetchImpl = options.fetch;
    this.copiedSessionId = options.sessionId;
    this.copiedCsrfToken = options.csrfToken;
    this.validationRpcId = options.validationRpcId;
    this.validationFReq = options.validationFReq;
    this.cookieJar = parseCookieHeader(options.cookieHeader);
  }

  // Google rotates session cookies (SIDCC/PSIDCC/PSIDTS families) via Set-Cookie on
  // nearly every response. Tracking them here keeps the pasted snapshot fresher for
  // the life of this invocation, and lets callers persist the rotated values. The jar
  // starts from the pasted header, so non-allowlisted pasted cookies keep being sent;
  // an emptied jar stays empty rather than resurrecting deleted cookies.
  getCookieHeader(): string {
    return [...this.cookieJar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  // Best-effort upstream session ping whose only purpose is collecting Set-Cookie
  // rotation. Runs a real authenticated RPC, not just the shell, so batchexecute-level
  // rotations are captured too. Errors are swallowed; on auth_expired the jar is
  // restored so a dead session cannot persist cookies from a sign-in response.
  async refreshCookies(): Promise<void> {
    const seeded = new Map(this.cookieJar);
    try {
      await this.validateAuthentication();
    } catch (error) {
      if (error instanceof NotebookLMError && error.stage === "auth_expired") {
        this.cookieJar.clear();
        for (const [name, value] of seeded) this.cookieJar.set(name, value);
      }
    }
  }

  async validateAuthentication(): Promise<void> {
    try {
      await this.listNotebooks();
      return;
    } catch (error) {
      if (!this.validationRpcId || !this.validationFReq) throw error;
    }
    if (this.validationRpcId && this.validationFReq) {
      await this.rpcCall(this.validationRpcId, undefined, { fReq: this.validationFReq });
      return;
    }
  }

  async listNotebooks(): Promise<NotebookSummary[]> {
    const result = await this.rpcCall(rpcMethods.listNotebooks, [null, 1, null, [2]]);
    return parseNotebookRows(result);
  }

  async getNotebook(notebookId: string): Promise<Notebook> {
    const result = await this.rpcCall(rpcMethods.getNotebook, [notebookId, null, [2], null, 0], { sourcePath: `/notebook/${notebookId}` });
    const row = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
    const notebook = parseNotebook(row);
    if (!notebook.id && !notebook.title) throw new Error("NotebookLM notebook not found");
    return notebook;
  }

  async createNotebook(input: { title: string }): Promise<NotebookSummary> {
    const title = z.string().trim().min(1).max(200).parse(input.title);
    const result = await this.rpcCall(rpcMethods.createNotebook, [title, null, null, [2], [1]]);
    const notebook = parseNotebookRow(result);
    if (!notebook?.id) throw new Error("NotebookLM create_notebook returned no notebook id");
    return notebook;
  }

  async renameNotebook(input: { notebookId: string; title: string }): Promise<NotebookSummary> {
    const parsed = renameInputSchema.parse(input);
    const result = await this.rpcCall(
      rpcMethods.renameNotebook,
      [parsed.notebookId, [[null, null, null, [null, parsed.title]]]],
      { allowNull: true }
    );
    const renamed = parseNotebookRow(result);
    if (renamed?.id) return renamed;

    const notebooks = await this.listNotebooks();
    const match = notebooks.find((notebook) => notebook.id === parsed.notebookId);
    if (!match) throw new Error("NotebookLM notebook not found after rename");
    return match;
  }

  async deleteNotebook(input: { notebookId: string; confirm: true; expectedTitle: string }): Promise<{ deleted: true; notebookId: string }> {
    const parsed = deleteInputSchema.parse(input);
    const beforeDelete = await this.listNotebooks();
    const target = beforeDelete.find((notebook) => notebook.id === parsed.notebookId);
    if (!target) throw new Error("NotebookLM notebook not found before delete");
    if (target.title !== parsed.expectedTitle) throw new Error("NotebookLM notebook title mismatch before delete");
    await this.rpcCall(rpcMethods.deleteNotebook, [[parsed.notebookId], [2]], { allowNull: true });
    const notebooks = await this.listNotebooks();
    if (notebooks.some((notebook) => notebook.id === parsed.notebookId)) {
      throw new Error("NotebookLM notebook still present after delete");
    }
    return { deleted: true, notebookId: parsed.notebookId };
  }

  async listSources(notebookId: string): Promise<Source[]> {
    const notebook = await this.rpcCall(rpcMethods.getNotebook, [notebookId, null, [2], null, 0], { sourcePath: `/notebook/${notebookId}` });
    const nbInfo = Array.isArray(notebook) && Array.isArray(notebook[0]) ? notebook[0] : [];
    const rows = Array.isArray(nbInfo[1]) ? nbInfo[1] : [];
    return rows.map((row) => parseSource(row)).filter((source): source is Source => source !== null);
  }

  async addUrlSource(input: { notebookId: string; url: string }): Promise<Source> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), url: z.string().trim().url().max(4000) }).parse(input);
    const isYoutube = extractYoutubeVideoId(parsed.url) !== null;
    const sourceData = isYoutube ? [parsed.url, null, null, null, null, null, null, null, null, null, 9] : [null, null, [parsed.url, parsed.url], null, null, null, null, null, null, null, 2];
    const result = await this.rpcCall(rpcMethods.addSource, [[sourceData], parsed.notebookId, [2], null, null], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    const direct = parseSource(result);
    if (direct?.id) return direct;
    const sources = await this.listSources(parsed.notebookId);
    const byUrl = sources.find((source) => source.url === parsed.url || source.title === parsed.url);
    if (byUrl) return byUrl;
    const latest = sources.at(-1);
    if (latest) return latest;
    throw new Error("NotebookLM add_url_source returned no source id");
  }

  async addTextSource(input: { notebookId: string; title: string; content: string }): Promise<Source> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), title: z.string().trim().min(1).max(300), content: z.string().min(1).max(200_000) }).parse(input);
    const result = await this.rpcCall(rpcMethods.addSource, [[ [null, [parsed.title, parsed.content], null, null, null, null, null, null] ], parsed.notebookId, [2], null, null], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    const direct = parseSource(result);
    if (direct?.id) return direct;
    const sources = await this.listSources(parsed.notebookId);
    const byTitle = sources.find((source) => source.title === parsed.title);
    if (byTitle) return byTitle;
    const latest = sources.at(-1);
    if (latest) return latest;
    throw new Error("NotebookLM add_text_source returned no source id");
  }

  async addDriveSource(input: { notebookId: string; fileId: string; title: string; mimeType?: string }): Promise<Source> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), fileId: z.string().trim().min(1).max(300), title: z.string().trim().min(1).max(300), mimeType: z.string().trim().min(1).max(200).optional() }).parse(input);
    const sourceData = [parsed.fileId, parsed.mimeType ?? "application/vnd.google-apps.document", 1, parsed.title, null, null, null, null, null, null, 1];
    const result = await this.rpcCall(rpcMethods.addSource, [[sourceData], parsed.notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    const direct = parseSource(result);
    if (direct?.id) return direct;
    const sources = await this.listSources(parsed.notebookId);
    const byTitle = sources.find((source) => source.title === parsed.title);
    if (byTitle) return byTitle;
    const latest = sources.at(-1);
    if (latest) return latest;
    throw new Error("NotebookLM add_drive_source returned no source id");
  }

  async getSourceGuide(input: { notebookId: string; sourceId: string }): Promise<SourceGuide> {
    const parsed = idPairSchema.parse(input);
    const result = await this.rpcCall(rpcMethods.getSourceGuide, [[[[parsed.sourceId]]]], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    const inner = Array.isArray(result) && Array.isArray(result[0]) && Array.isArray(result[0][0]) ? result[0][0] : [];
    const summaryBlock = Array.isArray(inner[1]) ? inner[1] : [];
    const keywordBlock = Array.isArray(inner[2]) ? inner[2] : [];
    return { summary: typeof summaryBlock[0] === "string" ? summaryBlock[0] : "", keywords: Array.isArray(keywordBlock[0]) ? keywordBlock[0].filter((x): x is string => typeof x === "string") : [] };
  }

  async getSourceContent(input: { notebookId: string; sourceId: string; format?: "text" | "markdown" }): Promise<SourceContent> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), sourceId: z.string().trim().min(1), format: z.enum(["text", "markdown"]).optional() }).parse(input);
    const markdown = parsed.format === "markdown";
    const result = await this.rpcCall(rpcMethods.getSource, [[parsed.sourceId], markdown ? [3] : [2], markdown ? [3] : [2]], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    if (!Array.isArray(result)) throw new Error("NotebookLM source not found");
    const descriptor = Array.isArray(result[0]) ? result[0] : [];
    const title = typeof descriptor[1] === "string" ? descriptor[1] : "";
    const metadata = Array.isArray(descriptor[2]) ? descriptor[2] : [];
    const url = extractSourceUrl(metadata, false);
    const block = markdown ? (Array.isArray(result[4]) ? result[4][1] : "") : (Array.isArray(result[3]) ? result[3][0] : []);
    const content = markdown && typeof block === "string" ? stripHtml(block) : extractAllText(Array.isArray(block) ? block : []).join("\n");
    return { sourceId: parsed.sourceId, title, content, url, charCount: content.length };
  }

  async refreshSource(input: { notebookId: string; sourceId: string }): Promise<{ refreshed: true; sourceId: string }> {
    const parsed = idPairSchema.parse(input);
    await this.rpcCall(rpcMethods.refreshSource, [null, [parsed.sourceId], [2]], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    return { refreshed: true, sourceId: parsed.sourceId };
  }

  async deleteSource(input: { notebookId: string; sourceId: string; confirm: true; expectedTitle?: string }): Promise<{ deleted: true; sourceId: string }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), sourceId: z.string().trim().min(1), confirm: z.literal(true), expectedTitle: z.string().optional() }).parse(input);
    if (parsed.expectedTitle) {
      const source = (await this.listSources(parsed.notebookId)).find((candidate) => candidate.id === parsed.sourceId);
      if (!source) throw new Error("NotebookLM source not found before delete");
      if (source.title !== parsed.expectedTitle) throw new Error("NotebookLM source title mismatch before delete");
    }
    await this.rpcCall(rpcMethods.deleteSource, [[ [parsed.sourceId] ]], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    return { deleted: true, sourceId: parsed.sourceId };
  }

  async askNotebook(input: { notebookId: string; question: string; sourceIds?: string[]; conversationId?: string }): Promise<AskResult> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), question: z.string().trim().min(1).max(20_000), sourceIds: z.array(z.string().trim().min(1)).max(100).optional(), conversationId: z.string().trim().min(1).optional() }).parse(input);
    const sourceIds = parsed.sourceIds ?? (await this.listSources(parsed.notebookId)).map((source) => source.id);
    const bootstrap = await this.bootstrap();
    const conversationId = parsed.conversationId ?? await this.getLastConversationId(parsed.notebookId) ?? crypto.randomUUID();
    const params = [nestSourceIds(sourceIds, 2), parsed.question, null, [2, null, [1]], conversationId];
    const body = new URLSearchParams();
    body.set("f.req", JSON.stringify([null, JSON.stringify(params)]));
    if (bootstrap.csrfToken) body.set("at", bootstrap.csrfToken);
    const url = new URL(`${this.baseUrl}/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed`);
    url.searchParams.set("bl", bootstrap.buildLabel ?? fallbackBuildLabel);
    url.searchParams.set("f.sid", bootstrap.sessionId);
    url.searchParams.set("hl", "en");
    url.searchParams.set("_reqid", String(Date.now() % 100000));
    url.searchParams.set("rt", "c");
    const response = await this.upstreamFetch(url.toString(), { method: "POST", headers: this.rpcHeaders(), body: `${body.toString()}&` });
    if (!response.ok) throw new Error("NotebookLM chat request failed");
    const parsedChat = parseChatResponse(await response.text());
    return { answer: parsedChat.answer, conversationId, references: parsedChat.references };
  }

  async getLastConversationId(notebookId: string): Promise<string | null> {
    const result = await this.rpcCall(rpcMethods.getLastConversationId, [[], null, notebookId, 1], { sourcePath: `/notebook/${notebookId}` });
    if (!Array.isArray(result)) return null;
    for (const group of result) if (Array.isArray(group)) for (const item of group) if (Array.isArray(item) && typeof item[0] === "string") return item[0];
    return null;
  }

  async getConversationTurns(input: { notebookId: string; conversationId: string; limit?: number }): Promise<{ turns: unknown[] }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), conversationId: z.string().trim().min(1), limit: z.number().int().min(1).max(50).optional() }).parse(input);
    const result = await this.rpcCall(rpcMethods.getConversationTurns, [[], null, null, parsed.conversationId, parsed.limit ?? 10], { sourcePath: `/notebook/${parsed.notebookId}` });
    return { turns: Array.isArray(result) ? result : [] };
  }

  async listNotes(notebookId: string): Promise<Note[]> {
    const rows = await this.fetchNoteRows(notebookId);
    return rows.map((row) => parseNote(row, notebookId)).filter((note): note is Note => note !== null);
  }

  async createNote(input: { notebookId: string; title: string; content: string }): Promise<Note> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), title: z.string().trim().min(1).max(300), content: z.string().max(100_000) }).parse(input);
    const result = await this.rpcCall(rpcMethods.createNote, [parsed.notebookId, "", [1], null, parsed.title], { sourcePath: `/notebook/${parsed.notebookId}` });
    const noteId = extractFirstString(result);
    if (!noteId) throw new Error("NotebookLM create_note returned no note id");
    await this.updateNote({ ...parsed, noteId });
    return { id: noteId, notebookId: parsed.notebookId, title: parsed.title, content: parsed.content };
  }

  async updateNote(input: { notebookId: string; noteId: string; title: string; content: string }): Promise<{ updated: true; noteId: string }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), noteId: z.string().trim().min(1), title: z.string().trim().min(1).max(300), content: z.string().max(100_000) }).parse(input);
    await this.rpcCall(rpcMethods.updateNote, [parsed.notebookId, parsed.noteId, [[[parsed.content, parsed.title, [], 0]]]], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    return { updated: true, noteId: parsed.noteId };
  }

  async deleteNote(input: { notebookId: string; noteId: string; confirm: true; expectedTitle?: string }): Promise<{ deleted: true; noteId: string }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), noteId: z.string().trim().min(1), confirm: z.literal(true), expectedTitle: z.string().optional() }).parse(input);
    if (parsed.expectedTitle) {
      const note = (await this.listNotes(parsed.notebookId)).find((candidate) => candidate.id === parsed.noteId);
      if (!note) throw new Error("NotebookLM note not found before delete");
      if (note.title !== parsed.expectedTitle) throw new Error("NotebookLM note title mismatch before delete");
    }
    await this.rpcCall(rpcMethods.deleteNote, [parsed.notebookId, null, [parsed.noteId]], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    return { deleted: true, noteId: parsed.noteId };
  }

  async listArtifacts(notebookId: string, type?: string): Promise<Artifact[]> {
    const result = await this.rpcCall(rpcMethods.listArtifacts, [notebookId], { sourcePath: `/notebook/${notebookId}`, allowNull: true });
    const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : [];
    const artifacts = rows.map((row) => parseArtifact(row)).filter((artifact): artifact is Artifact => artifact !== null);
    return type ? artifacts.filter((artifact) => artifact.type === type) : artifacts;
  }

  async generateArtifact(input: { notebookId: string; artifactType: string; sourceIds?: string[]; instructions?: string; language?: string; length?: string }): Promise<GenerationStatus> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), artifactType: z.enum(["audio", "video", "slide_deck", "infographic", "quiz", "flashcards", "report", "briefing_doc", "study_guide", "data_table", "mind_map"]), sourceIds: z.array(z.string().trim().min(1)).max(100).optional(), instructions: z.string().max(10_000).optional(), language: z.string().trim().min(2).max(20).optional(), length: z.enum(["short", "medium", "long"]).optional() }).parse(input);
    const sourceIds = parsed.sourceIds ?? (await this.listSources(parsed.notebookId)).map((source) => source.id);
    const result = await this.rpcCall(rpcMethods.createArtifact, buildArtifactParams(parsed.notebookId, parsed.artifactType, sourceIds, parsed.instructions, parsed.language ?? "en", parsed.length ?? "medium"), { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    const id = extractFirstString(result);
    return { taskId: id ?? "", artifactId: id, status: id ? "in_progress" : "failed" };
  }

  async exportArtifact(input: { notebookId: string; artifactId: string; exportType?: string }): Promise<{ artifactId: string; exportUrl: string | null }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), artifactId: z.string().trim().min(1), exportType: z.string().trim().min(1).max(40).optional() }).parse(input);
    const result = await this.rpcCall(rpcMethods.exportArtifact, [parsed.artifactId, parsed.exportType ?? "url"], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    return { artifactId: parsed.artifactId, exportUrl: extractFirstUrl(result) };
  }

  async startResearch(input: { notebookId: string; query: string; source?: "web" | "drive"; mode?: "fast" | "deep" }): Promise<{ taskId: string | null; status: string }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), query: z.string().trim().min(1).max(4000), source: z.enum(["web", "drive"]).optional(), mode: z.enum(["fast", "deep"]).optional() }).parse(input);
    const method = parsed.mode === "deep" ? rpcMethods.startDeepResearch : rpcMethods.startFastResearch;
    const sourceCode = parsed.source === "drive" ? 2 : 1;
    const params = parsed.mode === "deep"
      ? [null, [1], [parsed.query, sourceCode], 5, parsed.notebookId]
      : [[parsed.query, sourceCode], null, 1, parsed.notebookId];
    const result = await this.rpcCall(method, params, { sourcePath: `/notebook/${parsed.notebookId}` });
    return { taskId: extractFirstString(result), status: "started" };
  }

  async pollResearch(input: { notebookId: string; taskId?: string }): Promise<{ tasks: ResearchTask[] }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), taskId: z.string().trim().min(1).optional() }).parse(input);
    const result = await this.rpcCall(rpcMethods.pollResearch, [null, null, parsed.notebookId], { sourcePath: `/notebook/${parsed.notebookId}` });
    const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
    const tasks = rows.map(parseResearchTask).filter((task): task is ResearchTask => task !== null);
    return { tasks: parsed.taskId ? tasks.filter((task) => task.taskId === parsed.taskId) : tasks };
  }

  async importResearch(input: { notebookId: string; taskId: string; sources: Array<{ title: string; url: string }> }): Promise<{ imported: true }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), taskId: z.string().trim().min(1), sources: z.array(z.object({ title: z.string().max(500), url: z.string().url().max(4000) })).min(1).max(25) }).parse(input);
    const entries = parsed.sources.map((source) => [null, null, [source.url, source.title], null, null, null, null, null, null, null, 2]);
    await this.rpcCall(rpcMethods.importResearch, [parsed.notebookId, parsed.taskId, entries], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    return { imported: true };
  }

  async getShareStatus(notebookId: string): Promise<{ notebookId: string; isPublic: boolean; shareUrl: string | null }> {
    const result = await this.rpcCall(rpcMethods.getShareStatus, [notebookId, [2]], { sourcePath: `/notebook/${notebookId}` });
    return { notebookId, isPublic: isPublicShare(result), shareUrl: extractFirstUrl(result) ?? `${this.baseUrl}/notebook/${encodeURIComponent(notebookId)}` };
  }

  async setSharePublic(input: { notebookId: string; public: boolean; confirm: true }): Promise<{ notebookId: string; isPublic: boolean; shareUrl: string | null }> {
    const parsed = z.object({ notebookId: z.string().trim().min(1), public: z.boolean(), confirm: z.literal(true) }).parse(input);
    const access = parsed.public ? 2 : 1;
    await this.rpcCall(rpcMethods.shareNotebook, [[[parsed.notebookId, null, [access], [access, ""]]], 1, null, [2]], { sourcePath: `/notebook/${parsed.notebookId}`, allowNull: true });
    return this.getShareStatus(parsed.notebookId);
  }

  private async fetchNoteRows(notebookId: string): Promise<unknown[][]> {
    const result = await this.rpcCall(rpcMethods.getNotesAndMindMaps, [notebookId], { sourcePath: `/notebook/${notebookId}`, allowNull: true });
    if (!Array.isArray(result)) return [];
    const rows = Array.isArray(result[0]) && isNoteRowLike(result[0]) ? result : Array.isArray(result[0]) ? result[0] : [];
    return rows.map(normalizeNoteRow).filter((row): row is unknown[] => row !== null);
  }

  private async rpcCall(rpcId: string, params: unknown[] | undefined, options: { allowNull?: boolean; fReq?: string; sourcePath?: string } = {}): Promise<unknown> {
    const bootstrap = await this.bootstrap();
    const url = new URL(`${this.baseUrl}/_/LabsTailwindUi/data/batchexecute`);
    url.searchParams.set("rpcids", rpcId);
    url.searchParams.set("source-path", options.sourcePath ?? "/");
    url.searchParams.set("f.sid", bootstrap.sessionId);
    url.searchParams.set("hl", "en");
    url.searchParams.set("rt", "c");

    const rpcRequest = params === undefined ? undefined : [[[rpcId, JSON.stringify(params), null, "generic"]]];
    const body = new URLSearchParams();
    body.set("f.req", options.fReq ?? JSON.stringify(rpcRequest));
    if (bootstrap.csrfToken) body.set("at", bootstrap.csrfToken);

    const response = await this.upstreamFetch(url.toString(), {
      method: "POST",
      headers: this.rpcHeaders(),
      body: body.toString()
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new NotebookLMError("NotebookLM rejected the session", "auth_expired", { status: response.status });
      }
      throw new NotebookLMError("NotebookLM request failed", "upstream_http", { status: response.status });
    }
    if (isLoginUrl(response.url) || isHtmlResponse(response)) {
      throw new NotebookLMError("NotebookLM redirected to sign-in", "auth_expired");
    }
    try {
      return extractRpcResult(parseNotebookLMResponse(await response.text()), rpcId, options);
    } catch (error) {
      if (error instanceof NotebookLMError) throw error;
      throw new NotebookLMError("NotebookLM response parse failed", "upstream_parse", { cause: error });
    }
  }

  private rpcHeaders(): HeadersInit {
    return { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "cookie": this.getCookieHeader(), "origin": this.baseUrl, "referer": `${this.baseUrl}/`, "x-same-domain": "1" };
  }

  private async upstreamFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(input, init);
    // Sign-in pages may set allowlisted cookies for accounts.google.com — those belong
    // to a different account context and must never enter the jar.
    if (!isLoginUrl(response.url)) this.captureSetCookies(response.headers);
    return response;
  }

  private captureSetCookies(headers: Headers | undefined): void {
    const setCookies = headers?.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair, ...attributes] = raw.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!notebookLmCookieAllowlist.has(name)) continue;
      if (value && !isExpiredSetCookie(attributes)) this.cookieJar.set(name, value);
      else this.cookieJar.delete(name);
    }
  }

  private async bootstrap(): Promise<{ csrfToken: string; sessionId: string; buildLabel?: string }> {
    try {
      return await this.fetchFreshBootstrap();
    } catch (error) {
      if (error instanceof NotebookLMError && error.stage === "auth_expired") throw error;
      if (this.copiedSessionId) return { csrfToken: this.copiedCsrfToken ?? "", sessionId: this.copiedSessionId };
      throw error;
    }
  }

  private async fetchFreshBootstrap(): Promise<{ csrfToken: string; sessionId: string; buildLabel?: string }> {
    const response = await this.upstreamFetch(`${this.baseUrl}/`, {
      headers: { cookie: this.getCookieHeader() }
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new NotebookLMError("NotebookLM rejected the session", "auth_expired", { status: response.status });
      }
      throw new NotebookLMError("NotebookLM authentication failed", "auth_bootstrap_http", { status: response.status });
    }
    this.adoptRedirectedBaseUrl(response.url);
    const html = await response.text();
    if (isLoginUrl(response.url) || looksLikeGoogleLogin(html)) {
      throw new NotebookLMError("NotebookLM session expired", "auth_expired");
    }
    const csrfToken = extractWizField(html, "SNlM0e") ?? "";
    const sessionId = extractWizField(html, "FdrFJe") ?? "";
    if (!sessionId) throw new NotebookLMError("NotebookLM session bootstrap failed", "auth_bootstrap_parse");
    const buildLabel = extractWizField(html, "cfb2h") ?? undefined;
    return { csrfToken, sessionId, buildLabel };
  }

  private adoptRedirectedBaseUrl(finalUrl: string | undefined): void {
    if (!finalUrl) return;
    let hostname: string;
    try {
      hostname = new URL(finalUrl).hostname;
    } catch {
      return;
    }
    const redirected = allowedNotebookLMBaseUrls.find((base) => new URL(base).hostname === hostname);
    if (redirected) this.baseUrl = redirected;
  }
}

function parseNotebookRows(result: unknown): NotebookSummary[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
  return rows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => parseNotebookRow(row))
      .filter((notebook): notebook is NotebookSummary => notebook !== null)
      .filter((notebook) => notebook.id || notebook.title);
}

function parseNotebookRow(row: unknown): NotebookSummary | null {
  if (!Array.isArray(row)) return null;
  const parsed = notebookSchema.safeParse({
    title: typeof row[0] === "string" ? row[0].replace("thought\n", "").trim() : "",
    id: typeof row[2] === "string" ? row[2] : ""
  });
  if (!parsed.success) return null;
  if (!parsed.data.id && !parsed.data.title) return null;
  return parsed.data;
}

function parseNotebook(row: unknown): Notebook {
  const summary = parseNotebookRow(row) ?? { id: "", title: "" };
  const sourcesCount = Array.isArray(row) && Array.isArray(row[1]) ? row[1].length : 0;
  const meta = Array.isArray(row) && Array.isArray(row[5]) ? row[5] : [];
  const createdAtValue = Array.isArray(meta[5]) ? meta[5][0] : null;
  const createdAt = typeof createdAtValue === "number" ? new Date(createdAtValue).toISOString() : null;
  return { ...summary, sourcesCount, createdAt, isOwner: meta[1] === undefined ? true : meta[1] === false };
}

function parseRequiredSource(row: unknown): Source {
  const source = parseSource(row);
  if (!source?.id) throw new Error("NotebookLM source response did not include source id");
  return source;
}

function parseSource(row: unknown): Source | null {
  const normalized = normalizeSourceRow(row);
  if (!normalized) return null;
  const metadata = Array.isArray(normalized[2]) ? normalized[2] : [];
  const statusBlock = Array.isArray(normalized[3]) ? normalized[3] : [];
  const statusCode = typeof statusBlock[0] === "number" ? statusBlock[0] : undefined;
  const typeCode = typeof metadata[4] === "number" ? metadata[4] : typeof normalized[10] === "number" ? normalized[10] : undefined;
  return {
    id: normalized[0],
    title: typeof normalized[1] === "string" ? normalized[1] : null,
    url: extractSourceUrl(metadata),
    type: typeCode !== undefined ? sourceTypeByCode[typeCode] ?? "unknown" : "unknown",
    status: statusCode !== undefined ? sourceStatusByCode[statusCode] ?? "unknown" : "ready"
  };
}

function normalizeSourceRow(row: unknown): [string, unknown, unknown?, unknown?, ...unknown[]] | null {
  if (!Array.isArray(row) || row.length === 0) return null;
  if (typeof row[0] === "string") return row as [string, unknown, unknown?, unknown?, ...unknown[]];
  if (Array.isArray(row[0]) && typeof row[0][0] === "string") return [row[0][0], row[1], row[2], row[3], ...row.slice(4)];
  if (Array.isArray(row[0]) && row[0][2] && Array.isArray(row[0][2]) && typeof row[0][2][0] === "string") return [row[0][2][0], row[1], row[2], row[3], ...row.slice(4)];
  return null;
}

function extractSourceUrl(metadata: unknown, allowBareHttp = true): string | null {
  if (!Array.isArray(metadata)) return null;
  const urlList = Array.isArray(metadata[7]) ? metadata[7] : [];
  if (typeof urlList[0] === "string") return urlList[0];
  const ytData = Array.isArray(metadata[5]) ? metadata[5] : [];
  if (typeof ytData[0] === "string") return ytData[0];
  if (allowBareHttp && typeof metadata[0] === "string" && metadata[0].startsWith("http")) return metadata[0];
  return null;
}

function extractYoutubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    if (host === "youtu.be") return validYoutubeId(parsed.pathname.slice(1));
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) return null;
    if (parsed.pathname === "/watch") return validYoutubeId(parsed.searchParams.get("v") ?? "");
    const match = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(parsed.pathname);
    return validYoutubeId(match?.[2] ?? "");
  } catch {
    return null;
  }
}

function validYoutubeId(id: string): string | null {
  const trimmed = id.trim();
  return /^[A-Za-z0-9_-]{6,}$/.test(trimmed) ? trimmed : null;
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractAllText(data: unknown[], maxDepth = 100): string[] {
  if (maxDepth <= 0) return [];
  const texts: string[] = [];
  for (const item of data) {
    if (typeof item === "string" && item) texts.push(item);
    else if (Array.isArray(item)) texts.push(...extractAllText(item, maxDepth - 1));
  }
  return texts;
}

function nestSourceIds(ids: string[], depth: number): unknown[] {
  if (depth < 1) throw new Error(`depth must be >= 1, got ${depth}`);
  if (ids.length === 0) return [];
  let result: unknown[] = [...ids];
  for (let i = 0; i < depth; i += 1) result = result.map((item) => [item]);
  return result;
}

function parseChatResponse(responseText: string): { answer: string; references: AskResult["references"] } {
  const chunks = parseNotebookLMResponse(responseText);
  let answer = "";
  let thinking = "";
  const references: AskResult["references"] = [];
  for (const chunk of chunks) {
    const extracted = extractChatChunk(chunk);
    if (extracted.text) {
      if (extracted.isAnswer && extracted.text.length > answer.length) answer = extracted.text;
      if (!extracted.isAnswer && extracted.text.length > thinking.length) thinking = extracted.text;
    }
    for (const sourceId of extracted.sourceIds) {
      if (!references.some((ref) => ref.sourceId === sourceId)) references.push({ sourceId, text: null, citationNumber: references.length + 1 });
    }
  }
  if (!answer) answer = thinking;
  if (!answer && chunks.length > 0) answer = JSON.stringify(chunks[0]);
  return { answer, references };
}

function extractChatChunk(chunk: unknown): { text: string | null; isAnswer: boolean; sourceIds: string[] } {
  const items = Array.isArray(chunk) && Array.isArray(chunk[0]) ? chunk : [chunk];
  for (const item of items) {
    if (!Array.isArray(item) || item[0] !== "wrb.fr" || typeof item[2] !== "string") continue;
    let inner: unknown;
    try {
      inner = JSON.parse(item[2]);
    } catch {
      continue;
    }
    const first = Array.isArray(inner) ? inner[0] : null;
    if (typeof first === "string") return { text: unwrapChatText(first), isAnswer: false, sourceIds: extractSourceIdStrings(inner) };
    if (!Array.isArray(first) || typeof first[0] !== "string") continue;
    const typeInfo = Array.isArray(first[4]) ? first[4] : [];
    return { text: unwrapChatText(first[0]), isAnswer: typeInfo.at(-1) === 1, sourceIds: extractSourceIdStrings(first) };
  }
  return { text: null, isAnswer: false, sourceIds: [] };
}

function unwrapChatText(text: string): string {
  let current = text;
  for (let i = 0; i < 5; i += 1) {
    const trimmed = current.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("\"")) return current;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const candidate = firstMeaningfulString(parsed);
      if (!candidate || candidate === current) return current;
      current = candidate;
    } catch {
      return current;
    }
  }
  return current;
}

function firstMeaningfulString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstMeaningfulString(item);
      if (found) return found;
    }
  }
  return null;
}

function extractSourceIdStrings(value: unknown): string[] {
  return extractStrings(value).filter((candidate) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate));
}

function extractStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(extractStrings);
  return [];
}

function isNoteRowLike(row: unknown): boolean {
  if (!Array.isArray(row) || row.length === 0) return false;
  return typeof row[0] === "string" || (row[0] === null && Array.isArray(row[1]) && typeof row[1][0] === "string");
}

function normalizeNoteRow(row: unknown): unknown[] | null {
  if (!isNoteRowLike(row) || !Array.isArray(row)) return null;
  if (typeof row[0] === "string") return row;
  const nested = row[1];
  return Array.isArray(nested) ? [nested[0], nested, ...row.slice(2)] : null;
}

function parseNote(row: unknown[], notebookId: string): Note | null {
  if (row[2] === 2 || row[1] === null) return null;
  const nested = Array.isArray(row[1]) ? row[1] : row;
  const content = typeof nested[1] === "string" ? nested[1] : "";
  if (content.trim().startsWith("{") && (content.includes("children") || content.includes("nodes"))) return null;
  const title = typeof nested[4] === "string" ? nested[4] : typeof nested[5] === "string" ? nested[5] : "";
  return typeof row[0] === "string" ? { id: row[0], notebookId, title, content } : null;
}

function parseArtifact(row: unknown): Artifact | null {
  if (!Array.isArray(row)) return null;
  const id = typeof row[0] === "string" ? row[0] : extractFirstString(row);
  if (!id) return null;
  const title = typeof row[1] === "string" ? row[1] : "";
  const typeCode = typeof row[2] === "number" ? row[2] : undefined;
  const statusCode = typeof row[4] === "number" ? row[4] : undefined;
  return { id, title, type: typeCode !== undefined ? artifactTypeByCode[typeCode] ?? "unknown" : "unknown", status: statusCode !== undefined ? artifactStatusByCode[statusCode] ?? "unknown" : "unknown", url: extractFirstUrl(row) };
}

function buildArtifactParams(notebookId: string, artifactType: string, sourceIds: string[], instructions: string | undefined, language: string, length: string): unknown[] {
  const typeCode = artifactTypeCodeByName[artifactType] ?? 2;
  const triple = nestSourceIds(sourceIds, 2);
  const double = nestSourceIds(sourceIds, 1);
  const lengthCode = length === "short" ? 1 : length === "long" ? 3 : 2;
  if (artifactType === "audio") return [[2], notebookId, [null, null, 1, triple, null, null, [null, [instructions ?? null, lengthCode, null, double, language, null, 1]]]];
  if (artifactType === "video") return [[2], notebookId, [null, null, 3, triple, null, null, null, null, [null, null, [double, language, instructions ?? null, null, 1, 1]]]];
  if (artifactType === "quiz") return [[2], notebookId, [null, null, 4, triple, null, null, null, null, null, [null, [2, null, instructions ?? null, null, null, null, null, [2, 2]]]]];
  if (artifactType === "flashcards") return [[2], notebookId, [null, null, 4, triple, null, null, null, null, null, [null, [1, null, instructions ?? null, null, null, null, [2, 2]]]]];
  if (artifactType === "slide_deck") return [[2], notebookId, [null, null, 8, triple, null, null, null, null, null, null, null, null, null, null, null, [[instructions ?? null, language, 1, lengthCode]]]];
  if (artifactType === "infographic") return [[2], notebookId, [null, null, 7, triple, null, null, null, null, null, null, null, null, null, null, [[instructions ?? null, language, null, 1, 2, 1]]]];
  if (artifactType === "data_table") return [[2], notebookId, [null, null, 9, triple, null, null, null, null, null, null, null, null, null, null, null, null, null, null, [null, [instructions ?? null, language]]]];
  return [[2], notebookId, [null, null, typeCode, triple, null, null, null, [null, [artifactType === "study_guide" ? "Study Guide" : "Briefing Doc", "Generated report", null, double, language, instructions ?? "Create a report based on the provided sources.", null, true]]]];
}

function parseResearchTask(row: unknown): ResearchTask | null {
  if (!Array.isArray(row) || typeof row[0] !== "string") return null;
  const detail = Array.isArray(row[1]) ? row[1] : [];
  const query = typeof detail[0] === "string" ? detail[0] : "";
  const statusCode = typeof detail[4] === "number" ? detail[4] : undefined;
  const sourcesRaw = Array.isArray(detail[3]) ? detail[3] : [];
  const sources = sourcesRaw.map((src): { title: string; url: string; type: string } | null => {
    if (!Array.isArray(src)) return null;
    const strings = extractStrings(src);
    const url = strings.find((value) => /^https?:\/\//.test(value));
    return url ? { title: strings.find((value) => value !== url) ?? "", url, type: "web" } : null;
  }).filter((src): src is { title: string; url: string; type: string } => src !== null);
  return { taskId: row[0], query, status: statusCode === 5 || statusCode === 6 ? "completed" : statusCode === 4 ? "failed" : "in_progress", sources };
}

function extractFirstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) for (const item of value) { const found = extractFirstString(item); if (found) return found; }
  if (value && typeof value === "object") for (const item of Object.values(value)) { const found = extractFirstString(item); if (found) return found; }
  return null;
}

function extractFirstUrl(value: unknown): string | null {
  return extractStrings(value).find((candidate) => /^https?:\/\//.test(candidate)) ?? null;
}

function isPublicShare(value: unknown): boolean {
  return extractStrings(value).some((candidate) => {
    const normalized = candidate.toUpperCase();
    return normalized === "ANYONE" || normalized === "PUBLIC" || normalized === "ANYONE_WITH_LINK";
  });
}

export function buildNotebookLMRpcResponse(rpcId: string, payload: unknown): string {
  const encodedPayload = payload === null ? null : JSON.stringify(payload);
  return `)]}'\n\n${JSON.stringify([["wrb.fr", rpcId, encodedPayload, null, null, null, "generic"]])}\n`;
}

export function decodeNotebookLMRpcRequest(body: string): { rpcId: string; params: unknown } {
  const fReq = new URLSearchParams(body).get("f.req");
  if (!fReq) throw new Error("missing f.req");
  const decoded = JSON.parse(fReq) as unknown;
  if (!Array.isArray(decoded)) throw new Error("invalid f.req");
  const inner = decoded[0]?.[0];
  if (!Array.isArray(inner) || typeof inner[0] !== "string" || typeof inner[1] !== "string") {
    throw new Error("invalid rpc request");
  }
  return { rpcId: inner[0], params: JSON.parse(inner[1]) };
}

export function parseNotebookLMResponse(responseText: string): unknown[] {
  const stripped = responseText.startsWith(")]}'") ? responseText.replace(/^\)\]\}'\r?\n/, "") : responseText;
  const chunks: unknown[] = [];
  const lines = stripped.trim().split("\n").map((line) => line.replace(/\r$/, ""));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (/^\d+$/.test(line) && i + 1 < lines.length) {
      i += 1;
      chunks.push(JSON.parse(lines[i] ?? "null"));
      continue;
    }
    chunks.push(JSON.parse(line));
  }
  return chunks;
}

function extractRpcResult(chunks: unknown[], rpcId: string, options: { allowNull?: boolean } = {}): unknown {
  let result: unknown;
  let sawNullPayload = false;
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    const items = Array.isArray(chunk[0]) ? chunk : [chunk];
    for (const item of items) {
      if (!Array.isArray(item) || item[0] !== "wrb.fr" || item[1] !== rpcId) continue;
      if (item[2] === null) {
        if (options.allowNull && result === undefined) result = null;
        else sawNullPayload = true;
        continue;
      }
      if (typeof item[2] === "string" && item[2]) result = JSON.parse(item[2]);
    }
  }
  if (result === undefined) {
    // A well-formed response whose RPC frame carries a null payload is batchexecute's
    // typical answer for a rejected/stale session or CSRF token.
    if (sawNullPayload) throw new NotebookLMError("NotebookLM returned an empty result", "upstream_null");
    throw new Error("NotebookLM response did not include expected RPC result");
  }
  return result;
}

// A Set-Cookie can delete a cookie with a nonempty value via Max-Age<=0 or a past
// Expires date; both must remove the jar entry regardless of the value carried.
function isExpiredSetCookie(attributes: string[]): boolean {
  // RFC 6265: a present *valid* Max-Age takes precedence over Expires. An invalid
  // Max-Age is ignored by browsers, so Expires still decides in that case.
  let maxAgeSeen = false;
  let expiresAt = Number.NaN;
  for (const attribute of attributes) {
    const [key, rawValue = ""] = attribute.split("=", 2);
    const name = key.trim().toLowerCase();
    const value = rawValue.trim();
    if (name === "max-age") {
      if (!/^-?\d+$/.test(value)) continue;
      maxAgeSeen = true;
      if (Number(value) <= 0) return true;
    } else if (name === "expires") {
      expiresAt = Date.parse(value);
    }
  }
  if (maxAgeSeen) return false;
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function isLoginUrl(responseUrl: string | undefined): boolean {
  if (!responseUrl) return false;
  try {
    const url = new URL(responseUrl);
    return url.hostname === "accounts.google.com" || /\/signin|\/ServiceLogin|\/InteractiveLogin/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isHtmlResponse(response: Response): boolean {
  return (response.headers?.get?.("content-type") ?? "").includes("text/html");
}

function looksLikeGoogleLogin(html: string): boolean {
  return html.includes("accounts.google.com/ServiceLogin") || html.includes("/signin/v2") || html.includes("/v3/signin");
}

function extractWizField(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`"${escaped}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`),
    new RegExp(`'${escaped}'\\s*:\\s*'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'`),
    new RegExp(`&quot;${escaped}&quot;\\s*:\\s*&quot;((?:(?!&quot;).)*)&quot;`)
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}
