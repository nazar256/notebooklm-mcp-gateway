import { z } from "zod";

export const allowedNotebookLMBaseUrls = [
  "https://notebooklm.google.com",
  "https://notebooklm.cloud.google.com"
] as const;

export const notebookLMCredentialEnvelopeSchema = z.object({
  format: z.literal("notebooklm-mcp-gateway/notebooklm-auth/v1"),
  source: z.enum(["copy-as-curl", "raw-cookie-header", "notebooklm-py-storage-state"]),
  baseUrl: z.enum(allowedNotebookLMBaseUrls),
  cookieHeader: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  csrfToken: z.string().min(1).optional(),
  validationRpcId: z.string().min(1).optional(),
  validationFReq: z.string().min(1).optional(),
  accountEmail: z.string().email().optional(),
  createdAt: z.string().datetime()
});

export type NotebookLMCredentialEnvelope = z.infer<typeof notebookLMCredentialEnvelopeSchema>;

export const authArtifactInputSchema = z.string().trim().min(1).max(200_000);

const storageStateSchema = z.object({
  cookies: z.array(
    z.object({
      name: z.string().min(1),
      value: z.string(),
      domain: z.string().optional()
    }).passthrough()
  ),
  notebooklm: z.object({
    account: z.object({
      email: z.string().email().optional(),
      authuser: z.number().int().nonnegative().optional()
    }).passthrough().optional()
  }).passthrough().optional()
}).passthrough();

export class AuthArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthArtifactError";
  }
}

export function parseNotebookLMAuthArtifact(input: string, now = new Date()): NotebookLMCredentialEnvelope {
  const raw = authArtifactInputSchema.parse(input);
  const trimmed = raw.trim();
  const baseUrl = detectBaseUrl(trimmed);

  if (looksLikeCopyAsUrl(trimmed)) {
    throw new AuthArtifactError(
      "This looks like a URL, not Copy as cURL output. In DevTools, right-click the batchexecute request and choose Copy → Copy as cURL."
    );
  }

  const storage = tryParseStorageState(trimmed, now);
  if (storage) {
    return storage;
  }

  const curlCookie = extractCookieFromCurl(trimmed);
  if (curlCookie) {
    const bootstrap = extractBootstrapFromCurl(trimmed);
    return makeEnvelope("copy-as-curl", baseUrl, curlCookie, now, undefined, bootstrap);
  }

  const rawCookie = extractRawCookieHeader(trimmed);
  if (rawCookie) {
    return makeEnvelope("raw-cookie-header", baseUrl, rawCookie, now);
  }

  throw new AuthArtifactError("Paste Copy-as-cURL output, a raw Cookie header value, or notebooklm-py storage_state.json.");
}

export function safeArtifactReport(envelope: NotebookLMCredentialEnvelope): string {
  const label = envelope.source === "notebooklm-py-storage-state" ? "storage_state_json" : envelope.source;
  return [
    `Detected format: ${label}`,
    `Detected base URL: ${envelope.baseUrl}`,
    `Cookie length: ${envelope.cookieHeader.length}`,
    `Has SID: ${envelope.cookieHeader.includes("SID=")}`,
    `Has __Secure-1PSID: ${envelope.cookieHeader.includes("__Secure-1PSID=")}`
  ].join("\n");
}

export function validateObviousNotebookLMCookies(cookieHeader: string): void {
  if (!cookieHeader.includes("SID=") && !cookieHeader.includes("__Secure-1PSID=")) {
    throw new AuthArtifactError("The pasted artifact does not include obvious NotebookLM/Google session cookies.");
  }
}

function makeEnvelope(
  source: NotebookLMCredentialEnvelope["source"],
  baseUrl: NotebookLMCredentialEnvelope["baseUrl"],
  cookieHeader: string,
  now: Date,
  accountEmail?: string,
  bootstrap?: { sessionId?: string; csrfToken?: string; validationRpcId?: string; validationFReq?: string }
): NotebookLMCredentialEnvelope {
  const normalized = normalizeCookieHeader(cookieHeader);
  validateObviousNotebookLMCookies(normalized);
  return notebookLMCredentialEnvelopeSchema.parse({
    format: "notebooklm-mcp-gateway/notebooklm-auth/v1",
    source,
    baseUrl,
    cookieHeader: normalized,
    sessionId: bootstrap?.sessionId,
    csrfToken: bootstrap?.csrfToken,
    validationRpcId: bootstrap?.validationRpcId,
    validationFReq: bootstrap?.validationFReq,
    accountEmail,
    createdAt: now.toISOString()
  });
}

