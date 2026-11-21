import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { MAX_STORED_RULES_CONFIG_BYTES, type StoredRulesConfig } from "@gitinside/db";
import type { PrRules } from "@gitinside/diff";
import { MAX_CONFIG_BYTES, evaluateRulesOnDiff, parseRulesConfig } from "@gitinside/rules";
import type { ArchitectureGraph, GraphDiff } from "@gitinside/schema";

/**
 * A pull request's architecture rules (M15.1c, docs/RULES.md "On a pull request"): the head's
 * `.gitinside.yml` read from the diff job's extracted tree in the form it's stored in with the diff
 * (M15.1b), and checked from that stored text, so the first run and a `diffed` retry (no tree)
 * check the same thing.
 *
 * Handles: a regular file at the repo's root; any bytes (text that isn't UTF-8 reads as U+FFFD, as
 * a decoder does); U+0000, which Postgres text refuses, stored as U+FFFD; a file over the limit,
 * stored cut to the database's cap and padded to it, so it still reads as too large.
 * Doesn't handle: a symlink or other non-regular `.gitinside.yml` (the tarball's extraction
 * already skips links, extract.ts) counts as no config; nor does a config in a subfolder count.
 */

/** The config's name, at the repo's root. */
export const RULES_CONFIG_FILE = ".gitinside.yml";

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** `text` cut to at most `bytes` UTF-8 bytes, never inside a character. */
function cutUtf8(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= bytes) return text;
  let end = bytes;
  // The first byte left out continues a character: leave that character out too.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * The form a config's bytes are stored and checked in: decoded as UTF-8, U+0000 replaced by
 * U+FFFD, and, when that's over `MAX_CONFIG_BYTES`, cut to `MAX_STORED_RULES_CONFIG_BYTES` and
 * padded with spaces to exactly that, so `parseRulesConfig` refuses it for its size (it reads
 * nothing else of such a file) and the database takes it.
 */
export function storedConfigText(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("utf8").replaceAll(NUL, REPLACEMENT);
  if (Buffer.byteLength(text) <= MAX_CONFIG_BYTES) return text;
  const kept = cutUtf8(text, MAX_STORED_RULES_CONFIG_BYTES);
  return kept + " ".repeat(MAX_STORED_RULES_CONFIG_BYTES - Buffer.byteLength(kept));
}

/**
 * The `.gitinside.yml` at the root of the tree `root` in its stored form
 * ({@link storedConfigText}), or `null` when there's none or it isn't a regular file. Reads at
 * most `MAX_STORED_RULES_CONFIG_BYTES` of it.
 */
export async function readRulesConfig(root: string): Promise<string | null> {
  const path = join(root, RULES_CONFIG_FILE);
  let size: number;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    size = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, MAX_STORED_RULES_CONFIG_BYTES));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return storedConfigText(buffer.subarray(0, filled));
  } finally {
    await handle.close();
  }
}

/** The config the diff job stores: the head's, and whether it differs from the base's. */
export async function rulesConfigOf(base: string, head: string): Promise<StoredRulesConfig> {
  const before = await readRulesConfig(base);
  const text = await readRulesConfig(head);
  return { text, changed: before !== text };
}

/**
 * The PR's rules outcome for the comment and Check Run: `undefined` when the head has no config;
 * otherwise the stored text parsed (its issues when it doesn't) and its rules evaluated on the two
 * graphs with the diff's renames, under `budgetMs` (a timeout is reported as a config issue by
 * `evaluateRulesOnDiff`; no time at all, as one here). May throw on a bug in the rules; the caller
 * reports that too.
 */
export function checkRules(
  stored: StoredRulesConfig,
  made: { diff: GraphDiff; base: ArchitectureGraph; head: ArchitectureGraph },
  options: { budgetMs: number; now?: () => number },
): PrRules | undefined {
  if (stored.text === null) return undefined;
  const configChanged = stored.changed;
  if (options.budgetMs <= 0) {
    const message = "no time was left in the job to check the rules; push again to retry";
    return { result: { ok: false, issues: [{ path: "", message }] }, configChanged };
  }
  const parsed = parseRulesConfig(stored.text);
  if (!parsed.ok) return { result: parsed, configChanged };
  const result = evaluateRulesOnDiff(parsed.config, made.base, made.head, {
    diff: made.diff,
    budgetMs: options.budgetMs,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { result, configChanged };
}
