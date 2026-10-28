import { mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { compareStrings } from "@gitinside/schema";

/**
 * Safe extraction of a GitHub tarball (`GET /repos/{owner}/{repo}/tarball/{sha}`) into a
 * job directory (docs/SECURITY.md T2, T3; ADR-0058).
 *
 * The tar format is parsed here rather than by a library, so every byte that reaches the
 * disk goes through these checks:
 * - **Paths:** an absolute path, a `..` segment, or a NUL fails the whole job
 *   (`TAR_UNSAFE_PATH`): git can't record such paths, so their presence means a crafted
 *   archive. Each written path is also resolved and checked to stay inside `dest`.
 * - **Entry types:** only regular files and directories are written. Symlinks, hard links,
 *   devices, FIFOs, and unknown types are skipped and listed in the result. Nothing is ever
 *   created that could redirect a later write.
 * - **Names the worker can't represent safely** (a backslash, a control character, a
 *   segment over 255 bytes, a path over `maxPathBytes`) are skipped and listed.
 * - **Limits:** the decompressed stream may not exceed `maxBytes` (`LIMIT_SIZE`, which
 *   catches gzip bombs while streaming, and early when a header declares a larger size),
 *   nor hold more than `maxEntries` entries (`LIMIT_ENTRIES`). Pax and GNU long-name
 *   records are capped at 1 MiB.
 * - **Integrity:** header checksums are verified, the end-of-archive marker is required (a
 *   cut-off download fails instead of yielding half a repo), and a duplicate entry or a file
 *   where a folder should be fails with `TAR_INVALID`, as does a bad gzip stream.
 *
 * Files are written 0644 and folders 0755; owners, modes, and times in the archive are
 * ignored. Files over the analyzer's 2 MB limit are still written in full (the 500 MB cap
 * bounds them), so the analyzer records the same `SKIPPED_LARGE` warning as on a checkout.
 *
 * Handles: POSIX ustar (with `prefix`), pax extended headers (`path`, `size`), pax global
 * headers (ignored; GitHub's holds the commit SHA), GNU long names (`L`), and GitHub's
 * single top folder (`owner-repo-sha7/`), stripped by default.
 *
 * Not handled: GNU sparse files and multi-volume archives (skipped as `SPECIAL`), base-256
 * sizes above 2^53, and pax `linkpath`/times/owners (links are skipped anyway). On failure
 * `dest` is left partly written; the caller deletes the job directory (SECURITY.md §3).
 */

/** Limits applied while extracting. Defaults come from docs/SECURITY.md (T3). */
export interface ExtractLimits {
  /** Fail with `LIMIT_SIZE` once the decompressed tar stream passes this. Default 500 MiB. */
  maxBytes: number;
  /** Fail with `LIMIT_ENTRIES` above this many entries. Default 100,000. */
  maxEntries: number;
  /** Skip (listed as `UNSUPPORTED_NAME`) entries whose path is longer than this. Default 4,096. */
  maxPathBytes: number;
}

/** Default extraction limits. */
export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxBytes: 500 * 1024 * 1024,
  maxEntries: 100_000,
  maxPathBytes: 4096,
};

/** Why an entry was left out. */
export type SkipReason = "SYMLINK" | "HARDLINK" | "SPECIAL" | "UNSUPPORTED_NAME";

/** An archive entry that wasn't written. */
export interface SkippedEntry {
  /** Path inside the repo (top folder stripped); control characters replaced with U+FFFD. */
  path: string;
  reason: SkipReason;
}

/** What {@link extractTarball} wrote. */
export interface ExtractResult {
  /** Regular files written. */
  files: number;
  /** Directory entries created (parents created implicitly aren't counted). */
  directories: number;
  /** Length of the decompressed tar stream, the number `maxBytes` limits. */
  tarBytes: number;
  /** Entries not written, sorted by path then reason. */
  skipped: SkippedEntry[];
}

/** Stable failure codes; stored as `analyses.error_code`. */
export type ExtractErrorCode = "LIMIT_SIZE" | "LIMIT_ENTRIES" | "TAR_UNSAFE_PATH" | "TAR_INVALID";

/** A fatal extraction failure. The job fails with {@link ExtractError.code}. */
export class ExtractError extends Error {
  constructor(
    readonly code: ExtractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ExtractError";
  }
}

/** Options for {@link extractTarball}. */
export interface ExtractOptions {
  limits?: Partial<ExtractLimits>;
  /** Drop the archive's single top folder (GitHub's `owner-repo-sha7/`). Default true. */
  stripRoot?: boolean;
}

const BLOCK = 512;
const META_MAX_BYTES = 1024 * 1024;
const SEGMENT_MAX_BYTES = 255;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Stream-extract the gzipped tarball `source` into `dest`, which must be empty or missing.
 * Throws {@link ExtractError} on unsafe, invalid, or oversized archives; other errors (the
 * source failing, a full disk) are rethrown as they are.
 */
