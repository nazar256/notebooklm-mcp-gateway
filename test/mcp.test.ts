import { describe, expect, it } from "vitest";
import { env, fetchWorker, issueAccessToken, sampleCookie } from "./helpers";

const readTools = ["download_artifact", "get_conversation_turns", "get_last_conversation_id", "get_notebook", "get_share_status", "get_source_content", "get_source_guide", "list_artifacts", "list_notebooks", "list_notes", "list_sources", "poll_research"];
const chatTools = ["ask_notebook", "generate_artifact", "start_research"];
const writeTools = ["add_drive_source", "add_text_source", "add_url_source", "add_youtube_source", "create_note", "create_notebook", "import_research_sources", "refresh_source", "rename_notebook", "update_note"];
const deleteTools = ["delete_note", "delete_notebook", "delete_source"];
const shareTools = ["set_share_public"];

async function toolsForScope(scope: string): Promise<string[]> {
  const token = await issueAccessToken(scope);
  const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} }) });
  const body = await response.json() as { result?: { tools?: Array<{ name: string }> } };
  expect(response.status).toBe(200);
  return body.result?.tools?.map((tool) => tool.name).sort() ?? [];
}

describe("MCP", () => {
  it("unauthenticated /mcp returns 401 with WWW-Authenticate", async () => {
    const response = await fetchWorker("/mcp", { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });

  it("unsupported MCP methods fail cleanly", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "GET", headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(405);
  });

  it("invalid MCP bearer token returns a bearer invalid_token challenge", async () => {
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: "Bearer not-a-token" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("oversized MCP JSON bodies are rejected", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "add_text_source", arguments: { notebookId: "nb-1", title: "Large", content: "x".repeat(1_000_000) } } }) });
    expect(response.status).toBe(413);
  });

  it("authenticated /mcp can list tools", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    const body = await response.json() as { result?: { tools?: Array<{ name: string }> } };
    expect(response.status).toBe(200);
    expect(body.result?.tools?.map((tool) => tool.name).sort()).toEqual([...readTools, ...chatTools, ...writeTools, ...deleteTools, ...shareTools].sort());
  });

  it("read-only token lists exactly the read tools and can call list_notebooks", async () => {
    const token = await issueAccessToken("notebooklm:read");
    const listed = await toolsForScope("notebooklm:read");
    expect(listed).toEqual(readTools);
    for (const excluded of [...chatTools, ...writeTools, ...deleteTools, ...shareTools]) expect(listed).not.toContain(excluded);

    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "list_notebooks", arguments: {} } }) });
    const body = await response.json() as { result?: { structuredContent?: unknown; isError?: boolean } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual({ notebooks: [{ id: "nb-1", title: "Notebook One" }] });
  });

  it("read-only token cannot call write, delete, or share tools", async () => {
    const token = await issueAccessToken("notebooklm:read");
    for (const params of [
      { name: "rename_notebook", arguments: { notebookId: "nb-1", title: "Renamed Notebook" } },
      { name: "delete_notebook", arguments: { notebookId: "nb-1", confirm: true, expectedTitle: "Notebook One" } },
      { name: "set_share_public", arguments: { notebookId: "nb-1", public: true, confirm: true } }
    ]) {
      const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/call", params }) });
      const body = await response.json() as { error?: unknown; result?: { isError?: boolean; structuredContent?: unknown } };
      expect(response.status).toBe(200);
      expect(body.result?.structuredContent).toBeUndefined();
      expect(JSON.stringify(body)).toContain("not found");
    }
  });

  it("additional scoped tokens expose only their mapped tools", async () => {
    expect(await toolsForScope("notebooklm:read notebooklm:chat")).toEqual([...readTools, ...chatTools].sort());
    expect(await toolsForScope("notebooklm:read notebooklm:write")).toEqual([...readTools, ...writeTools].sort());
    expect(await toolsForScope("notebooklm:read notebooklm:delete")).toEqual([...readTools, ...deleteTools].sort());
    expect(await toolsForScope("notebooklm:read notebooklm:share")).toEqual([...readTools, ...shareTools].sort());
  });

  it("expanded tools advertise descriptions, schemas, and destructive annotations", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }) });
    const body = await response.json() as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: Record<string, unknown> }> } };
    const tools = body.result?.tools ?? [];
    expect(tools).toHaveLength(29);
    for (const tool of tools) {
      expect(tool.description).toEqual(expect.any(String));
      expect(String(tool.description).length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
    }
    for (const rawlessName of ["download_artifact", "import_research_sources", "get_share_status", "set_share_public"]) {
      const tool = tools.find((candidate) => candidate.name === rawlessName);
      expect(JSON.stringify(tool?.outputSchema)).not.toContain('"raw"');
    }
    for (const destructiveName of ["delete_notebook", "delete_source", "delete_note", "set_share_public"]) {
      const tool = tools.find((candidate) => candidate.name === destructiveName);
      expect(tool?.annotations?.destructiveHint).toBe(true);
      expect(JSON.stringify(tool?.inputSchema)).toContain("confirm");
    }
    expect(JSON.stringify(tools.find((candidate) => candidate.name === "delete_notebook")?.inputSchema)).toContain("expectedTitle");
  });

  it("mocked list_notebooks returns structuredContent matching schema exactly", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_notebooks", arguments: {} } }) });
    const body = await response.json() as { result?: { structuredContent?: unknown; isError?: boolean } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual({ notebooks: [{ id: "nb-1", title: "Notebook One" }] });
  });

  it("tool failures are returned as MCP errors, not success payloads", async () => {
    const token = await issueAccessToken();
    const failingEnv = { ...env, MOCK_NOTEBOOKLM_LIST_JSON: "not json" };
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_notebooks", arguments: {} } }) }, failingEnv);
    const body = await response.json() as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toBeUndefined();
  });

  it("rename_notebook validates bad input", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "rename_notebook", arguments: { notebookId: "", title: "" } } }) });
    const body = await response.json() as { result?: { isError?: boolean } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
  });

  it("rename_notebook success structuredContent matches schema", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rename_notebook", arguments: { notebookId: "nb-1", title: "Renamed Notebook" } } }) });
    const body = await response.json() as { result?: { structuredContent?: unknown; isError?: boolean } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual({ notebook: { id: "nb-1", title: "Renamed Notebook" } });
  });

  it("delete_notebook validates bad input", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delete_notebook", arguments: { notebookId: "", confirm: true, expectedTitle: "Notebook One" } } }) });
    const body = await response.json() as { result?: { isError?: boolean } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
  });

  it("delete_notebook requires confirm and expectedTitle", async () => {
    const token = await issueAccessToken();
    for (const args of [{ notebookId: "nb-1", expectedTitle: "Notebook One" }, { notebookId: "nb-1", confirm: true }]) {
      const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "delete_notebook", arguments: args } }) });
      const body = await response.json() as { result?: { isError?: boolean } };
      expect(response.status).toBe(200);
      expect(body.result?.isError).toBe(true);
    }
  });

  it("delete_notebook success structuredContent matches schema", async () => {
    const token = await issueAccessToken();
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "delete_notebook", arguments: { notebookId: "nb-1", confirm: true, expectedTitle: "Notebook One" } } }) });
    const body = await response.json() as { result?: { structuredContent?: unknown; isError?: boolean } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual({ deleted: true, notebookId: "nb-1" });
  });

  it("mutation failures return MCP errors, not success payloads", async () => {
    const token = await issueAccessToken();
    const failingEnv = { ...env, MOCK_NOTEBOOKLM_RENAME_JSON: "not json" };
    const response = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "rename_notebook", arguments: { notebookId: "nb-1", title: "Renamed" } } }) }, failingEnv);
    const body = await response.json() as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toBeUndefined();
  });

  it("logs/errors do not contain sample cookie values", async () => {
    const response = await fetchWorker("/authorize", { method: "POST", body: new URLSearchParams({ artifact: sampleCookie }) });
    const text = await response.text();
    expect(text).not.toContain("sid-test-value");
    expect(text).not.toContain("psid-test-value");
  });
});
