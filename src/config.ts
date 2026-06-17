import { z } from "zod";

export const envSchema = z.object({
  OAUTH_JWT_SIGNING_KEY_B64: z.string().trim().min(32),
  NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64: z.string().trim().min(32),
  CSRF_SIGNING_KEY_B64: z.string().trim().min(32),
  OAUTH_ISSUER: z.string().url(),
  MCP_RESOURCE: z.string().url(),
  MCP_AUDIENCE: z.string().url(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(900),
  CONNECTOR_TTL_MAX_DAYS: z.coerce.number().int().min(1).max(3650),
  OAUTH_EXTRA_REDIRECT_URI_PATTERNS: z.string().optional(),
  MOCK_NOTEBOOKLM_LIST_JSON: z.string().optional(),
  MOCK_NOTEBOOKLM_RENAME_JSON: z.string().optional(),
  MOCK_NOTEBOOKLM_DELETE_JSON: z.string().optional()
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: unknown): Env {
  const env = envSchema.parse(raw);
  validateBase64Key(env.OAUTH_JWT_SIGNING_KEY_B64, 32, "OAUTH_JWT_SIGNING_KEY_B64");
  validateBase64Key(env.CSRF_SIGNING_KEY_B64, 32, "CSRF_SIGNING_KEY_B64");
  validateBase64Key(env.NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64, 32, "NOTEBOOKLM_CREDENTIAL_ENC_KEY_B64", true);
  return env;
}

function validateBase64Key(value: string, minBytes: number, name: string, exact = false): void {
  let byteLength = 0;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    byteLength = atob(padded).length;
  } catch {
    throw new Error(`${name} must be base64-encoded`);
  }
  if (exact ? byteLength !== minBytes : byteLength < minBytes) {
    throw new Error(exact ? `${name} must decode to exactly ${minBytes} bytes` : `${name} must decode to at least ${minBytes} bytes`);
  }
}
