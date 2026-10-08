import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { NotebookLMCredentialEnvelope } from "./authArtifact";
import { notebookLmScopes } from "./scopes";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const encryptedEnvelopeSchema = z.object({
  v: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  compression: z.literal("deflate-raw").optional()
}).or(z.object({
  v: z.literal(3),
  i: z.string().min(1),
  c: z.string().min(1),
  z: z.literal("deflate-raw").optional()
}));

export const clientClaimsSchema = z.object({
  typ: z.literal("oauth-client"),
  redirect_uris: z.array(z.string().url()).min(1),
  client_name: z.string().optional()
});

export const csrfClaimsSchema = z.object({
  typ: z.literal("csrf"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  code_challenge: z.string().min(43),
  code_challenge_method: z.literal("S256"),
  scope: z.string(),
  resource: z.string().url().optional(),
  state: z.string().optional()
});

const scopeClaimSchema = z.string().refine((value) => {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.includes("notebooklm:read") && parts.every((part) => (notebookLmScopes as readonly string[]).includes(part));
}, { message: "invalid scope claim" });

export const authCodeClaimsSchema = z.object({
  typ: z.literal("auth-code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43),
  scope: scopeClaimSchema,
  connector_ttl_days: z.number().int().positive(),
  credential: encryptedEnvelopeSchema
}).or(z.object({
  typ: z.literal("ac3"),
  c: z.string().min(43),
  r: z.string().min(43),
  p: z.string().min(43),
  s: scopeClaimSchema,
  d: z.number().int().positive(),
  e: encryptedEnvelopeSchema
})).refine((value) => "credential" in value ? value.credential : value.e, {
  message: "auth-code must include a credential"
});

export const accessTokenClaimsSchema = z.object({
  typ: z.literal("access-token"),
  client_id: z.string().min(1),
  scope: scopeClaimSchema,
  connector_expires_at: z.string().datetime(),
  credential: encryptedEnvelopeSchema
});

export const refreshTokenClaimsSchema = z.object({
  typ: z.literal("refresh-token"),
  client_id: z.string().min(1),
  scope: scopeClaimSchema,
  connector_expires_at: z.string().datetime(),
  credential: encryptedEnvelopeSchema
});

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

export type AuthCodeClaims = z.infer<typeof authCodeClaimsSchema>;
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;
export type RefreshTokenClaims = z.infer<typeof refreshTokenClaimsSchema>;

export async function signJwt(payload: Record<string, unknown>, keyB64: string, issuer: string, audience: string, ttlSeconds: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(base64ToBytes(keyB64));
}

export async function verifyJwt<T>(token: string, keyB64: string, issuer: string, audience: string, schema: z.ZodType<T>): Promise<T> {
  const { payload } = await jwtVerify(token, base64ToBytes(keyB64), { issuer, audience });
  return schema.parse(payload);
}

export async function encryptEnvelope(envelope: NotebookLMCredentialEnvelope, keyB64: string): Promise<z.infer<typeof encryptedEnvelopeSchema>> {
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = await deflateRaw(textEncoder.encode(JSON.stringify(envelope)));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(plaintext));
  return { v: 3, i: base64UrlEncode(iv), c: base64UrlEncode(new Uint8Array(ciphertext)), z: "deflate-raw" };
}

export async function decryptEnvelope(encrypted: z.infer<typeof encryptedEnvelopeSchema>, keyB64: string): Promise<NotebookLMCredentialEnvelope> {
  const { notebookLMCredentialEnvelopeSchema } = await import("./authArtifact");
  const key = await importAesKey(keyB64);
  const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64UrlDecode("iv" in encrypted ? encrypted.iv : encrypted.i)) },
      key,
      toArrayBuffer(base64UrlDecode("ciphertext" in encrypted ? encrypted.ciphertext : encrypted.c))
  );
  const compression = "iv" in encrypted ? encrypted.compression : encrypted.z;
  const bytes = compression === "deflate-raw" ? await inflateRaw(new Uint8Array(plaintext)) : new Uint8Array(plaintext);
  return notebookLMCredentialEnvelopeSchema.parse(JSON.parse(textDecoder.decode(bytes)));
}

export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

export function base64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  return base64ToBytes(input);
}

async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(keyB64);
  if (bytes.byteLength !== 32) throw new Error("Invalid encryption key length");
  return crypto.subtle.importKey("raw", toArrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return bytes;
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") return bytes;
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
