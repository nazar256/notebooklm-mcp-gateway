import { z } from "zod";

// Protocol port of notebooklm-py v0.8.5's domain-preserving cookie policy.
// Request headers cannot recover original attributes. Mark those rows inferred
// and replace them with authoritative Set-Cookie attributes when observed.
export const authCookieNames = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LSID", "OSID", "__Secure-OSID",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC", "__Secure-1PSIDTS", "__Secure-3PSIDTS",
  "__Secure-1PSIDRTS", "__Secure-3PSIDRTS", "NID", "AEC", "GAPS", "__Host-GAPS",
  "ACCOUNT_CHOOSER", "__Host-1PLSID", "__Host-3PLSID"
]);
const sharedNames = new Set([...authCookieNames].filter((name) => !["LSID", "OSID", "__Secure-OSID", "GAPS", "__Host-GAPS", "ACCOUNT_CHOOSER", "__Host-1PLSID", "__Host-3PLSID"].includes(name)));
const accountNames = new Set(["LSID", "GAPS", "__Host-GAPS", "ACCOUNT_CHOOSER", "__Host-1PLSID", "__Host-3PLSID"]);
const hosts = new Set(["accounts.google.com", "notebooklm.google.com", "notebook.google.com", "notebooklm.cloud.google.com", "accounts.youtube.com"]);
export const sessionCookieSchema = z.object({
  name: z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/).max(256),
  value: z.string().max(16_384).refine((v) => !/[\x00-\x20\x7f;,]/.test(v)),
  domain: z.string().max(253).refine(isCookieDomain),
  path: z.string().startsWith("/").max(2048),
  hostOnly: z.boolean(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  expires: z.number().finite().optional(), // Unix seconds; omitted for session cookies.
  inferred: z.boolean().optional()
}).refine((c) => !c.name.startsWith("__Secure-") || c.secure, "Secure prefix requires Secure")
  .refine((c) => !c.name.startsWith("__Host-") || c.secure && c.hostOnly && c.path === "/", "Host prefix requires a secure host-only root cookie");
export type SessionCookie = z.infer<typeof sessionCookieSchema>;
export type CookieInventory = { total: number; inferred: number; sid: boolean; psidts: boolean; osid: boolean; lsid: boolean; secondaryBinding: boolean; accountsBinding: boolean };

export function isCookieDomain(domain: string): boolean {
  const host = domain.replace(/^\./, "").toLowerCase();
  return host === "google.com" || hosts.has(host);
}
export function isSessionHost(host: string): boolean { return hosts.has(host); }
export function cookieIdentity(c: SessionCookie): string { return `${c.domain}\t${c.path}\t${c.name}`; }
function domainMatches(host: string, c: SessionCookie): boolean { return host === c.domain || (!c.hostOnly && host.endsWith(`.${c.domain}`)); }
function pathMatches(path: string, prefix: string): boolean { return path === prefix || (path.startsWith(prefix) && (prefix.endsWith("/") || path[prefix.length] === "/")); }

export function inferHeaderCookies(header: string, baseUrl: string): SessionCookie[] {
  const originHost = new URL(baseUrl).hostname;
  const rows = new Map<string, SessionCookie>();
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    const shared = sharedNames.has(name);
    const domain = shared ? "google.com" : accountNames.has(name) ? "accounts.google.com" : originHost;
    const parsed = sessionCookieSchema.safeParse({ name, value, domain, path: "/", hostOnly: !shared, secure: true, httpOnly: true, inferred: true });
    if (!parsed.success) continue;
    const key = cookieIdentity(parsed.data);
    const old = rows.get(key);
    if (old && old.value !== value && authCookieNames.has(name)) throw new Error("ambiguous_auth_cookies");
    rows.set(key, parsed.data);
  }
  if (rows.size > 256) throw new Error("too_many_cookies");
  return [...rows.values()];
}

export function importStorageCookies(rows: Array<Record<string, unknown>>, baseUrl: string): SessionCookie[] {
  const result: SessionCookie[] = [];
  for (const row of rows) {
    const rawDomain = typeof row.domain === "string" ? row.domain.toLowerCase() : new URL(baseUrl).hostname;
    if (!isCookieDomain(rawDomain)) continue;
    const domain = rawDomain.replace(/^\./, "");
    const parsed = sessionCookieSchema.safeParse({
      name: row.name, value: row.value, domain, path: row.path ?? "/",
      hostOnly: typeof row.hostOnly === "boolean" ? row.hostOnly : !rawDomain.startsWith("."),
      secure: row.secure ?? true, httpOnly: row.httpOnly ?? false, sameSite: row.sameSite,
      expires: typeof row.expires === "number" && row.expires >= 0 ? row.expires : undefined,
      inferred: row.domain === undefined
    });
    if (parsed.success) result.push(parsed.data);
  }
  if (result.length > 256) throw new Error("too_many_cookies");
  return result;
}