export async function extractTarball(
  source: Readable | AsyncIterable<Uint8Array>,
  dest: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const limits = { ...DEFAULT_EXTRACT_LIMITS, ...options.limits };
  const root = resolve(dest);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length > 0) {
    throw new Error(`extraction target is not empty: ${root}`);
  }
  let result: ExtractResult | undefined;
  try {
    await pipeline(source, createGunzip(), async (chunks: AsyncIterable<Buffer>) => {
      result = await extractTar(chunks, root, limits, options.stripRoot ?? true);
    });
  } catch (error) {
    throw isZlibError(error) ? invalid("not a valid gzip stream") : error;
  }
  // pipeline resolves only after the sink returned, so result is set.
  return result as ExtractResult;
}

function isZlibError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("Z_");
}

function invalid(message: string): ExtractError {
  return new ExtractError("TAR_INVALID", message);
}

/** Reads exact byte counts from a chunk stream, enforcing the total byte limit. */
class ByteReader {
  private buffered = Buffer.alloc(0);
  total = 0;

  constructor(
    private readonly chunks: AsyncIterator<Buffer>,
    private readonly maxBytes: number,
  ) {}

  private async pull(): Promise<boolean> {
    const next = await this.chunks.next();
    if (next.done === true) return false;
    this.total += next.value.length;
    if (this.total > this.maxBytes) throw tooLarge(this.maxBytes);
    this.buffered =
      this.buffered.length === 0 ? next.value : Buffer.concat([this.buffered, next.value]);
    return true;
  }

  /** The next 512-byte block, or null at a clean end of stream. */
  async block(): Promise<Buffer | null> {
    while (this.buffered.length < BLOCK) {
      if (!(await this.pull())) {
        if (this.buffered.length === 0) return null;
        throw invalid("archive is truncated");
      }
    }
    return this.read(BLOCK);
  }

  /** Exactly `n` bytes (n is small: a block or a capped metadata record). */
  async read(n: number): Promise<Buffer> {
    while (this.buffered.length < n) {
      if (!(await this.pull())) throw invalid("archive is truncated");
    }
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    return out;
  }

  /** The next `n` bytes as pieces, without buffering them all. */
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.buffered.length === 0 && !(await this.pull())) {
        throw invalid("archive is truncated");
      }
      const piece = this.buffered.subarray(0, left);
      this.buffered = this.buffered.subarray(piece.length);
      left -= piece.length;
      yield piece;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const piece of this.take(n)) void piece;
  }

  /** Consume the rest of the stream (still counted against the limit). */
  async drain(): Promise<void> {
    this.buffered = Buffer.alloc(0);
    while (await this.pull()) this.buffered = Buffer.alloc(0);
  }
}

function tooLarge(maxBytes: number): ExtractError {
  return new ExtractError(
    "LIMIT_SIZE",
    `the repo is over the ${Math.round(maxBytes / (1024 * 1024))} MB extracted size limit. Try analyzing a subfolder.`,
  );
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

interface Header {
  name: string;
  type: string;
  size: number;
}

/** Text of a NUL-terminated field. */
function cstring(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.toString("utf8", 0, end === -1 ? bytes.length : end);
}

/** A numeric header field: octal text, or base-256 when the high bit is set. */
function numeric(bytes: Buffer, field: string): number {
  const first = bytes[0] ?? 0;
  if ((first & 0x80) !== 0) {
    if (first === 0xff) throw invalid(`negative ${field}`);
    let n = first & 0x7f;
    for (const byte of bytes.subarray(1)) n = n * 256 + byte;
    return n;
  }
  const text = bytes
    .toString("latin1")
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  if (!/^[0-7]*$/.test(text)) throw invalid(`bad ${field} field`);
  return text === "" ? 0 : parseInt(text, 8);
}

/** Parse one header block; null for an all-zero block (end of archive). */
function parseHeader(block: Buffer): Header | null {
  if (block.every((byte) => byte === 0)) return null;
  const stored = numeric(block.subarray(148, 156), "checksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  if (sum !== stored) throw invalid("header checksum mismatch");
  const name = cstring(block.subarray(0, 100));
  const ustar = block.toString("latin1", 257, 263) === "ustar\0";
  const prefix = ustar ? cstring(block.subarray(345, 500)) : "";
  const flag = block[156] ?? 0;
  return {
    name: prefix === "" ? name : `${prefix}/${name}`,
    type: flag === 0 ? "0" : String.fromCharCode(flag),
    size: numeric(block.subarray(124, 136), "size"),
  };
}

/** The `path` and `size` records of a pax extended header. */
function parsePax(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const length = space === -1 ? NaN : Number(data.toString("latin1", pos, space));
    if (!Number.isInteger(length) || length <= space - pos || pos + length > data.length) {
      throw invalid("bad pax record");
    }
    const record = data.toString("utf8", space + 1, pos + length);
    if (!record.endsWith("\n") || !record.includes("=")) throw invalid("bad pax record");
    const eq = record.indexOf("=");
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1, -1);
    if (key === "path") out.path = value;
    if (key === "size") {
      if (!/^\d+$/.test(value)) throw invalid("bad pax size");
      out.size = Number(value);
    }
    pos += length;
  }
  return out;
}

