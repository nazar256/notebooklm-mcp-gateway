import { describe, expect, it } from "vitest";
import { parseNotebookLMAuthArtifact } from "../src/authArtifact";
import { NotebookLMClient, buildNotebookLMRpcResponse } from "../src/notebooklm";

describe("notebooklm-py auth parity", () => {
  it("preserves LSID from a full browser export", () => {
    const envelope = parseNotebookLMAuthArtifact(JSON.stringify({ cookies: [
      { name: "SID", value: "synthetic", domain: ".google.com" },
      { name: "LSID", value: "synthetic-accounts", domain: "accounts.google.com" }
    ] }));
    expect(envelope.cookieHeader).toContain("LSID=");
  });

  it("attempts PSIDTS recovery when SID and the secondary binding survive", async () => {
    let calls = 0;
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader: "SID=s; APISID=a; SAPISID=b", fetch: async () => {
      calls++;
      return new Response('[["identity.hfcr",600]]', { headers: { "set-cookie": "__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure" } });
    } });
    expect((await client.rotateCookies()).result).toBe("rotated");
    expect(calls).toBe(1);
  });

  it("carries intermediate Google cookies into the next redirect hop", async () => {
    const client = new NotebookLMClient({ baseUrl: "https://notebooklm.google.com", cookieHeader: "SID=s; OSID=o", fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/") return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/ServiceLogin" } });
      if (url.pathname === "/ServiceLogin") return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/SetOSID", "set-cookie": "LSID=renewed; Path=/; Secure; HttpOnly" } });
      if (url.pathname === "/SetOSID") {
        expect(new Headers(init?.headers).get("cookie")).toContain("LSID=renewed");
        return new Response(null, { status: 302, headers: { location: "https://notebooklm.google.com/complete" } });
      }
      if (url.pathname === "/complete") return new Response('<script>{"SNlM0e":"csrf","FdrFJe":"session"}</script>');
      return new Response(buildNotebookLMRpcResponse("wXbhsf", [[]]));
    } });
    await expect(client.listNotebooks()).resolves.toEqual([]);
  });
});
