import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookLMClient, buildNotebookLMRpcResponse, decodeNotebookLMRpcRequest } from "../src/notebooklm";
import { parseNotebookLMAuthArtifact } from "../src/authArtifact";

const baseUrl = "https://notebooklm.google.com";
const html = '<script>{"SNlM0e":"csrf","FdrFJe":"session"}</script>';
const expired = ")]}'\n" + JSON.stringify([["wrb.fr", "wXbhsf", null, null, null, [16], "generic"]]);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded authentication recovery", () => {
  it("refreshes and retries a decoded UNAUTHENTICATED read once", async () => {
    let rpc = 0; let rotated = false;
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s; OSID=o", fetch: async (input) => {
      const url = String(input);
      if (url.includes("RotateCookies")) { rotated = true; return new Response('[["identity.hfcr",600]]', { headers: { "set-cookie": "__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure" } }); }
      if (url.includes("batchexecute")) { rpc++; return new Response(rotated ? buildNotebookLMRpcResponse("wXbhsf", [[]]) : expired); }
      return new Response(html);
    } });
    await expect(client.listNotebooks()).resolves.toEqual([]); expect(rpc).toBe(2);
  });
  it("never replays a mutation after an ambiguous null or HTML response", async () => {
    for (const htmlFailure of [false, true]) {
      let mutations = 0;
      const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s; OSID=o", fetch: async (input) => {
        if (String(input).includes("batchexecute")) { mutations++; return htmlFailure ? new Response("login", { headers: { "content-type": "text/html" } }) : new Response(buildNotebookLMRpcResponse("CCqFvf", null)); }
        return new Response(html);
      } });
      await expect(client.createNotebook({ title: "test" })).rejects.toBeDefined();
      expect(mutations).toBe(1);
    }
  });
  it("does not treat permission-denied nulls as successful empty mutations", async () => {
    let calls = 0;
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", fetch: async input => {
      if (!String(input).includes("batchexecute")) return new Response(html);
      calls++; return new Response(")]}'\n" + JSON.stringify([["wrb.fr", "FLmJqe", null, null, null, [7], "generic"]]));
    } });
    await expect(client.refreshSource({ notebookId: "n", sourceId: "s" })).rejects.toMatchObject({ stage: "access_denied" });
    expect(calls).toBe(1);
  });
  it("never executes the RPC copied from the browser as an auth fallback", async () => {
    const ids: string[] = [];
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", validationRpcId: "CCqFvf", validationFReq: '[[["CCqFvf","[\"MUTATION\"]",null,"generic"]]]', fetch: async (input, init) => {
      if (!String(input).includes("batchexecute")) return new Response(html);
      ids.push(decodeNotebookLMRpcRequest(String(init?.body)).rpcId);
      return new Response(expired);
    } });
    await expect(client.validateAuthentication()).rejects.toMatchObject({ stage: "auth_expired" });
    expect(ids).toEqual(["wXbhsf", "wXbhsf"]);
  });
  it("carries authuser to bootstrap and RPC and decodes escaped WIZ tokens", async () => {
    const urls: string[] = []; let token = "";
    const envelope = parseNotebookLMAuthArtifact("curl 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?authuser=2' -b 'SID=s'");
    const client = new NotebookLMClient({ ...envelope, fetch: async (input, init) => {
      urls.push(String(input));
      if (String(input).includes("batchexecute")) { token = new URLSearchParams(String(init?.body)).get("at")!; return new Response(buildNotebookLMRpcResponse("wXbhsf", [[]])); }
      return new Response('<script>{"SNlM0e":"csrf\\u003atoken","FdrFJe":"session"}</script>');
    } });
    await client.listNotebooks();
    expect(urls.every((url) => new URL(url).searchParams.get("authuser") === "2")).toBe(true);
    expect(token).toBe("csrf:token");
  });
  it("classifies a signed-out tokenless shell through /login", async () => {
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", fetch: async input => String(input).includes("/login")
      ? new Response('<form action="https://accounts.google.com/ServiceLogin"></form>') : new Response("tokenless app") });
    await expect(client.listNotebooks()).rejects.toMatchObject({ reason: "google_login" });
  });
  it("preserves a device challenge returned by the tokenless-shell probe", async () => {
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", fetch: async input => String(input).includes("/login")
      ? new Response("", { status: 401, headers: { "Sec-Session-Google-Challenge": "private-proof" } }) : new Response("tokenless app") });
    await expect(client.listNotebooks()).rejects.toMatchObject({ stage: "auth_challenge", reason: "device_bound_challenge" });
  });
  it("refuses an external redirect before sending cookies to it", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/?SECRET" } }));
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=SECRET", fetch });
    await expect(client.listNotebooks()).rejects.toMatchObject({ reason: "redirect_blocked" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("recognizes a CookieMismatch bridge before its support-page redirect", async () => {
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", fetch: async () => new Response(null, { status: 302, headers: { location: "https://accounts.google.com/CookieMismatch?SECRET" } }) });
    await expect(client.listNotebooks()).rejects.toMatchObject({ stage: "cookie_mismatch" });
  });
  it("bounds a hung response body as well as connection establishment", async () => {
    vi.useFakeTimers();
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", fetch: async (_input, init) => new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
    } })) });
    const check = expect(client.listNotebooks()).rejects.toMatchObject({ stage: "upstream_timeout" });
    await vi.advanceTimersByTimeAsync(30_001); await check;
  });
  it("obtains chat bootstrap after the conversation lookup and its possible recovery", async () => {
    let bootstrap = 0; let chatToken = ""; let lookups = 0;
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("GenerateFreeFormStreamed")) { chatToken = new URLSearchParams(String(init?.body)).get("at")!; return new Response(buildNotebookLMRpcResponse("chat", [["answer"]])); }
      if (url.includes("batchexecute")) return new Response(++lookups === 1
        ? ")]}'\n" + JSON.stringify([["wrb.fr", "hPTbtc", null, null, null, [16], "generic"]]) : buildNotebookLMRpcResponse("hPTbtc", []));
      bootstrap++; return new Response(`<script>{"SNlM0e":"csrf-${bootstrap}","FdrFJe":"session-${bootstrap}"}</script>`);
    } });
    await client.askNotebook({ notebookId: "n", question: "fixture", sourceIds: [] });
    expect(lookups).toBe(2); expect(bootstrap).toBe(3); expect(chatToken).toBe(`csrf-${bootstrap}`);
  });
  it("does not present streamed authentication or permission failures as answers or replay the prompt", async () => {
    for (const [code, stage] of [[16, "auth_expired"], [7, "access_denied"]] as const) {
      let prompts = 0;
      const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", fetch: async input => {
        if (String(input).includes("GenerateFreeFormStreamed")) { prompts++; return new Response(")]}'\n" + JSON.stringify([["wrb.fr", null, null, null, null, [code], "generic"]])); }
        return new Response(html);
      } });
      await expect(client.askNotebook({ notebookId: "n", question: "fixture", sourceIds: [], conversationId: "c" })).rejects.toMatchObject({ stage, rpcStatus: code });
      expect(prompts).toBe(1);
    }
  });
  it("allows a generated answer to take longer than the rotation timeout", async () => {
    vi.useFakeTimers(); let prompts = 0;
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s", fetch: async (input, init) => {
      if (!String(input).includes("GenerateFreeFormStreamed")) return new Response(html);
      prompts++;
      return new Response(new ReadableStream({ start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        setTimeout(() => { controller.enqueue(new TextEncoder().encode(buildNotebookLMRpcResponse("chat", [["answer"]]))); controller.close(); }, 20_000);
      } }));
    } });
    const check = expect(client.askNotebook({ notebookId: "n", question: "fixture", sourceIds: [], conversationId: "c" })).resolves.toMatchObject({ answer: "answer" });
    await vi.advanceTimersByTimeAsync(20_001); await check; expect(prompts).toBe(1);
  });
  it("retains and checkpoints an accepted rotation header when its response body times out", async () => {
    vi.useFakeTimers(); const checkpoint = vi.fn(async () => {});
    const client = new NotebookLMClient({ baseUrl, cookieHeader: "SID=s; OSID=o", onRotation: checkpoint, fetch: async (_input, init) =>
      new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); } }),
        { headers: { "set-cookie": "__Secure-1PSIDTS=accepted; Domain=.google.com; Path=/; Secure" } }) });
    const pending = client.rotateCookies();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toMatchObject({ result: "failed", detail: "timeout" });
    expect(client.getCookieHeader()).toContain("__Secure-1PSIDTS=accepted");
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });
});