function detectBaseUrl(input: string): NotebookLMCredentialEnvelope["baseUrl"] {
  return input.includes("notebooklm.cloud.google.com")
    ? "https://notebooklm.cloud.google.com"
    : "https://notebooklm.google.com";
}

function looksLikeCopyAsUrl(input: string): boolean {
  return /^https:\/\/notebooklm\.(?:google\.com|cloud\.google\.com)\//.test(input) && !hasCookieSignal(input);
}

function hasCookieSignal(input: string): boolean {
  return /(?:^|\s)(?:-H|--header|-b|--cookie)\s+/i.test(input) || /(?:^|\n)\s*cookie\s*:/i.test(input) || /\b(?:SID|__Secure-1PSID)=/.test(input);
}

function extractCookieFromCurl(input: string): string | null {
  const patterns = [
    /(?:^|\s)-H\s+'cookie:\s*([^']+)'/i,
    /(?:^|\s)-H\s+"cookie:\s*([^"]+)"/i,
    /(?:^|\s)--header\s+'cookie:\s*([^']+)'/i,
    /(?:^|\s)--header\s+"cookie:\s*([^"]+)"/i,
    /(?:^|\s)-b\s+'([^']+)'/i,
    /(?:^|\s)-b\s+"([^"]+)"/i,
    /(?:^|\s)--cookie\s+'([^']+)'/i,
    /(?:^|\s)--cookie\s+"([^"]+)"/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractBootstrapFromCurl(input: string): { sessionId?: string; csrfToken?: string; validationRpcId?: string; validationFReq?: string } {
  const sessionId = extractQueryParam(input, "f.sid");
  const csrfToken = extractFormParamFromCurl(input, "at");
  const validationRpcId = extractQueryParam(input, "rpcids");
  const validationFReq = extractFormParamFromCurl(input, "f.req");
  return { sessionId, csrfToken, validationRpcId, validationFReq };
}

function extractQueryParam(input: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`[?&]${escaped}=([^&'"\\s]+)`).exec(input);
  return match?.[1] ? decodeURIComponent(match[1].replace(/\\u0026/g, "&")) : undefined;
}

function extractFormParamFromCurl(input: string, name: string): string | undefined {
  const patterns = [
    /(?:^|\s)--data(?:-raw|-binary)?\s+'([^']+)'/i,
    /(?:^|\s)--data(?:-raw|-binary)?\s+"([^"]+)"/i,
    /(?:^|\s)-d\s+'([^']+)'/i,
    /(?:^|\s)-d\s+"([^"]+)"/i
  ];
  for (const pattern of patterns) {
    const body = pattern.exec(input)?.[1];
    const value = body ? new URLSearchParams(body).get(name) : null;
    if (value) return value;
  }
  return undefined;
}

function extractRawCookieHeader(input: string): string | null {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.replace(/^cookie\s*:\s*/i, "");
  if (/\b(?:SID|__Secure-1PSID)=/.test(withoutPrefix) && withoutPrefix.includes("=")) {
    return withoutPrefix;
  }
  return null;
}

function tryParseStorageState(input: string, now: Date): NotebookLMCredentialEnvelope | null {
  if (!input.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  const state = storageStateSchema.safeParse(parsed);
  if (!state.success) return null;
  const relevantCookies = state.data.cookies.filter((cookie) => {
    const domain = cookie.domain ?? "";
    return domain.includes("google.com") || domain.includes("notebooklm") || cookie.name.includes("SID");
  });
  const cookieHeader = relevantCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const baseUrl = relevantCookies.some((cookie) => (cookie.domain ?? "").includes("cloud.google.com"))
    ? "https://notebooklm.cloud.google.com"
    : "https://notebooklm.google.com";
  return makeEnvelope(
    "notebooklm-py-storage-state",
    baseUrl,
    cookieHeader,
    now,
    state.data.notebooklm?.account?.email
  );
}

function normalizeCookieHeader(cookieHeader: string): string {
  const normalized = cookieHeader
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/\\\n/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s*;\s*/g, "; ")
    .trim();
  return compactCookieHeader(normalized);
}

const notebookLmCookieAllowlist = new Set([
  "SID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "OSID",
  "__Secure-OSID",
  "NID",
  "SIDCC",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS"
]);

function compactCookieHeader(cookieHeader: string): string {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!notebookLmCookieAllowlist.has(name)) continue;
    cookies.set(name, value);
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ") || cookieHeader;
}