/** Path segments of an archive name, or a fatal error if it could escape. */
function segmentsOf(name: string): string[] {
  if (name.includes("\0") || name.startsWith("/")) {
    throw new ExtractError("TAR_UNSAFE_PATH", "archive entry has an absolute or invalid path");
  }
  const segments = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new ExtractError("TAR_UNSAFE_PATH", "archive entry path contains '..'");
  }
  return segments;
}

function unsupportedName(path: string, maxPathBytes: number): boolean {
  CONTROL.lastIndex = 0;
  return (
    path.includes("\\") ||
    CONTROL.test(path) ||
    Buffer.byteLength(path) > maxPathBytes ||
    path.split("/").some((s) => Buffer.byteLength(s) > SEGMENT_MAX_BYTES)
  );
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

async function extractTar(
  chunks: AsyncIterable<Buffer>,
  root: string,
  limits: ExtractLimits,
  stripRoot: boolean,
): Promise<ExtractResult> {
  const reader = new ByteReader(chunks[Symbol.asyncIterator](), limits.maxBytes);
  const skipped: SkippedEntry[] = [];
  let files = 0;
  let directories = 0;
  let entries = 0;
  let top: string | undefined;
  let pending: { path?: string; size?: number } = {};

  const checkSize = (size: number): void => {
    if (reader.total + size > limits.maxBytes) throw tooLarge(limits.maxBytes);
  };

  /** Absolute target of a repo-relative path, verified to stay under root. */
  const target = (path: string): string => {
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ExtractError("TAR_UNSAFE_PATH", "archive entry resolves outside the job folder");
    }
    return full;
  };

  const writeFile = async (path: string, size: number): Promise<void> => {
    const full = target(path);
    try {
      await mkdir(dirname(full), { recursive: true, mode: 0o755 });
      const handle = await open(full, "wx", 0o644);
      try {
        for await (const piece of reader.take(size)) await handle.write(piece);
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = errnoCode(error);
      if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
        throw invalid("archive has a duplicate or conflicting entry");
      }
      throw error;
    }
  };

  const makeDir = async (path: string): Promise<void> => {
    try {
      await mkdir(target(path), { recursive: true, mode: 0o755 });
    } catch (error) {
      const code = errnoCode(error);
      if (code === "EEXIST" || code === "ENOTDIR") {
        throw invalid("archive has a folder where a file already is");
      }
      throw error;
    }
  };

  for (;;) {
    const block = await reader.block();
    if (block === null) throw invalid("archive ends without an end-of-archive marker");
    const header = parseHeader(block);
    if (header === null) break;

    if (header.type === "g" || header.type === "x" || header.type === "L" || header.type === "K") {
      checkSize(header.size);
      if (header.type === "g") {
        await reader.skip(header.size + padding(header.size));
        continue;
      }
      if (header.size > META_MAX_BYTES) throw invalid("metadata record is too large");
      const data = await reader.read(header.size);
      await reader.skip(padding(header.size));
      if (header.type === "x") pending = { ...pending, ...parsePax(data) };
      if (header.type === "L") pending.path = cstring(data);
      continue;
    }

    const size = pending.size ?? header.size;
    const name = pending.path ?? header.name;
    pending = {};
    checkSize(size);
    entries += 1;
    if (entries > limits.maxEntries) {
      throw new ExtractError(
        "LIMIT_ENTRIES",
        `the repo has more than ${limits.maxEntries} files and folders. Try analyzing a subfolder.`,
      );
    }

    const segments = segmentsOf(name);
    if (stripRoot) {
      top ??= segments[0];
      if (segments[0] !== top) throw invalid("archive has more than one top folder");
      segments.shift();
    }
    const path = segments.join("/");
    const isFile = header.type === "0" || header.type === "7";
    const isDir = header.type === "5";
    const skip = async (reason: SkipReason): Promise<void> => {
      skipped.push({ path: path.replace(CONTROL, "�"), reason });
      await reader.skip(size + padding(size));
    };

    if (path === "") {
      if (!isDir) throw invalid("archive has a file at its top level");
      await reader.skip(size + padding(size));
    } else if (!isFile && !isDir) {
      await skip(header.type === "2" ? "SYMLINK" : header.type === "1" ? "HARDLINK" : "SPECIAL");
    } else if (unsupportedName(path, limits.maxPathBytes)) {
      await skip("UNSUPPORTED_NAME");
    } else if (isFile) {
      await writeFile(path, size);
      await reader.skip(padding(size));
      files += 1;
    } else {
      await makeDir(path);
      await reader.skip(size + padding(size));
      directories += 1;
    }
  }

  await reader.drain();
  skipped.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason));
  return { files, directories, tarBytes: reader.total, skipped };
}
