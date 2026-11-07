/**
 * Read at most `max` bytes of a request's body; `undefined` if it's longer. A declared
 * `content-length` over `max` is refused unread, and a streamed body as soon as it passes it.
 */
export async function readBody(request: Request, max: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return undefined;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
