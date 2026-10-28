import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

/**
 * A tiny tar writer for tests. It can build archives no real tool would (`../` names,
 * links, bad checksums, lying sizes), which is the point: the extractor's checks are
 * exercised byte for byte.
 */
export interface TestEntry {
  name: string;
  /** Typeflag: "0" file (default), "5" directory, "1" hard link, "2" symlink, "x" pax, … */
  type?: string;
  body?: string | Buffer;
  /** Declared size; defaults to the body's length. */
  size?: number;
  /** Raw 12-byte size field, for base-256 sizes. */
  sizeField?: Buffer;
  prefix?: string;
  linkname?: string;
  badChecksum?: boolean;
}

const BLOCK = 512;

function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "latin1");
}

/** One header block plus its padded body. */
export function entry(e: TestEntry): Buffer {
  const body = typeof e.body === "string" ? Buffer.from(e.body) : (e.body ?? Buffer.alloc(0));
  const h = Buffer.alloc(BLOCK);
  h.write(e.name, 0, 100, "utf8");
  octal(h, 100, 8, 0o755);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  if (e.sizeField) e.sizeField.copy(h, 124, 0, 12);
  else octal(h, 124, 12, e.size ?? body.length);
  octal(h, 136, 12, 0);
  h.write(e.type ?? "0", 156, 1, "latin1");
  h.write(e.linkname ?? "", 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "latin1");
  h.write("00", 263, 2, "latin1");
  h.write(e.prefix ?? "", 345, 155, "utf8");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of h) sum += byte;
  if (e.badChecksum) sum += 1;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  const pad = Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK);
  return Buffer.concat([h, body, pad]);
}

/** A pax extended-header body: `"<len> <key>=<value>\n"` records. */
export function paxBody(records: Record<string, string>): string {
  let out = "";
  for (const [key, value] of Object.entries(records)) {
    const rest = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(rest) + 1;
    while (String(length).length + Buffer.byteLength(rest) !== length) length += 1;
    out += `${length}${rest}`;
  }
  return out;
}

/** Concatenate entries, ending with the two zero blocks unless `end` is false. */
export function tar(entries: TestEntry[], options: { end?: boolean } = {}): Buffer {
  const parts = entries.map(entry);
  if (options.end !== false) parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** A gzipped tar as a stream, optionally split into `chunk`-byte pieces. */
export function tgz(
  entries: TestEntry[],
  options: { end?: boolean; chunk?: number } = {},
): Readable {
  return streamOf(gzipSync(tar(entries, options)), options.chunk);
}

/** A buffer as a stream, optionally split into `chunk`-byte pieces. */
export function streamOf(data: Buffer, chunk?: number): Readable {
  if (chunk === undefined) return Readable.from([data]);
  const pieces: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunk) pieces.push(data.subarray(i, i + chunk));
  return Readable.from(pieces);
}
