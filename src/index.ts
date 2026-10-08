import { parseEnv, type Env } from "./config";
import { AuthArtifactError } from "./authArtifact";
import { authenticateMcp, authorizeGet, authorizePost, mcpChallenge, metadata, protectedResourceMetadata, register, token } from "./oauth";
import { handleMcpRequest } from "./mcp";
import { keepAliveSessions } from "./sessionStore";
import { RequestBodyTooLargeError } from "./http";

export default {
  async fetch(request: Request, rawEnv: unknown, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let env: Env;
    try {
      env = parseEnv(rawEnv);
    } catch {
      if (url.pathname === "/health") return new Response("misconfigured", { status: 500 });
      return new Response("Server misconfigured", { status: 500 });
    }

    try {
      if (request.method === "GET" && url.pathname === "/") return new Response("NotebookLM MCP Gateway");
      if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") return await metadata(env);
      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) return protectedResourceMetadata(env);
      if (request.method === "POST" && url.pathname === "/register") return await register(request, env);
      if (request.method === "GET" && url.pathname === "/authorize") return await authorizeGet(request, env);
      if (request.method === "POST" && url.pathname === "/authorize") return await authorizePost(request, env);
      if (request.method === "POST" && url.pathname === "/token") return await token(request, env);
      if (url.pathname === "/mcp") {
        let auth: Awaited<ReturnType<typeof authenticateMcp>>;
        try {
          auth = await authenticateMcp(request, env);
        } catch {
          return mcpChallenge(env, "invalid_token");
        }
        if (!auth) return mcpChallenge(env);
        return await handleMcpRequest(request, env, auth, ctx);
      }
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return sanitizedError(error);
    }
  },

  async scheduled(_controller: ScheduledController, rawEnv: unknown, ctx: ExecutionContext): Promise<void> {
    let env: Env;
    try {
      env = parseEnv(rawEnv);
    } catch {
      return;
    }
    ctx.waitUntil(keepAliveSessions(env).catch((error) => console.warn("NotebookLM keep-alive run failed", { error: error instanceof Error ? error.name : "unknown" })));
  }
};

function sanitizedError(error: unknown): Response {
  if (error instanceof AuthArtifactError) {
    return new Response(JSON.stringify({ error: "invalid_artifact", error_description: error.message }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413, headers: { "content-type": "application/json" } });
  }
  const message = error instanceof Error && error.message === "invalid_grant" ? "invalid_grant" : "invalid_request";
  return new Response(JSON.stringify({ error: message }), { status: 400, headers: { "content-type": "application/json" } });
}
