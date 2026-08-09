import { describe, expect, it } from "vitest";
import { parseNotebookLMAuthArtifact, safeArtifactReport } from "../src/authArtifact";
import { sampleCookie } from "./helpers";

describe("auth artifact parser", () => {
  it("parses Copy-as-cURL with single-quoted -H cookie", () => {
    const parsed = parseNotebookLMAuthArtifact(`curl 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute' -H 'cookie: ${sampleCookie}'`);
    expect(parsed.source).toBe("copy-as-curl");
    expect(parsed.cookieHeader).toBe(sampleCookie);
  });

  it("parses Copy-as-cURL with double-quoted -H cookie", () => {
    expect(parseNotebookLMAuthArtifact(`curl "https://notebooklm.google.com" -H "cookie: ${sampleCookie}"`).cookieHeader).toBe(sampleCookie);
  });

  it("parses --header cookie", () => {
    expect(parseNotebookLMAuthArtifact(`curl 'https://notebooklm.google.com' --header 'cookie: ${sampleCookie}'`).cookieHeader).toBe(sampleCookie);
  });

  it("parses --cookie and -b", () => {
    expect(parseNotebookLMAuthArtifact(`curl 'https://notebooklm.google.com' --cookie '${sampleCookie}'`).cookieHeader).toBe(sampleCookie);
    expect(parseNotebookLMAuthArtifact(`curl 'https://notebooklm.google.com' -b '${sampleCookie}'`).cookieHeader).toBe(sampleCookie);
  });

  it("preserves copied batchexecute bootstrap values", () => {
    const parsed = parseNotebookLMAuthArtifact(`curl 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=ozz5Z&f.sid=-4302171918860766934&rt=c' -b '${sampleCookie}' --data-raw 'f.req=%5B%5D&at=ABn2ubcVPZyE7CvcSpffrN4k1qte%3A1781023951170&'`);
    expect(parsed.sessionId).toBe("-4302171918860766934");
    expect(parsed.csrfToken).toBe("ABn2ubcVPZyE7CvcSpffrN4k1qte:1781023951170");
    expect(parsed.validationRpcId).toBe("ozz5Z");
    expect(parsed.validationFReq).toBe("[]");
  });

  it("parses raw cookie header", () => {
    expect(parseNotebookLMAuthArtifact(sampleCookie).source).toBe("raw-cookie-header");
  });

  it("drops non-NotebookLM cookie names from parsed artifacts", () => {
    const parsed = parseNotebookLMAuthArtifact(`${sampleCookie}; analytics_cookie=tracking; __cf_bm=proxy`);
    expect(parsed.cookieHeader).toBe(sampleCookie);
    expect(parsed.cookieHeader).not.toContain("analytics_cookie");
    expect(parsed.cookieHeader).not.toContain("__cf_bm");
  });

  it("parses raw cookie header with cookie prefix", () => {
    expect(parseNotebookLMAuthArtifact(`cookie: ${sampleCookie}`).cookieHeader).toBe(sampleCookie);
  });

  it("parses storage_state.json", () => {
    const parsed = parseNotebookLMAuthArtifact(JSON.stringify({ cookies: [{ name: "SID", value: "a", domain: ".google.com" }, { name: "__Secure-1PSID", value: "b", domain: ".google.com" }], notebooklm: { account: { email: "user@example.com", authuser: 0 } } }));
    expect(parsed.source).toBe("notebooklm-py-storage-state");
    expect(parsed.accountEmail).toBe("user@example.com");
  });

  it("detects notebook.google.com from Copy-as-cURL", () => {
    const parsed = parseNotebookLMAuthArtifact(`curl 'https://notebook.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=ZwVcOc&f.sid=-1&rt=c' -b '${sampleCookie}' --data-raw 'f.req=%5B%5D&at=token%3A1&'`);
    expect(parsed.baseUrl).toBe("https://notebook.google.com");
    expect(parsed.validationRpcId).toBe("ZwVcOc");
  });

  it("rejects Copy-as-URL-looking input", () => {
    expect(() => parseNotebookLMAuthArtifact("https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=wXbhsf")).toThrow("This looks like a URL");
  });

  it("rejects Copy-as-URL on notebook.google.com", () => {
    expect(() => parseNotebookLMAuthArtifact("https://notebook.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=wXbhsf")).toThrow("This looks like a URL");
  });

  it("rejects malformed input", () => {
    expect(() => parseNotebookLMAuthArtifact("not a cookie")).toThrow();
  });

  it("constrains base URL to allowed NotebookLM hosts", () => {
    expect(parseNotebookLMAuthArtifact(`curl 'https://evil.example/batchexecute' -H 'cookie: ${sampleCookie}'`).baseUrl).toBe("https://notebooklm.google.com");
    expect(parseNotebookLMAuthArtifact(`curl 'https://notebooklm.cloud.google.com/_/x' -H 'cookie: ${sampleCookie}'`).baseUrl).toBe("https://notebooklm.cloud.google.com");
    expect(parseNotebookLMAuthArtifact(`curl 'https://notebook.google.com/_/x' -H 'cookie: ${sampleCookie}'`).baseUrl).toBe("https://notebook.google.com");
  });

  it("detects notebook.google.com from storage_state cookie domains", () => {
    const parsed = parseNotebookLMAuthArtifact(JSON.stringify({
      cookies: [
        { name: "SID", value: "a", domain: ".google.com" },
        { name: "__Secure-1PSID", value: "b", domain: "notebook.google.com" }
      ]
    }));
    expect(parsed.baseUrl).toBe("https://notebook.google.com");
  });

  it("safe report never prints full cookie", () => {
    const report = safeArtifactReport(parseNotebookLMAuthArtifact(sampleCookie));
    expect(report).toContain("Cookie length:");
    expect(report).not.toContain("sid-test-value");
    expect(report).not.toContain("psid-test-value");
  });
});