export class GoogleCookieJar {
  private rows = new Map<string, SessionCookie>();
  constructor(rows: readonly SessionCookie[]) { for (const c of rows) { const normalized = { ...c, domain: c.domain.replace(/^\./, "").toLowerCase() }; this.rows.set(cookieIdentity(normalized), normalized); } }
  snapshot(): SessionCookie[] { return [...this.rows.values()].map((c) => ({ ...c })); }
  replace(rows: readonly SessionCookie[]): void { this.rows.clear(); for (const c of rows) this.rows.set(cookieIdentity(c), { ...c }); }
  has(name: string): boolean { return this.live().some((c) => c.name === name && !!c.value); }
  headerFor(input: string | URL): string {
    const url = new URL(input);
    return this.live().filter((c) => domainMatches(url.hostname, c) && pathMatches(url.pathname, c.path) && (!c.secure || url.protocol === "https:"))
      .sort((a, b) => b.path.length - a.path.length).map((c) => `${c.name}=${c.value}`).join("; ");
  }
  // Compatibility projection for old envelopes/tests, never used for routing.
  flatHeader(): string { return this.live().map((c) => `${c.name}=${c.value}`).join("; "); }
  inventory(baseUrl: string): CookieInventory {
    const has = (name: string) => this.has(name);
    const accounts = new Set(this.headerFor("https://accounts.google.com/RotateCookies").split(";").map((s) => s.trim().split("=")[0]));
    const app = new Set(this.headerFor(baseUrl).split(";").map((s) => s.trim().split("=")[0]));
    return { total: this.live().length, inferred: this.live().filter((c) => c.inferred).length,
      sid: has("SID"), psidts: has("__Secure-1PSIDTS"), osid: app.has("OSID"), lsid: accounts.has("LSID"),
      secondaryBinding: app.has("OSID") || (app.has("APISID") && app.has("SAPISID") && accounts.has("LSID")),
      accountsBinding: accounts.has("SID") && (accounts.has("APISID") && accounts.has("SAPISID") || accounts.has("OSID")) };
  }
  capture(headers: Headers | undefined, input: string | URL): void {
    const url = new URL(input);
    for (const raw of headers?.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = raw.split(";");
      const at = pair.indexOf("=");
      if (at < 1) continue;
      const attributes = new Map(attrs.map((s) => { const i = s.indexOf("="); return [s.slice(0, i < 0 ? undefined : i).trim().toLowerCase(), i < 0 ? "" : s.slice(i + 1).trim()] as const; }));
      const name = pair.slice(0, at).trim();
      const domain = (attributes.get("domain") ?? url.hostname).replace(/^\./, "").toLowerCase();
      const hostOnly = !attributes.has("domain");
      if (!isCookieDomain(domain) || !(url.hostname === domain || (!hostOnly && url.hostname.endsWith(`.${domain}`)))) continue;
      let path = attributes.get("path") ?? url.pathname.slice(0, Math.max(1, url.pathname.lastIndexOf("/")));
      if (!path.startsWith("/")) path = "/";
      const secure = attributes.has("secure");
      if (name.startsWith("__Secure-") && !secure || name.startsWith("__Host-") && (!secure || !hostOnly || path !== "/")) continue;
      const age = attributes.get("max-age");
      const expires = age !== undefined && /^-?\d+$/.test(age) ? Date.now() / 1000 + Number(age) : Date.parse(attributes.get("expires") ?? "") / 1000;
      const sameSite = ({ strict: "Strict", lax: "Lax", none: "None" } as const)[attributes.get("samesite")?.toLowerCase() as "strict" | "lax" | "none"];
      const parsed = sessionCookieSchema.safeParse({ name, value: pair.slice(at + 1).trim(), domain, path, hostOnly, secure, httpOnly: attributes.has("httponly"), sameSite, expires: Number.isFinite(expires) ? expires : undefined });
      if (!parsed.success) continue;
      const cookie = parsed.data;
      const key = cookieIdentity(cookie);
      // Domain/path are part of identity. A host-only deletion must never
      // remove a parent-domain cookie with the same name.
      if (!cookie.value || cookie.expires !== undefined && cookie.expires <= Date.now() / 1000) this.rows.delete(key);
      else if (this.rows.size < 256 || this.rows.has(key)) this.rows.set(key, cookie);
    }
  }
  private live(): SessionCookie[] { return [...this.rows.values()].filter((c) => c.expires === undefined || c.expires > Date.now() / 1000); }
}
