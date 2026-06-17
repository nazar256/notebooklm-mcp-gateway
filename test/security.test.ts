import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { env } from "./helpers";

describe("security files", () => {
  it(".gitignore contains secret artifact patterns", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    for (const pattern of ["curl_request.sh", "*.cookie", "cookie.txt", "*.auth.json", "*.sqlite", "*.tgz", ".env", ".dev.vars", ".wrangler/", ".tmp/"]) {
      expect(gitignore).toContain(pattern);
    }
  });

  it("root endpoint uses release-ready status text", async () => {
    const response = await worker.fetch(new Request("http://localhost:8787/"), env);
    expect(await response.text()).toBe("NotebookLM MCP Gateway");
  });

  it("invalid decoded secret lengths fail as misconfiguration", async () => {
    const response = await worker.fetch(new Request("http://localhost:8787/health"), { ...env, NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64: Buffer.from("short").toString("base64") });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("misconfigured");
  });

  it("base64 secrets tolerate trailing newlines from pipe-based setup commands", async () => {
    const response = await worker.fetch(new Request("http://localhost:8787/health"), {
      ...env,
      OAUTH_JWT_SIGNING_KEY_B64: `${env.OAUTH_JWT_SIGNING_KEY_B64}\n`,
      NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64: `${env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64}\n`,
      CSRF_SIGNING_KEY_B64: `${env.CSRF_SIGNING_KEY_B64}\n`
    });
    expect(response.status).toBe(200);
  });
});
