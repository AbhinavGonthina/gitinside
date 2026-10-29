import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { constants, gzip } from "node:zlib";
import {
  amzDate,
  authorization,
  EMPTY_PAYLOAD_HASH,
  uriEncode,
  type Credentials,
} from "./sigv4.js";

/**
 * Graph snapshots in object storage (Cloudflare R2, S3-compatible; ADR-0013, ADR-0062).
 *
 * - **Keys** name one analysis: repo, commit, and analyzer version, so a new analyzer
 *   version writes a new object instead of overwriting one a cache may still hold.
 *   - public: `public/<owner>/<repo>/<sha>/<analyzerVersion>.json.gz` (owner and repo
 *     lowercased, as GitHub ignores case);
 *   - private (M8): `private/<installationId>/<repoId>/<sha>/<analyzerVersion>.json.gz`,
 *     never served through the CDN (SECURITY.md T6).
 * - **Objects** are `architecture.json` gzipped (level 9), stored with
 *   `Content-Encoding: gzip` and `Content-Type: application/json`. Public ones are
 *   immutable (a key never changes content), private ones `no-store`.
 * - **Requests** are signed with SigV4 (sigv4.ts) over the exact body hash, so R2 rejects a
 *   body that changed in transit. Each request has a time budget; every failure is a
 *   {@link StorageError}, which the job reports as the retriable `PUBLISH_FAILED`.
 * - **Reads** (`get`, the web app's `/api/graph`, ADR-0068) are signed GETs; a missing
 *   object is `undefined`, any other refusal a {@link StorageError}. Exported on its own as
 *   `@gitinside/worker/storage`, so the web app reads with the code the worker writes with.
 * - **Credentials** come from `R2_*` variables (ADR-0055) and appear in no error or log.
 */

/** What identifies a public snapshot. */
export interface PublicSnapshot {
  owner: string;
  repo: string;
  sha: string;
  analyzerVersion: string;
}

/** What identifies a private snapshot (M8): the GitHub installation and our repo row. */
export interface PrivateSnapshot {
  installationId: number;
  repoId: string;
  sha: string;
  analyzerVersion: string;
}

/** Where and how to reach the bucket. */
export interface StoreConfig {
  /** `https://<account>.r2.cloudflarestorage.com` (tests: a local server). No trailing path. */
  endpoint: string;
  bucket: string;
  credentials: Credentials;
  /** R2 signs with `auto`. */
  region?: string;
}

/** Headers stored with an object. */
export interface PutObjectOptions {
  contentType: string;
  contentEncoding?: string;
  cacheControl: string;
}

/** An object read back by {@link ObjectStore.get}. */
export interface ObjectBody {
  /**
   * The stored bytes, decoded: `fetch` undoes a stored `Content-Encoding: gzip`, so a
   * snapshot arrives as `architecture.json`. Cancel it if it isn't read.
   */
  body: ReadableStream<Uint8Array>;
  contentType: string | undefined;
}

/** The operations the worker (put) and the web app (get, M5.8) need. */
export interface ObjectStore {
  put(key: string, body: Uint8Array, options: PutObjectOptions): Promise<void>;
  /** The object under `key`, or `undefined` if there's none (S3's `404 NoSuchKey`). */
  get(key: string): Promise<ObjectBody | undefined>;
}

/** Options for {@link createObjectStore}. */
export interface ObjectStoreOptions {
  /** Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Per request. Default {@link STORAGE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The signing clock (tests fix it). Default now. */
  now?: () => Date;
}

/** What {@link uploadSnapshot} stored. */
export interface StoredSnapshot {
  key: string;
  /** `architecture.json` size. */
  bytes: number;
  /** Gzipped size, what counts against the bucket's quota. */
  storedBytes: number;
}

/** One request's budget: a snapshot is a few MB gzipped. */
export const STORAGE_TIMEOUT_MS = 60_000;
/** Cache headers per visibility. */
export const SNAPSHOT_CACHE_CONTROL = {
  public: "public, max-age=31536000, immutable",
  private: "private, no-store",
} as const;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KEY = /^[A-Za-z0-9._/-]{1,512}$/;
const S3_ERROR_CODE = /<Code>([A-Za-z][A-Za-z0-9.]{0,63})<\/Code>/;

/** A storage request that failed. `message` holds no credentials or response bodies. */
export class StorageError extends Error {
  override name = "StorageError";

  constructor(
    message: string,
    /** The HTTP status, or `undefined` when no response arrived. */
    readonly status?: number,
    /** S3's `<Code>` (`AccessDenied`, `NoSuchBucket`, …) when the body had one. */
    readonly s3Code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

function checkVersionAndSha(sha: string, analyzerVersion: string): void {
  if (!SHA.test(sha)) throw new Error("sha must be 40 lowercase hex characters");
  if (!VERSION.test(analyzerVersion) || analyzerVersion.includes("..")) {
    throw new Error("analyzerVersion is not a version string");
  }
}

/** The key of a public repo's snapshot. Throws on names a key can't safely hold. */
export function publicSnapshotKey(snapshot: PublicSnapshot): string {
  const { owner, repo, sha, analyzerVersion } = snapshot;
  if (!OWNER.test(owner)) throw new Error("owner is not a GitHub owner name");
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    throw new Error("repo is not a GitHub repo name");
  }
  checkVersionAndSha(sha, analyzerVersion);
  return `public/${owner.toLowerCase()}/${repo.toLowerCase()}/${sha}/${analyzerVersion}.json.gz`;
}

/** The key of a private repo's snapshot (M8). */
export function privateSnapshotKey(snapshot: PrivateSnapshot): string {
  const { installationId, repoId, sha, analyzerVersion } = snapshot;
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new Error("installationId must be a positive integer");
  }
  if (!UUID.test(repoId)) throw new Error("repoId must be a lowercase UUID");
  checkVersionAndSha(sha, analyzerVersion);
  return `private/${installationId}/${repoId}/${sha}/${analyzerVersion}.json.gz`;
}

