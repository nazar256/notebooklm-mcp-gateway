import type { CookieInventory } from "./cookies";

export type AuthEvent = {
  event: "import" | "rotation" | "http" | "recovery" | "operation" | "storage";
  traceId?: string; session?: string;
  phase?: "bootstrap" | "rpc" | "rotation" | "chat";
  outcome?: "started" | "success" | "failed" | "skipped" | "rotated" | "unchanged" | "expired";
  reason?: string; stage?: string; status?: number; rpcStatus?: number;
  route?: "app" | "identity" | "signin" | "cookie_mismatch" | "access_gate" | "external";
  host?: "notebooklm.google.com" | "notebook.google.com" | "notebooklm.cloud.google.com" | "accounts.google.com" | "accounts.youtube.com";
  sentCookies?: { sid: boolean; psidts: boolean; osid: boolean; lsid: boolean; apiPair: boolean };
  hop?: number; durationMs?: number; attempt?: number;
  psidtsChanged?: boolean;
  inventory?: CookieInventory; source?: string; backend?: "durable-object" | "memory";
  version?: number; counters?: Record<string, number>; lastSuccessAt?: string;
};
export type AuthObserver = (event: AuthEvent) => void;

// Call sites supply only fixed protocol enums, counts, UUIDs/HMAC identifiers,
// and cookie-presence flags. Never pass raw URLs, headers, error.message,
// request arguments, cookie names from upstream, or response body fragments.
export const logAuthEvent: AuthObserver = (event) => console.log(JSON.stringify({ component: "notebooklm_auth", ...event }));
