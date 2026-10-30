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
 * Graph snapshots in object storage: Oracle Object Storage through its S3-compatible API
 * (ADR-0013, ADR-0062, ADR-0095; Cloudflare R2 until PROPOSALS P-2).
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
 * - **Requests** are signed with SigV4 (sigv4.ts) over the exact body hash, so the store rejects a
 *   body that changed in transit. Each request has a time budget; every failure is a
 *   {@link StorageError}, which the job reports as the retriable `PUBLISH_FAILED`.
 * - **Reads** (`get`, the web app's `/api/graph`, ADR-0068) are signed GETs; a missing
 *   object is `undefined`, any other refusal a {@link StorageError}. Exported on its own as
 *   `@gitinside/worker/storage`, so the web app reads with the code the worker writes with.
 * - **Listing and deleting** (`list`, `delete`) serve snapshot retention (retention.ts,
 *   ADR-0077): ListObjectsV2 pages parsed strictly (a page missing a field throws rather
 *   than under-count the bucket), and deletes that treat a missing object as done.
 * - **Credentials** come from `SNAPSHOTS_*` variables (ADR-0055, ADR-0095) and appear in no
 *   error or log.
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
  /**
   * `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com` (tests: a local
   * server). No trailing path; objects are addressed path-style (`/<bucket>/<key>`).
   */
  endpoint: string;
  bucket: string;
  credentials: Credentials;
  /** The signing region: Oracle's region identifier. Default `auto`. */
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

/** One object as a bucket listing reports it. */
export interface ListedObject {
  key: string;
  /** Stored bytes (gzipped for a snapshot): what counts against the quota. */
  size: number;
  lastModified: Date;
}

/** The operations the worker (put, retention's list/delete) and the web app (get, M5.8) need. */
export interface ObjectStore {
  put(key: string, body: Uint8Array, options: PutObjectOptions): Promise<void>;
  /** The object under `key`, or `undefined` if there's none (S3's `404 NoSuchKey`). */
  get(key: string): Promise<ObjectBody | undefined>;
  /**
   * Every object whose key starts with `prefix` (default all), in the bucket's key order,
   * fetched a page at a time (S3's ListObjectsV2). A page that can't be read throws.
   */
  list(prefix?: string): AsyncIterable<ListedObject>;
  /** Delete the object under `key`; deleting a missing object succeeds, as in S3. */
  delete(key: string): Promise<void>;
}

/** Options for {@link createObjectStore}. */
export interface ObjectStoreOptions {
  /** Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Per request. Default {@link STORAGE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The signing clock (tests fix it). Default now. */
  now?: () => Date;
  /** Keys per listing page (S3's `max-keys`). Default and maximum 1,000. */
  listPageSize?: number;
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
/** One DNS label: the namespace is the endpoint's first one. */
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** `us-ashburn-1`, `eu-frankfurt-1`, `us-gov-ashburn-1`, … */
const REGION = /^[a-z]{2,3}(?:-[a-z]{2,20}){1,3}-[0-9]{1,2}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KEY = /^[A-Za-z0-9._/-]{1,512}$/;
const S3_ERROR_CODE = /<Code>([A-Za-z][A-Za-z0-9.]{0,63})<\/Code>/;
const LIST_PREFIX = /^[A-Za-z0-9._/-]{0,512}$/;
const LIST_CONTENTS = /<Contents>([\s\S]*?)<\/Contents>/g;
const XML_ENTITY = /&(amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/g;
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

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
 * The host of Oracle Object Storage's S3-compatible API for a tenancy's namespace in a
 * region. The egress allowlist (infra/oracle/egress-hosts.sh) derives the same name.
 */
export function oracleS3Host(namespace: string, region: string): string {
  return `${namespace}.compat.objectstorage.${region}.oraclecloud.com`;
}

/**
 * Read the bucket settings (ADR-0055, ADR-0095): `SNAPSHOTS_NAMESPACE` and
 * `SNAPSHOTS_REGION` (Oracle Object Storage's namespace and region identifier, which name
 * the S3-compatible endpoint and the signing region), `SNAPSHOTS_ACCESS_KEY_ID` and
 * `SNAPSHOTS_SECRET_ACCESS_KEY` (a Customer Secret Key), and `SNAPSHOTS_BUCKET`. The
 * endpoint is built, not read, so a setting can't point the store at another host. Throws,
 * naming the variable but never its value, if one is missing or malformed.
 */
export function storeConfigFromEnv(env: Readonly<Record<string, string | undefined>>): StoreConfig {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`${name} is not set`);
    return value;
  };
  const namespace = read("SNAPSHOTS_NAMESPACE");
  if (!NAMESPACE.test(namespace)) {
    throw new Error("SNAPSHOTS_NAMESPACE must be a lowercase Object Storage namespace");
  }
  const region = read("SNAPSHOTS_REGION");
  if (!REGION.test(region)) {
    throw new Error("SNAPSHOTS_REGION must be an Oracle region identifier (e.g. us-ashburn-1)");
  }
  const bucket = read("SNAPSHOTS_BUCKET");
  if (!BUCKET.test(bucket)) throw new Error("SNAPSHOTS_BUCKET is not a bucket name");
  return {
    endpoint: `https://${oracleS3Host(namespace, region)}`,
    bucket,
    credentials: {
      accessKeyId: read("SNAPSHOTS_ACCESS_KEY_ID"),
      secretAccessKey: read("SNAPSHOTS_SECRET_ACCESS_KEY"),
    },
    region,
  };
}

async function s3CodeOf(response: Response): Promise<string | undefined> {
  // Only the error code is kept; the rest of the body never leaves this function.
  const text = await response.text().catch(() => "");
  return S3_ERROR_CODE.exec(text.slice(0, 4096))?.[1];
}

/** A {@link StorageError} for a response that refused `verb`, with S3's code if any. */
async function refusal(response: Response, verb: string): Promise<StorageError> {
  const s3Code = await s3CodeOf(response);
  return new StorageError(
    `${verb} answered ${response.status}${s3Code === undefined ? "" : ` ${s3Code}`}`,
    response.status,
    s3Code,
  );
}

function decodeEntity(entity: string): string {
  if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
  if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
  return XML_ENTITIES[entity] ?? "";
}

/** The decoded text of the first `<name>…</name>` in `xml`, or `undefined`. */
function xmlField(xml: string, name: string): string | undefined {
  const open = xml.indexOf(`<${name}>`);
  if (open === -1) return undefined;
  const from = open + name.length + 2;
  const close = xml.indexOf(`</${name}>`, from);
  if (close === -1) return undefined;
  return xml.slice(from, close).replace(XML_ENTITY, (_, entity: string) => decodeEntity(entity));
}

/**
 * One ListObjectsV2 page: its objects, and the token for the next page if it was cut short.
 * Throws a {@link StorageError} unless every object has a key, a size, and a date, so a
 * caller never sizes the bucket from a half-read listing.
 */
function parseListing(xml: string): { objects: ListedObject[]; next: string | undefined } {
  const unreadable = () => new StorageError("LIST answered an unreadable listing", 200);
  try {
    if (!xml.includes("<ListBucketResult")) throw unreadable();
    const objects: ListedObject[] = [];
    for (const [, block = ""] of xml.matchAll(LIST_CONTENTS)) {
      const key = xmlField(block, "Key");
      const size = xmlField(block, "Size");
      const lastModified = new Date(xmlField(block, "LastModified") ?? "");
      if (key === undefined || key === "" || size === undefined || !/^\d{1,15}$/.test(size)) {
        throw unreadable();
      }
      if (Number.isNaN(lastModified.getTime())) throw unreadable();
      objects.push({ key, size: Number(size), lastModified });
    }
    const truncated = xmlField(xml, "IsTruncated");
    if (truncated === "false") return { objects, next: undefined };
    const next = xmlField(xml, "NextContinuationToken");
    if (truncated !== "true" || next === undefined || next === "") throw unreadable();
    return { objects, next };
  } catch (error) {
    // `fromCodePoint` throws a RangeError on an entity past U+10FFFF.
    throw error instanceof StorageError ? error : unreadable();
  }
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
  const pageSize = options.listPageSize ?? 1000;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error("listPageSize must be 1–1000");
  }
  const scope = { region: config.region ?? "auto", service: "s3" };

  /** A signed request without a body; `failure` is the message if no response arrives. */
  async function send(method: "GET" | "DELETE", url: URL, failure: string): Promise<Response> {
    const headers = { "x-amz-content-sha256": EMPTY_PAYLOAD_HASH, "x-amz-date": amzDate(now()) };
    const auth = authorization(
      { method, url, headers: { ...headers, host: url.host }, payloadHash: EMPTY_PAYLOAD_HASH },
      config.credentials,
      scope,
    );
    try {
      return await doFetch(url, {
        method,
        headers: { ...headers, authorization: auth },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new StorageError(failure, undefined, undefined, { cause: error });
    }
  }

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
      const response = await send("GET", url, `GET from ${url.host} failed`);
      if (response.status === 200 && response.body !== null) {
        return {
          body: response.body,
          contentType: response.headers.get("content-type") ?? undefined,
        };
      }
      const error = await refusal(response, "GET");
      if (error.status === 404 && error.s3Code === "NoSuchKey") return undefined;
      throw error;
    },

    async *list(prefix = "") {
      if (!LIST_PREFIX.test(prefix)) throw new StorageError("invalid listing prefix");
      let token: string | undefined;
      do {
        const url = new URL(`/${uriEncode(config.bucket)}`, endpoint);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("max-keys", String(pageSize));
        if (prefix !== "") url.searchParams.set("prefix", prefix);
        if (token !== undefined) url.searchParams.set("continuation-token", token);
        const response = await send("GET", url, `LIST from ${url.host} failed`);
        if (response.status !== 200) throw await refusal(response, "LIST");
        let xml: string;
        try {
          xml = await response.text();
        } catch (error) {
          throw new StorageError(`LIST from ${url.host} failed`, 200, undefined, { cause: error });
        }
        const page = parseListing(xml);
        if (page.next !== undefined && page.next === token) {
          throw new StorageError("LIST answered the same page twice", 200);
        }
        yield* page.objects;
        token = page.next;
      } while (token !== undefined);
    },

    async delete(key) {
      const url = objectUrl(key);
      const response = await send("DELETE", url, `DELETE at ${url.host} failed`);
      if (response.status === 204 || response.status === 200) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const error = await refusal(response, "DELETE");
      if (error.status === 404 && error.s3Code === "NoSuchKey") return;
      throw error;
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
      throw await refusal(response, "PUT");
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
