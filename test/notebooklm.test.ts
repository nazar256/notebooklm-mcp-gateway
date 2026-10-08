import { describe, expect, it } from "vitest";
import { buildNotebookLMRpcResponse, decodeNotebookLMRpcRequest, NotebookLMClient, NotebookLMError } from "../src/notebooklm";

const bootstrapHtml = `<!doctype html><script>{"SNlM0e":"csrf-token","FdrFJe":"session-id"}</script>`;
const cookieHeader = "SID=safe-sid; __Secure-1PSID=safe-psid";
const notebookRow = ["Notebook One", null, "nb-1"];

describe("NotebookLMClient", () => {
  it("list notebooks still parses correctly", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, fetch: mockFetch(calls, {
      wXbhsf: [[notebookRow]]
    }) });

    await expect(client.listNotebooks()).resolves.toEqual([{ id: "nb-1", title: "Notebook One" }]);
    const rpc = decodeNotebookLMRpcRequest(calls[1]?.body ?? "");
    expect(rpc).toEqual({ rpcId: "wXbhsf", params: [null, 1, null, [2]] });
  });

  it("prefers fresh bootstrap values over copied batchexecute values", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, sessionId: "copied-session", csrfToken: "copied-csrf", fetch: mockFetch(calls, {
      wXbhsf: [[notebookRow]]
    }) });

    await expect(client.listNotebooks()).resolves.toEqual([{ id: "nb-1", title: "Notebook One" }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("f.sid=session-id");
    expect(new URLSearchParams(calls[1]?.body).get("at")).toBe("csrf-token");
  });

  it("adopts notebook.google.com when bootstrap redirects from notebooklm.google.com", async () => {
    const calls: Array<{ url: string; body?: string; origin?: string | null }> = [];
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      fetch: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : undefined;
        const headers = new Headers(init?.headers);
        calls.push({ url, body, origin: headers.get("origin") });
        if (url === "https://notebooklm.google.com/" || url.endsWith("notebooklm.google.com/")) {
          return {
            ok: true,
            status: 200,
            url: "https://notebook.google.com/",
            text: async () => bootstrapHtml
          } as Response;
        }
        const rpc = decodeNotebookLMRpcRequest(body ?? "");
        return new Response(buildNotebookLMRpcResponse(rpc.rpcId, [[notebookRow]]));
      }
    });

    await expect(client.listNotebooks()).resolves.toEqual([{ id: "nb-1", title: "Notebook One" }]);
    expect(calls[0]?.url).toBe("https://notebooklm.google.com/");
    expect(calls[1]?.url.startsWith("https://notebook.google.com/_/LabsTailwindUi/data/batchexecute")).toBe(true);
    expect(calls[1]?.origin).toBe("https://notebook.google.com");
  });

  it("falls back to copied batchexecute bootstrap values when fresh bootstrap cannot be parsed", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      sessionId: "copied-session",
      csrfToken: "copied-csrf",
      fetch: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url, body });
        if (url.endsWith("/")) return new Response("signed-in shell without WIZ fields");
        const rpc = decodeNotebookLMRpcRequest(body ?? "");
        return new Response(buildNotebookLMRpcResponse(rpc.rpcId, [[notebookRow]]));
      }
    });

    await expect(client.listNotebooks()).resolves.toEqual([{ id: "nb-1", title: "Notebook One" }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("f.sid=copied-session");
    expect(new URLSearchParams(calls[1]?.body).get("at")).toBe("copied-csrf");
  });

  it("validates authentication with the current list-notebooks request shape before replay fallback", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      sessionId: "copied-session",
      csrfToken: "copied-csrf",
      validationRpcId: "ozz5Z",
      validationFReq: JSON.stringify([[["ozz5Z", JSON.stringify([[[[null, "1", 627]]]]), null, "generic"]]]),
      fetch: mockFetch(calls, { wXbhsf: [[notebookRow]], ozz5Z: [[notebookRow]] })
    });

    await expect(client.validateAuthentication()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("rpcids=wXbhsf");
    expect(decodeNotebookLMRpcRequest(calls[1]?.body ?? "").rpcId).toBe("wXbhsf");
    expect(new URLSearchParams(calls[1]?.body).get("at")).toBe("csrf-token");
  });

  it("rename notebook sends expected RPC shape and returns normalized output", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, fetch: mockFetch(calls, {
      s0tc2d: ["New Title", null, "nb-1"]
    }) });

    await expect(client.renameNotebook({ notebookId: "nb-1", title: " New Title " })).resolves.toEqual({ id: "nb-1", title: "New Title" });
    const rpc = decodeNotebookLMRpcRequest(calls[1]?.body ?? "");
    expect(rpc).toEqual({ rpcId: "s0tc2d", params: ["nb-1", [[null, null, null, [null, "New Title"]]]] });
  });

  it("rename notebook falls back through list when upstream returns sparse result", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, fetch: mockFetch(calls, {
      s0tc2d: null,
      wXbhsf: [[["Fallback Title", null, "nb-1"]]]
    }) });

    await expect(client.renameNotebook({ notebookId: "nb-1", title: "Fallback Title" })).resolves.toEqual({ id: "nb-1", title: "Fallback Title" });
    expect(decodeNotebookLMRpcRequest(calls[1]?.body ?? "").rpcId).toBe("s0tc2d");
    expect(decodeNotebookLMRpcRequest(calls[3]?.body ?? "").rpcId).toBe("wXbhsf");
  });

  it("delete notebook verifies title, sends expected RPC shape, and returns deleted result", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, fetch: mockFetch(calls, {
      WWINqb: null,
      wXbhsf: [[notebookRow]],
      wXbhsf2: [[]]
    }) });

    await expect(client.deleteNotebook({ notebookId: "nb-1", confirm: true, expectedTitle: "Notebook One" })).resolves.toEqual({ deleted: true, notebookId: "nb-1" });
    const rpc = decodeNotebookLMRpcRequest(calls[3]?.body ?? "");
    expect(rpc).toEqual({ rpcId: "WWINqb", params: [["nb-1"], [2]] });
  });

  it("delete notebook rejects title mismatch before sending delete RPC", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, fetch: mockFetch(calls, {
      wXbhsf: [[notebookRow]]
    }) });

    await expect(client.deleteNotebook({ notebookId: "nb-1", confirm: true, expectedTitle: "Wrong Title" })).rejects.toThrow("title mismatch");
    expect(calls.map((call) => call.body ? decodeNotebookLMRpcRequest(call.body).rpcId : "bootstrap")).not.toContain("WWINqb");
  });

  it("delete notebook rejects missing confirm or expectedTitle before network calls", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, fetch: mockFetch(calls, {}) });

    await expect(client.deleteNotebook({ notebookId: "nb-1", expectedTitle: "Notebook One" } as never)).rejects.toThrow();
    await expect(client.deleteNotebook({ notebookId: "nb-1", confirm: true } as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("delete notebook rejects missing notebook before sending delete RPC", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, fetch: mockFetch(calls, {
      wXbhsf: [[]]
    }) });

    await expect(client.deleteNotebook({ notebookId: "nb-missing", confirm: true, expectedTitle: "Notebook One" })).rejects.toThrow("notebook not found");
    expect(calls.map((call) => call.body ? decodeNotebookLMRpcRequest(call.body).rpcId : "bootstrap")).not.toContain("WWINqb");
  });

  it("upstream errors are sanitized and do not leak cookie material", async () => {
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader: "SID=synthetic-cookie-value; __Secure-1PSID=synthetic-psid-value",
      fetch: async (input) => {
        if (String(input).endsWith("/")) return new Response(bootstrapHtml);
        return new Response("raw upstream body with synthetic-cookie-value", { status: 500 });
      }
    });

    await expect(client.listNotebooks()).rejects.toThrow("NotebookLM request failed");
    await expect(client.listNotebooks()).rejects.not.toThrow("synthetic-cookie-value");
  });

  it("covers expanded notebook/source/note/artifact/research/sharing RPC request shapes", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const sourceRow = ["src-1", "Example Source", [null, null, null, null, 5, null, null, ["https://example.com"]], [2]];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, sessionId: "copied-session", csrfToken: "copied-csrf", fetch: mockFetch(calls, {
      rLM1Ne: [["Notebook One", [sourceRow], "nb-1", null, null, [null, false, null, null, null, [1710000000000]]]],
      CCqFvf: ["Created Notebook", null, "nb-created"],
      izAoDd: sourceRow,
      tr032e: [[[null, ["Source summary"], [["keyword"]]]]],
      hizoJc: [[null, "Example Source", [null, null, null, null, null, null, null, ["https://example.com"]]], null, null, [["First paragraph", "Second paragraph"]]],
      FLmJqe: null,
      tGMBJ: null,
      cFji9: [["note-1", ["note-1", "Note body", [], 0, "Note Title"]]],
      CYK0Xb: "note-created",
      cYAfTb: null,
      AH0mwd: null,
      gArtLc: [[["artifact-1", "Study Guide", 2, null, 3, "https://example.com/artifact"]]],
      R7cb6c: "artifact-task-1",
      Krh3pd: ["https://example.com/export.pdf"],
      Ljjv0c: "research-task-1",
      e3bVqc: [[["research-task-1", ["query", null, null, [["Result", "https://example.com/result"]], 5]]]],
      LBwxtb: ["ok"],
      JFMDGd: ["ANYONE", "https://notebooklm.google.com/notebook/nb-1"],
      QDyure: null
    }) });

    await expect(client.getNotebook("nb-1")).resolves.toMatchObject({ id: "nb-1", title: "Notebook One", sourcesCount: 1 });
    await expect(client.createNotebook({ title: " Created Notebook " })).resolves.toEqual({ id: "nb-created", title: "Created Notebook" });
    await expect(client.listSources("nb-1")).resolves.toEqual([{ id: "src-1", title: "Example Source", url: "https://example.com", type: "web_page", status: "ready" }]);
    await expect(client.addUrlSource({ notebookId: "nb-1", url: "https://example.com" })).resolves.toMatchObject({ id: "src-1" });
    await expect(client.addUrlSource({ notebookId: "nb-1", url: "https://www.youtube.com/watch?v=abcdef12345" })).resolves.toMatchObject({ id: "src-1" });
    await expect(client.addTextSource({ notebookId: "nb-1", title: "Text", content: "Body" })).resolves.toMatchObject({ id: "src-1" });
    await expect(client.addDriveSource({ notebookId: "nb-1", fileId: "drive-file", title: "Drive" })).resolves.toMatchObject({ id: "src-1" });
    await expect(client.getSourceGuide({ notebookId: "nb-1", sourceId: "src-1" })).resolves.toEqual({ summary: "Source summary", keywords: ["keyword"] });
    await expect(client.getSourceContent({ notebookId: "nb-1", sourceId: "src-1" })).resolves.toMatchObject({ sourceId: "src-1", content: "First paragraph\nSecond paragraph" });
    await expect(client.refreshSource({ notebookId: "nb-1", sourceId: "src-1" })).resolves.toEqual({ refreshed: true, sourceId: "src-1" });
    await expect(client.deleteSource({ notebookId: "nb-1", sourceId: "src-1", confirm: true, expectedTitle: "Example Source" })).resolves.toEqual({ deleted: true, sourceId: "src-1" });
    await expect(client.listNotes("nb-1")).resolves.toEqual([{ id: "note-1", notebookId: "nb-1", title: "Note Title", content: "Note body" }]);
    await expect(client.createNote({ notebookId: "nb-1", title: "New Note", content: "New body" })).resolves.toEqual({ id: "note-created", notebookId: "nb-1", title: "New Note", content: "New body" });
    await expect(client.updateNote({ notebookId: "nb-1", noteId: "note-1", title: "Note Title", content: "Updated" })).resolves.toEqual({ updated: true, noteId: "note-1" });
    await expect(client.deleteNote({ notebookId: "nb-1", noteId: "note-1", confirm: true, expectedTitle: "Note Title" })).resolves.toEqual({ deleted: true, noteId: "note-1" });
    await expect(client.listArtifacts("nb-1")).resolves.toEqual([{ id: "artifact-1", title: "Study Guide", type: "report", status: "completed", url: "https://example.com/artifact" }]);
    await expect(client.generateArtifact({ notebookId: "nb-1", artifactType: "study_guide", sourceIds: ["src-1"] })).resolves.toEqual({ taskId: "artifact-task-1", artifactId: "artifact-task-1", status: "in_progress" });
    await expect(client.exportArtifact({ notebookId: "nb-1", artifactId: "artifact-1" })).resolves.toMatchObject({ artifactId: "artifact-1", exportUrl: "https://example.com/export.pdf" });
    await expect(client.startResearch({ notebookId: "nb-1", query: "query" })).resolves.toEqual({ taskId: "research-task-1", status: "started" });
    const researchCall = calls.find((call) => call.body && decodeNotebookLMRpcRequest(call.body).rpcId === "Ljjv0c");
    expect(decodeNotebookLMRpcRequest(researchCall?.body ?? "").params).toEqual([["query", 1], null, 1, "nb-1"]);
    await expect(client.pollResearch({ notebookId: "nb-1" })).resolves.toEqual({ tasks: [{ taskId: "research-task-1", query: "query", status: "completed", sources: [{ title: "Result", url: "https://example.com/result", type: "web" }] }] });
    await expect(client.importResearch({ notebookId: "nb-1", taskId: "research-task-1", sources: [{ title: "Result", url: "https://example.com/result" }] })).resolves.toMatchObject({ imported: true });
    await expect(client.getShareStatus("nb-1")).resolves.toMatchObject({ notebookId: "nb-1", isPublic: true });
    await expect(client.setSharePublic({ notebookId: "nb-1", public: false, confirm: true })).resolves.toMatchObject({ notebookId: "nb-1", isPublic: true });

    expect(calls.filter((call) => call.body).map((call) => decodeNotebookLMRpcRequest(call.body ?? "").rpcId)).toEqual([
      "rLM1Ne", "CCqFvf", "rLM1Ne", "izAoDd", "izAoDd", "izAoDd", "izAoDd", "tr032e", "hizoJc", "FLmJqe", "rLM1Ne", "tGMBJ", "cFji9", "CYK0Xb", "cYAfTb", "cYAfTb", "cFji9", "AH0mwd", "gArtLc", "R7cb6c", "Krh3pd", "Ljjv0c", "e3bVqc", "LBwxtb", "JFMDGd", "QDyure", "JFMDGd"
    ]);
  });

  it("getShareStatus does not infer public access from unrelated numeric values", async () => {
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, fetch: mockFetch([], {
      JFMDGd: ["PRIVATE", 2, "not a public access marker"]
    }) });

    await expect(client.getShareStatus("nb-1")).resolves.toMatchObject({ notebookId: "nb-1", isPublic: false });
  });

  it("covers chat and conversation RPCs without persisting conversation state", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader, sessionId: "copied-session", csrfToken: "copied-csrf", fetch: async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, body });
      if (url.includes("GenerateFreeFormStreamed")) return new Response(buildNotebookLMRpcResponse("chat", ["Answer text", "12345678-1234-1234-1234-123456789abc"]));
      const rpc = decodeNotebookLMRpcRequest(body ?? "");
      const payloads: Record<string, unknown> = {
        hPTbtc: [[["conversation-1"]]],
        khqZz: [["turn-1", "Question", "Answer"]]
      };
      return new Response(buildNotebookLMRpcResponse(rpc.rpcId, payloads[rpc.rpcId]));
    } });

    await expect(client.askNotebook({ notebookId: "nb-1", question: "Question?", sourceIds: ["src-1"], conversationId: "conversation-1" })).resolves.toMatchObject({ answer: expect.stringContaining("Answer text"), conversationId: "conversation-1" });
    await expect(client.getLastConversationId("nb-1")).resolves.toBe("conversation-1");
    await expect(client.getConversationTurns({ notebookId: "nb-1", conversationId: "conversation-1" })).resolves.toEqual({ turns: [["turn-1", "Question", "Answer"]] });
    const chatCall = calls.find((call) => call.url.includes("GenerateFreeFormStreamed"));
    expect(chatCall?.url).toContain("GenerateFreeFormStreamed");
    const chatFReq = new URLSearchParams(chatCall?.body ?? "").get("f.req");
    const chatParams = JSON.parse(JSON.parse(chatFReq ?? "[]")[1]);
    expect(chatParams[0]).toEqual([[["src-1"]]]);
    expect(calls.filter((call) => call.body && !call.url.includes("GenerateFreeFormStreamed")).map((call) => decodeNotebookLMRpcRequest(call.body ?? "").rpcId)).toEqual(["hPTbtc", "khqZz"]);
  });

  it("generateArtifact survives multi-chunk response with trailing null", async () => {
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      sessionId: "copied-session",
      csrfToken: "copied-csrf",
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/")) return new Response(bootstrapHtml);
        // Simulate batchexecute returning two result lines: first with task ID, second with null
        const chunk1 = JSON.stringify([["wrb.fr", "R7cb6c", JSON.stringify("task-id-survives"), null, null, null, "generic"]]);
        const chunk2 = JSON.stringify([["wrb.fr", "R7cb6c", null, null, null, null, "generic"]]);
        return new Response(`)]}'\n\n${chunk1}\n${chunk2}\n`);
      }
    });

    await expect(client.generateArtifact({
      notebookId: "nb-1",
      artifactType: "audio",
      sourceIds: ["src-1"],
      instructions: "Test",
      language: "en"
    })).resolves.toEqual({ taskId: "task-id-survives", artifactId: "task-id-survives", status: "in_progress" });
  });

  it("generateArtifact returns failed when all chunks are null", async () => {
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      sessionId: "copied-session",
      csrfToken: "copied-csrf",
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/")) return new Response(bootstrapHtml);
        return new Response(buildNotebookLMRpcResponse("R7cb6c", null));
      }
    });

    await expect(client.generateArtifact({
      notebookId: "nb-1",
      artifactType: "audio",
      sourceIds: ["src-1"]
    })).resolves.toEqual({ taskId: "", artifactId: null, status: "failed" });
  });

  it("generateArtifact for audio uses expected param shape", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      fetch: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url, body });
        if (url.endsWith("/")) return new Response(bootstrapHtml);
        return new Response(buildNotebookLMRpcResponse("R7cb6c", "audio-task-1"));
      }
    });

    await client.generateArtifact({
      notebookId: "nb-1",
      artifactType: "audio",
      sourceIds: ["src-1"],
      instructions: "Test instructions",
      language: "Russian",
      length: "long"
    });

    // First fetch: bootstrap, second: RPC call
    const rpcCall = calls[1];
    expect(rpcCall?.url).toContain("rpcids=R7cb6c");
    const rpc = decodeNotebookLMRpcRequest(rpcCall?.body ?? "");
    expect(rpc.rpcId).toBe("R7cb6c");
    const params = rpc.params as unknown[];
    expect(params[0]).toEqual([2]);
    expect(params[1]).toBe("nb-1");
    const inner = params[2] as unknown[];
    expect(inner[2]).toBe(1); // audio typeCode
    expect(inner[3]).toEqual([[["src-1"]]]);
    const paramsJson = JSON.stringify(params);
    expect(paramsJson).toContain("Test instructions");
    expect(paramsJson).toContain("Russian");
    // length "long" = 3, default "medium" = 2
    const config = inner[6] as unknown[];
    const configInner = (config[1] as unknown[]) ?? [];
    expect(configInner[1]).toBe(3); // lengthCode for long
  });

  it("generateArtifact defaults to medium length for audio", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      fetch: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url, body });
        if (url.endsWith("/")) return new Response(bootstrapHtml);
        return new Response(buildNotebookLMRpcResponse("R7cb6c", "audio-task-default"));
      }
    });

    await client.generateArtifact({
      notebookId: "nb-1",
      artifactType: "audio",
      sourceIds: ["src-1"]
    });

    const rpcCall = calls[1];
    const rpc = decodeNotebookLMRpcRequest(rpcCall?.body ?? "");
    const params = rpc.params as unknown[];
    const inner = params[2] as unknown[];
    const config = inner[6] as unknown[];
    const configInner = (config[1] as unknown[]) ?? [];
    expect(configInner[1]).toBe(2); // default medium length
  });

  it("merges rotated Set-Cookie session cookies into subsequent upstream requests", async () => {
    const calls: Array<{ url: string; cookie: string | null }> = [];
    const bootstrapHeaders = new Headers();
    bootstrapHeaders.append("set-cookie", "__Secure-1PSIDTS=rotated-ts; Expires=Thu, 01 Jan 2032 00:00:00 GMT; Path=/; Secure; HttpOnly");
    bootstrapHeaders.append("set-cookie", "SIDCC=rotated-sidcc; Path=/");
    bootstrapHeaders.append("set-cookie", "unrelated_tracker=x; Path=/");
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader: "SID=sid-test; __Secure-1PSID=psid-test",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, cookie: new Headers(init?.headers).get("cookie") });
        if (url.endsWith("/")) return new Response(bootstrapHtml, { headers: bootstrapHeaders });
        const rpc = decodeNotebookLMRpcRequest(typeof init?.body === "string" ? init.body : "");
        return new Response(buildNotebookLMRpcResponse(rpc.rpcId, [[notebookRow]]));
      }
    });

    await expect(client.listNotebooks()).resolves.toEqual([{ id: "nb-1", title: "Notebook One" }]);
    const rpcCookie = calls[1]?.cookie ?? "";
    expect(rpcCookie).toContain("SID=sid-test");
    expect(rpcCookie).toContain("__Secure-1PSIDTS=rotated-ts");
    expect(rpcCookie).toContain("SIDCC=rotated-sidcc");
    expect(rpcCookie).not.toContain("unrelated_tracker");

    // getCookieHeader exposes the merged snapshot for envelope refresh.
    expect(client.getCookieHeader()).toContain("__Secure-1PSIDTS=rotated-ts");
    expect(client.getCookieHeader()).toContain("__Secure-1PSID=psid-test");
  });

  it("refreshCookies captures Set-Cookie rotation from an authenticated RPC, not only the shell", async () => {
    const rpcHeaders = new Headers();
    rpcHeaders.append("set-cookie", "SIDCC=rotated-by-rpc; Path=/");
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader: "SID=sid-test; SIDCC=old-sidcc",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/")) return new Response(bootstrapHtml);
        const rpc = decodeNotebookLMRpcRequest(typeof init?.body === "string" ? init.body : "");
        return new Response(buildNotebookLMRpcResponse(rpc.rpcId, [[notebookRow]]), { headers: rpcHeaders });
      }
    });

    await client.refreshCookies();
    expect(client.getCookieHeader()).toContain("SIDCC=rotated-by-rpc");
    expect(client.getCookieHeader()).toContain("SID=sid-test");
  });

  it("drops cookies deleted upstream via Max-Age=0 instead of persisting the dead value", async () => {
    const calls: Array<{ url: string; cookie: string | null }> = [];
    const bootstrapHeaders = new Headers();
    bootstrapHeaders.append("set-cookie", "SIDCC=dead-but-nonempty; Max-Age=0; Path=/");
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader: "SID=sid-test; SIDCC=old-sidcc; 1P_JAR=keep-pasted",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, cookie: new Headers(init?.headers).get("cookie") });
        if (url.endsWith("/")) return new Response(bootstrapHtml, { headers: bootstrapHeaders });
        const rpc = decodeNotebookLMRpcRequest(typeof init?.body === "string" ? init.body : "");
        return new Response(buildNotebookLMRpcResponse(rpc.rpcId, [[notebookRow]]));
      }
    });

    await client.listNotebooks();
    const rpcCookie = calls[1]?.cookie ?? "";
    expect(rpcCookie).not.toContain("SIDCC");
    expect(rpcCookie).toContain("1P_JAR=keep-pasted");
    expect(client.getCookieHeader()).not.toContain("SIDCC");
    expect(client.getCookieHeader()).toContain("1P_JAR=keep-pasted");
  });

  it("refreshCookies keeps the original jar when the session is expired instead of foreign sign-in cookies", async () => {
    const loginHeaders = new Headers();
    loginHeaders.append("set-cookie", "SIDCC=foreign-account-sidcc; Path=/");
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader: "SID=sid-test; SIDCC=old-sidcc",
      fetch: async () => new Response('<html><form action="https://accounts.google.com/ServiceLogin"></form></html>', { headers: loginHeaders })
    });

    await client.refreshCookies();
    expect(client.getCookieHeader()).toContain("SIDCC=old-sidcc");
    expect(client.getCookieHeader()).not.toContain("foreign-account-sidcc");
  });

  it("reports auth_expired when bootstrap redirects to Google sign-in instead of using stale copied values", async () => {
    const calls: Array<{ url: string }> = [];
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      sessionId: "copied-session",
      csrfToken: "copied-csrf",
      fetch: async (input) => {
        calls.push({ url: String(input) });
        return { ok: true, status: 200, url: "https://accounts.google.com/ServiceLogin?continue=x", text: async () => "<html>sign in</html>" } as Response;
      }
    });

    const error = await client.listNotebooks().catch((e) => e);
    expect(error).toBeInstanceOf(NotebookLMError);
    expect((error as NotebookLMError).stage).toBe("auth_expired");
    // No doomed RPC was attempted with stale copied bootstrap values.
    expect(calls).toHaveLength(1);
  });

  it("reports auth_expired when bootstrap HTML is a Google login page", async () => {
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      sessionId: "copied-session",
      csrfToken: "copied-csrf",
      fetch: async () => new Response('<html><form action="https://accounts.google.com/ServiceLogin"></form></html>')
    });

    const error = await client.listNotebooks().catch((e) => e);
    expect((error as NotebookLMError).stage).toBe("auth_expired");
  });

  it("reports auth_expired when batchexecute returns an HTML login response", async () => {
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      fetch: async (input) => {
        if (String(input).endsWith("/")) return new Response(bootstrapHtml);
        return new Response("<html>login</html>", { headers: { "content-type": "text/html;charset=UTF-8" } });
      }
    });

    const error = await client.listNotebooks().catch((e) => e);
    expect((error as NotebookLMError).stage).toBe("auth_expired");
  });

  it("reports upstream_null when a required RPC returns a null payload", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      fetch: mockFetch(calls, { rLM1Ne: null })
    });

    const error = await client.getNotebook("nb-1").catch((e) => e);
    expect(error).toBeInstanceOf(NotebookLMError);
    expect((error as NotebookLMError).stage).toBe("upstream_null");
  });

  it("keeps allowNull RPCs returning empty success on null payloads", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      fetch: mockFetch(calls, { gArtLc: null })
    });

    await expect(client.listArtifacts("nb-1")).resolves.toEqual([]);
  });

  it("uses the live boq build label from bootstrap for the chat endpoint", async () => {
    const calls: Array<{ url: string }> = [];
    const html = `<!doctype html><script>{"SNlM0e":"csrf-token","FdrFJe":"session-id","cfb2h":"boq_labs-tailwind-frontend_29990101.01_p0"}</script>`;
    const client = new NotebookLMClient({
      baseUrl: "https://notebooklm.google.com",
      cookieHeader,
      fetch: async (input) => {
        calls.push({ url: String(input) });
        if (String(input).endsWith("/")) return new Response(html);
        return new Response(")]}'\n\n[]\n");
      }
    });

    await client.askNotebook({ notebookId: "nb-1", question: "hi", sourceIds: ["src-1"], conversationId: "conv-1" });
    expect(calls[1]?.url).toContain("bl=boq_labs-tailwind-frontend_29990101.01_p0");
  });
});

function mockFetch(calls: Array<{ url: string; body?: string }>, payloads: Record<string, unknown>): typeof fetch {
  const callCounts: Record<string, number> = {};
  return async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, body });
    if (url.endsWith("/")) return new Response(bootstrapHtml);
    const rpc = decodeNotebookLMRpcRequest(body ?? "");
    callCounts[rpc.rpcId] = (callCounts[rpc.rpcId] ?? 0) + 1;
    const key = callCounts[rpc.rpcId] > 1 ? `${rpc.rpcId}${callCounts[rpc.rpcId]}` : rpc.rpcId;
    return new Response(buildNotebookLMRpcResponse(rpc.rpcId, payloads[key] ?? payloads[rpc.rpcId]));
  };
}
