import { useEffect, useMemo, useState } from "react";
import { repoFileParts, type RepoRef } from "../chrome/describe.js";

/**
 * Where the inspector's code previews come from (M4b.5a, ADR-0115). A graph
 * holds no file text, so the explorer asks for a file only when a selection
 * or trace step needs it: from text the host already has (`sources`, used by
 * stories and tests), or from a loader the host gives (the website's reads
 * public files from GitHub at the analyzed commit). Each path is loaded once
 * per explorer.
 */

/** Loads one file's text by repo-relative path; `undefined` when it can't. */
export type SourceLoader = (path: string) => Promise<string | undefined>;

/** A file's text as the inspector sees it. */
export type SourceState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "failed" };

/** The explorer's file text: what the host gave, plus a per-path cache of what it loaded. */
export interface SourceAccess {
  /** Text the host gave up front or that has already loaded, if any. */
  known(path: string): string | undefined;
  /** Whether files can be loaded at all. */
  readonly canLoad: boolean;
  /** One load per path; a failed load is forgotten, so the next selection tries again. */
  load(path: string): Promise<string | undefined>;
}

/** Builds a {@link SourceAccess} from the host's text and loader (either may be missing). */
export function createSourceAccess(
  sources: Readonly<Record<string, string>> | undefined,
  loader: SourceLoader | undefined,
): SourceAccess {
  const pending = new Map<string, Promise<string | undefined>>();
  // Loaded text, so a file already here shows at once (no loading frame on reselect).
  const loaded = new Map<string, string>();
  // Own keys only: a path named "constructor" isn't a file the host gave.
  const known = (path: string) =>
    sources && Object.hasOwn(sources, path) ? sources[path] : loaded.get(path);
  return {
    known,
    canLoad: loader !== undefined,
    load(path) {
      const text = known(path);
      if (text !== undefined) return Promise.resolve(text);
      if (!loader) return Promise.resolve(undefined);
      let promise = pending.get(path);
      if (!promise) {
        promise = loader(path).then(
          (text) => {
            if (text === undefined) pending.delete(path);
            else loaded.set(path, text);
            return text;
          },
          () => {
            pending.delete(path);
            return undefined;
          },
        );
        pending.set(path, promise);
      }
      return promise;
    },
  };
}

/** The explorer's {@link SourceAccess}, rebuilt only when the host's text or loader changes. */
export function useSourceAccess(
  sources: Readonly<Record<string, string>> | undefined,
  loader: SourceLoader | undefined,
): SourceAccess {
  return useMemo(() => createSourceAccess(sources, loader), [sources, loader]);
}

/**
 * The text of `path` for the inspector: `none` when there's no file or no way
 * to get it (no code section), `loading` while it's on its way, then `ready`
 * or `failed` (shown, with the GitHub link, rather than hidden).
 */
export function useSourceText(access: SourceAccess, path: string | undefined): SourceState {
  const known = path === undefined ? undefined : access.known(path);
  const [loaded, setLoaded] = useState<{
    access: SourceAccess;
    path: string;
    state: SourceState;
  }>();
  useEffect(() => {
    if (path === undefined || known !== undefined || !access.canLoad) return;
    let live = true;
    void access.load(path).then((text) => {
      if (!live) return;
      setLoaded({
        access,
        path,
        state: text === undefined ? { status: "failed" } : { status: "ready", text },
      });
    });
    return () => {
      live = false;
    };
  }, [access, path, known]);
  if (path === undefined) return { status: "none" };
  if (known !== undefined) return { status: "ready", text: known };
  if (!access.canLoad) return { status: "none" };
  return loaded?.access === access && loaded.path === path ? loaded.state : { status: "loading" };
}

/** The analyzer skips files over 2 MB (ADR-0020), so nothing in a graph points into a larger one. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Options for {@link createGitHubSourceLoader}. */
export interface GitHubSourceLoaderOptions {
  fetch?: typeof fetch;
  /** Files larger than this aren't shown. Default {@link MAX_SOURCE_BYTES}. */
  maxBytes?: number;
}

/**
 * Loads a public repo's files from `raw.githubusercontent.com` at the analyzed
 * commit, from the viewer's browser (nothing is proxied or stored by us).
 * Gives `undefined` without a commit SHA (a branch could have moved since the
 * analysis), for a path that could leave the repo (`.`, `..`, or empty
 * segments, {@link repoFileParts}), on any non-200 answer, for files over the
 * size cap (by `content-length`, and while the body streams, so a chunked
 * answer stops at the cap rather than downloading in full), and for binary
 * files (a NUL byte), so the inspector says it couldn't load the file.
 * Private repos (M8) need a signed-in route instead.
 */
export function createGitHubSourceLoader(
  repo: RepoRef,
  options: GitHubSourceLoaderOptions = {},
): SourceLoader {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  return async (path) => {
    const parts = repoFileParts(repo, path);
    if (!parts) return undefined;
    const url = `https://raw.githubusercontent.com/${parts.repo}/${parts.sha}/${parts.path}`;
    const response = await fetchImpl(url, { credentials: "omit", redirect: "error" });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const bytes = await readCapped(response, maxBytes);
    if (!bytes || bytes.includes(0)) return undefined;
    return new TextDecoder().decode(bytes);
  };
}

/**
 * A response body's bytes, or undefined once more than `maxBytes` arrive:
 * the stream is cancelled then, so an answer without a length (or with a
 * wrong one) never downloads past the cap.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
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
