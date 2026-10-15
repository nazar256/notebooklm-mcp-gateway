import { GoogleCookieJar, isSessionHost, type SessionCookie } from "./cookies";
import type { AuthObserver, AuthEvent } from "./authTelemetry";

export type AuthHttpPhase = "bootstrap" | "rpc" | "rotation" | "chat";
export class AuthTransportError extends Error {
  constructor(readonly reason: "redirect_blocked" | "redirect_limit" | "timeout" | "network" | "cookie_mismatch" | "access_gate") { super(reason); }
}
export function googleRoute(input: string | URL): NonNullable<AuthEvent["route"]> {
  const url = new URL(input);
  if (/CookieMismatch/i.test(url.pathname)) return "cookie_mismatch";
  if (/\/sorry\b|\/restricted\b|\/unsupported\b/i.test(url.pathname)) return "access_gate";
  if (/\/v\d+\/signin|\/signin\b|\/InteractiveLogin\b/i.test(url.pathname)) return "signin";
  return url.hostname.startsWith("accounts.") ? "identity" : "app";
}

export class GoogleSessionHttp {
  lastUrl = "";
  private beforeFinal?: SessionCookie[];
  private readonly deadlineAt: number;
  constructor(readonly jar: GoogleCookieJar, private fetchImpl: typeof fetch, private observe: AuthObserver = () => {}, timeoutMs = 240_000) { this.deadlineAt = Date.now() + timeoutMs; }
  discardFinalCookies(): void { if (this.beforeFinal) this.jar.replace(this.beforeFinal); }

  async request(input: string | URL, init: RequestInit = {}, phase: AuthHttpPhase): Promise<Response> {
    let url = new URL(input);
    let request = { ...init };
    for (let hop = 0; hop < 10; hop++) {
      if (url.protocol !== "https:" || url.port || url.username || url.password || !isSessionHost(url.hostname)) {
        this.observe({ event: "http", phase, outcome: "failed", route: "external", reason: "redirect_blocked", hop });
        throw new AuthTransportError("redirect_blocked");
      }
      const route = googleRoute(url);
      if (route === "cookie_mismatch" || route === "access_gate") {
        this.observe({ event: "http", phase, outcome: "failed", route, reason: route, hop });
        throw new AuthTransportError(route);
      }
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      const cookie = this.jar.headerFor(url);
      if (cookie) headers.set("cookie", cookie);
      const names = new Set(cookie.split(";").map((s) => s.trim().split("=")[0]));
      const sentCookies = { sid: names.has("SID"), psidts: names.has("__Secure-1PSIDTS"), osid: names.has("OSID"), lsid: names.has("LSID"), apiPair: names.has("APISID") && names.has("SAPISID") };
      const remaining = this.deadlineAt - Date.now();
      if (remaining <= 0) throw new AuthTransportError("timeout");
      const controller = new AbortController();
      // v0.8.5 uses 15s for the rotation poke, 30s for bootstrap/normal
      // requests and a 180s chat window. A rotation timeout must not become
      // the limit for a generated answer. Bound the entire invocation too.
      const requestTimeout = phase === "rotation" ? 15_000 : phase === "chat" ? 180_000 : 30_000;
      const timer = setTimeout(() => controller.abort(), Math.min(requestTimeout, remaining));
      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(url.href, { ...request, headers, redirect: "manual", signal: controller.signal });
        this.lastUrl = response.url || url.href;
        const finalRoute = googleRoute(this.lastUrl);
        if (finalRoute === "cookie_mismatch" || finalRoute === "access_gate") throw new AuthTransportError(finalRoute);
        this.beforeFinal = this.jar.snapshot();
        // Set-Cookie is received in the headers. A subsequent body timeout
        // must not lose a session advance Google has already acknowledged.
        if ((response.ok || [301, 302, 303, 307, 308].includes(response.status)) && finalRoute !== "signin") this.jar.capture(response.headers, url);
        // The timeout includes the body, not just receipt of response headers.
        // NotebookLM consumers already buffer their text/JSON responses.
        if (typeof response.arrayBuffer === "function") {
          const body = await response.arrayBuffer();
          response = new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
      }
      catch (error) {
        const reason = error instanceof AuthTransportError ? error.reason : controller.signal.aborted ? "timeout" : "network";
        this.observe({ event: "http", phase, outcome: "failed", reason, route, host: url.hostname as AuthEvent["host"], sentCookies, hop, durationMs: Date.now() - started });
        throw new AuthTransportError(reason);
      }
      finally { clearTimeout(timer); }
      const finalRoute = googleRoute(this.lastUrl);
      this.observe({ event: "http", phase, status: response.status, route: finalRoute, host: url.hostname as AuthEvent["host"], sentCookies, hop, durationMs: Date.now() - started });
      if (finalRoute === "cookie_mismatch" || finalRoute === "access_gate") throw new AuthTransportError(finalRoute);
      const location = response.headers?.get?.("location");
      const redirects = [301, 302, 303, 307, 308].includes(response.status);
      if (!redirects) return response;
      if (!location) throw new AuthTransportError("redirect_blocked");
      const next = new URL(location, url);
      const method = (request.method ?? "GET").toUpperCase();
      if (response.status === 303 && method !== "HEAD" || [301, 302].includes(response.status) && method === "POST") {
        const nextHeaders = new Headers(request.headers);
        nextHeaders.delete("content-type"); nextHeaders.delete("content-length");
        request = { ...request, method: "GET", body: undefined, headers: nextHeaders };
      } else if (next.origin !== url.origin && method !== "GET" && method !== "HEAD") throw new AuthTransportError("redirect_blocked");
      if (next.origin !== url.origin) {
        const nextHeaders = new Headers(request.headers);
        for (const name of ["authorization", "origin", "referer", "x-same-domain"]) nextHeaders.delete(name);
        request.headers = nextHeaders;
      }
      await response.body?.cancel();
      url = next;
    }
    throw new AuthTransportError("redirect_limit");
  }
}
