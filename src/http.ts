export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) throw new RequestBodyTooLargeError();
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RequestBodyTooLargeError();
  return text;
}

export function parseUniqueUrlEncoded(text: string): Record<string, string> {
  const params = new URLSearchParams(text);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) throw new Error("invalid_request");
    seen.add(key);
  }
  return Object.fromEntries(params.entries());
}