/**
 * Read the bucket settings from `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
 * and `R2_BUCKET` (ADR-0055). Throws, naming the variable but never its value, if one is
 * missing or malformed.
 */
export function storeConfigFromEnv(env: Readonly<Record<string, string | undefined>>): StoreConfig {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`${name} is not set`);
    return value;
  };
  const accountId = read("R2_ACCOUNT_ID");
  if (!ACCOUNT_ID.test(accountId)) throw new Error("R2_ACCOUNT_ID must be 32 lowercase hex");
  const bucket = read("R2_BUCKET");
  if (!BUCKET.test(bucket)) throw new Error("R2_BUCKET is not a bucket name");
  return {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    credentials: {
      accessKeyId: read("R2_ACCESS_KEY_ID"),
      secretAccessKey: read("R2_SECRET_ACCESS_KEY"),
    },
    region: "auto",
  };
}

async function s3CodeOf(response: Response): Promise<string | undefined> {
  // Only the error code is kept; the rest of the body never leaves this function.
  const text = await response.text().catch(() => "");
  return S3_ERROR_CODE.exec(text.slice(0, 4096))?.[1];
}

/** An {@link ObjectStore} speaking S3's API with path-style URLs (`<endpoint>/<bucket>/<key>`). */
export function createObjectStore(
  config: StoreConfig,
  options: ObjectStoreOptions = {},
): ObjectStore {
  if (!BUCKET.test(config.bucket)) throw new Error("bucket is not a bucket name");
  const endpoint = new URL(config.endpoint);
  if (endpoint.pathname !== "/" || endpoint.search !== "") {
    throw new Error("endpoint must be an origin");
  }
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? STORAGE_TIMEOUT_MS;
  const scope = { region: config.region ?? "auto", service: "s3" };

  function objectUrl(key: string): URL {
    if (!KEY.test(key) || key.split("/").some((s) => s === "" || s === "." || s === "..")) {
      throw new StorageError("invalid object key");
    }
    const path = [config.bucket, ...key.split("/")].map(uriEncode).join("/");
    return new URL(`/${path}`, endpoint);
  }

  return {
    async get(key) {
      const url = objectUrl(key);
      const headers = { "x-amz-content-sha256": EMPTY_PAYLOAD_HASH, "x-amz-date": amzDate(now()) };
      const auth = authorization(
        {
          method: "GET",
          url,
          headers: { ...headers, host: url.host },
          payloadHash: EMPTY_PAYLOAD_HASH,
        },
        config.credentials,
        scope,
      );
      let response: Response;
      try {
        response = await doFetch(url, {
          headers: { ...headers, authorization: auth },
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new StorageError(`GET from ${url.host} failed`, undefined, undefined, {
          cause: error,
        });
      }
      if (response.status === 200 && response.body !== null) {
        return {
          body: response.body,
          contentType: response.headers.get("content-type") ?? undefined,
        };
      }
      const s3Code = await s3CodeOf(response);
      if (response.status === 404 && s3Code === "NoSuchKey") return undefined;
      throw new StorageError(
        `GET answered ${response.status}${s3Code === undefined ? "" : ` ${s3Code}`}`,
        response.status,
        s3Code,
      );
    },

    async put(key, body, put) {
      const url = objectUrl(key);
      const payloadHash = createHash("sha256").update(body).digest("hex");
      const headers: Record<string, string> = {
        "cache-control": put.cacheControl,
        "content-type": put.contentType,
        ...(put.contentEncoding === undefined ? {} : { "content-encoding": put.contentEncoding }),
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate(now()),
      };
      // fetch sets Host itself (to `url.host`); it is signed but not passed in.
      const auth = authorization(
        { method: "PUT", url, headers: { ...headers, host: url.host }, payloadHash },
        config.credentials,
        scope,
      );
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "PUT",
          headers: { ...headers, authorization: auth },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new StorageError(`PUT to ${url.host} failed`, undefined, undefined, { cause: error });
      }
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const s3Code = await s3CodeOf(response);
      throw new StorageError(
        `PUT answered ${response.status}${s3Code === undefined ? "" : ` ${s3Code}`}`,
        response.status,
        s3Code,
      );
    },
  };
}

/**
 * Gzip the graph at `graphPath` and store it under `key` with the cache headers for its
 * visibility. Resolves once the bucket has acknowledged the whole object.
 */
export async function uploadSnapshot(
  store: ObjectStore,
  graphPath: string,
  key: string,
  visibility: "public" | "private",
): Promise<StoredSnapshot> {
  const json = await readFile(graphPath);
  // Async, on libuv's pool: the enqueue API shares this process's event loop.
  const gzipped = await new Promise<Buffer>((resolve, reject) => {
    gzip(json, { level: constants.Z_BEST_COMPRESSION }, (error, result) =>
      error === null ? resolve(result) : reject(error),
    );
  });
  await store.put(key, gzipped, {
    contentType: "application/json",
    contentEncoding: "gzip",
    cacheControl: SNAPSHOT_CACHE_CONTROL[visibility],
  });
  return { key, bytes: json.length, storedBytes: gzipped.length };
}
