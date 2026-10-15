import { describe, expect, it } from "vitest";
import { GoogleCookieJar, importStorageCookies, inferHeaderCookies } from "../src/cookies";
import { parseNotebookLMAuthArtifact } from "../src/authArtifact";

describe("domain-preserving Google cookie jar", () => {
  it("routes same-name app bindings and account cookies to their own hosts", () => {
    const jar = new GoogleCookieJar(importStorageCookies([
      { name: "OSID", value: "old-host", domain: "notebooklm.google.com" },
      { name: "OSID", value: "new-host", domain: "notebook.google.com" },
      { name: "LSID", value: "accounts-only", domain: "accounts.google.com" },
      { name: "SID", value: "shared", domain: ".google.com" }
    ], "https://notebook.google.com"));
    expect(jar.headerFor("https://notebook.google.com/")).toBe("OSID=new-host; SID=shared");
    expect(jar.headerFor("https://notebooklm.google.com/")).toBe("OSID=old-host; SID=shared");
    expect(jar.headerFor("https://accounts.google.com/")).toBe("LSID=accounts-only; SID=shared");
  });
  it("keeps unknown cURL cookie scopes confined to the copied request host", () => {
    const jar = new GoogleCookieJar(inferHeaderCookies("SID=s; OSID=o; future_binding=f", "https://notebook.google.com"));
    expect(jar.headerFor("https://notebook.google.com/")).toContain("future_binding=f");
    expect(jar.headerFor("https://accounts.google.com/")).toBe("SID=s");
    expect(jar.inventory("https://notebook.google.com").inferred).toBe(3);
  });
  it("preserves path and expiration and orders longer paths first", () => {
    const jar = new GoogleCookieJar(importStorageCookies([
      { name: "SID", value: "root", domain: ".google.com", path: "/" },
      { name: "SID", value: "specific", domain: "notebook.google.com", path: "/u/1" },
      { name: "OSID", value: "expired", domain: "notebook.google.com", expires: 1 }
    ], "https://notebook.google.com"));
    expect(jar.headerFor("https://notebook.google.com/u/1/notebook")).toBe("SID=specific; SID=root");
    expect(jar.headerFor("https://notebook.google.com/u/10")).toBe("SID=root");
  });
  it("applies domain/path-specific deletions without deleting a parent cookie", () => {
    const jar = new GoogleCookieJar(importStorageCookies([
      { name: "SIDCC", value: "parent", domain: ".google.com" },
      { name: "SIDCC", value: "local", domain: "notebooklm.google.com" }
    ], "https://notebooklm.google.com"));
    jar.capture(new Headers({ "set-cookie": "SIDCC=deleted; Max-Age=0; Path=/" }), "https://notebooklm.google.com/");
    expect(jar.headerFor("https://notebooklm.google.com/")).toBe("SIDCC=parent");
  });
  it("honors valid Max-Age over Expires and ignores invalid Max-Age", () => {
    const jar = new GoogleCookieJar([]);
    jar.capture(new Headers({ "set-cookie": "SIDCC=live; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=.google.com; Path=/" }), "https://notebooklm.google.com/");
    expect(jar.has("SIDCC")).toBe(true);
    jar.capture(new Headers({ "set-cookie": "SIDCC=dead; Max-Age=bad; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=.google.com; Path=/" }), "https://notebooklm.google.com/");
    expect(jar.has("SIDCC")).toBe(false);
  });
  it("rejects foreign-domain cookies and malformed __Host/__Secure cookies", () => {
    const jar = new GoogleCookieJar([]);
    const headers = new Headers();
    headers.append("set-cookie", "SID=foreign; Domain=accounts.google.com; Path=/");
    headers.append("set-cookie", "__Secure-1PSIDTS=unsafe; Domain=.google.com; Path=/");
    headers.append("set-cookie", "__Host-GAPS=unsafe; Domain=.google.com; Path=/; Secure");
    jar.capture(headers, "https://notebooklm.google.com/");
    expect(jar.snapshot()).toEqual([]);
  });
  it("does not import lookalike Google domains or conflict-dependent cURL identities", () => {
    expect(() => parseNotebookLMAuthArtifact("SID=a; SID=b")).toThrow("ambiguous");
    const parsed = parseNotebookLMAuthArtifact(JSON.stringify({ cookies: [
      { name: "SID", value: "good", domain: ".google.com" },
      { name: "OSID", value: "evil", domain: "google.com.attacker.example" }
    ] }));
    expect(parsed.cookieJar).toHaveLength(1);
  });
});
