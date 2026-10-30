// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { s3Error, startFakeS3, type FakeS3 } from "./s3.testkit.js";
import {
  SNAPSHOT_CACHE_CONTROL,
  StorageError,
  countingFetch,
  createObjectStore,
  oracleS3Host,
  privateSnapshotKey,
  publicSnapshotKey,
  storeConfigFromEnv,
  uploadSnapshot,
  type StoreConfig,
} from "./storage.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("publicSnapshotKey", () => {
  it("names repo, commit, and analyzer version, lowercasing GitHub names", () => {
    expect(
      publicSnapshotKey({
        owner: "Acme-Co",
        repo: "Shop.Web_2",
        sha: SHA,
        analyzerVersion: "0.1.0",
      }),
    ).toBe(`public/acme-co/shop.web_2/${SHA}/0.1.0.json.gz`);
  });

  it.each([
    ["owner", { owner: "a/b" }],
    ["owner", { owner: "-acme" }],
    ["repo", { repo: ".." }],
    ["repo", { repo: "a/b" }],
    ["repo", { repo: "" }],
    ["sha", { sha: SHA.toUpperCase() }],
    ["sha", { sha: "abc" }],
    ["analyzerVersion", { analyzerVersion: "../x" }],
    ["analyzerVersion", { analyzerVersion: "1..2" }],
    ["analyzerVersion", { analyzerVersion: "1/2" }],
    ["analyzerVersion", { analyzerVersion: "" }],
  ])("refuses a bad %s", (field, change) => {
    expect(() =>
      publicSnapshotKey({
        owner: "acme",
        repo: "shop",
        sha: SHA,
        analyzerVersion: "0.1.0",
        ...change,
      }),
    ).toThrow(field);
  });
});

describe("privateSnapshotKey", () => {
  const repoId = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

  it("keys by installation and repo row, under private/", () => {
    expect(
      privateSnapshotKey({ installationId: 42, repoId, sha: SHA, analyzerVersion: "0.1.0" }),
    ).toBe(`private/42/${repoId}/${SHA}/0.1.0.json.gz`);
  });

  it.each([
    ["installationId", { installationId: 0 }],
    ["installationId", { installationId: 1.5 }],
    ["repoId", { repoId: "../../public" }],
    ["repoId", { repoId: repoId.toUpperCase() }],
    ["sha", { sha: "x" }],
  ])("refuses a bad %s", (field, change) => {
    expect(() =>
      privateSnapshotKey({
        installationId: 42,
        repoId,
        sha: SHA,
        analyzerVersion: "0.1.0",
        ...change,
      }),
    ).toThrow(field);
  });
});

describe("storeConfigFromEnv", () => {
  const env = {
    SNAPSHOTS_NAMESPACE: "axq1ns2example",
    SNAPSHOTS_REGION: "us-ashburn-1",
    SNAPSHOTS_ACCESS_KEY_ID: "key-id-value",
    SNAPSHOTS_SECRET_ACCESS_KEY: "secret-value-never-printed",
    SNAPSHOTS_BUCKET: "gitinside-snapshots",
  };

  it("builds Oracle's S3-compatible endpoint and signs with the region", () => {
    expect(storeConfigFromEnv(env)).toEqual({
      endpoint: "https://axq1ns2example.compat.objectstorage.us-ashburn-1.oraclecloud.com",
      bucket: "gitinside-snapshots",
      credentials: { accessKeyId: "key-id-value", secretAccessKey: "secret-value-never-printed" },
      region: "us-ashburn-1",
    });
    expect(oracleS3Host("ns", "eu-frankfurt-1")).toBe(
      "ns.compat.objectstorage.eu-frankfurt-1.oraclecloud.com",
    );
  });

  it("accepts other region identifiers", () => {
    for (const region of [
      "eu-frankfurt-1",
      "us-gov-ashburn-1",
      "ap-chuncheon-1",
      "sa-saopaulo-1",
    ]) {
      expect(storeConfigFromEnv({ ...env, SNAPSHOTS_REGION: region }).region).toBe(region);
    }
  });

  it.each(Object.keys(env))("names a missing %s", (name) => {
    expect(() => storeConfigFromEnv({ ...env, [name]: "" })).toThrow(`${name} is not set`);
    expect(() => storeConfigFromEnv({ ...env, [name]: undefined })).toThrow(`${name} is not set`);
  });

  it("refuses a namespace, region, or bucket that could change the host, without echoing it", () => {
    for (const bad of [
      { SNAPSHOTS_NAMESPACE: "evil.example.com/x" },
      { SNAPSHOTS_NAMESPACE: "evil.example.com#" },
      { SNAPSHOTS_NAMESPACE: "Upper" },
      { SNAPSHOTS_NAMESPACE: "-dash" },
      { SNAPSHOTS_REGION: "us-ashburn-1.evil.example" },
      { SNAPSHOTS_REGION: "x" },
      { SNAPSHOTS_REGION: "US-ASHBURN-1" },
      { SNAPSHOTS_BUCKET: "Bad_Bucket" },
      { SNAPSHOTS_BUCKET: "x" },
    ]) {
      const error = (() => {
        try {
          storeConfigFromEnv({ ...env, ...bad });
        } catch (e) {
          return e as Error;
        }
        throw new Error("expected a throw");
      })();
      expect(error.message).toMatch(/^SNAPSHOTS_(NAMESPACE|REGION|BUCKET) /);
      expect(error.message).not.toContain(Object.values(bad)[0]);
    }
  });
});

describe("createObjectStore", () => {
  let s3: FakeS3;
  let config: StoreConfig;

  beforeEach(async () => {
    s3 = await startFakeS3();
    config = { endpoint: s3.endpoint, bucket: s3.bucket, credentials: s3.credentials };
  });
  afterEach(() => s3.close());

  const options = { contentType: "application/json", cacheControl: "no-store" };

  it("stores an object with a signature an S3-compatible store would accept", async () => {
    const store = createObjectStore(config, { now: () => new Date("2026-10-28T12:00:00Z") });
    await store.put("public/acme/shop/x.json.gz", Buffer.from("hello"), {
      ...options,
      contentEncoding: "gzip",
    });
    const stored = s3.objects.get("public/acme/shop/x.json.gz");
    expect(stored?.body.toString()).toBe("hello");
    expect(stored?.headers).toMatchObject({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "cache-control": "no-store",
      "x-amz-date": "20261028T120000Z",
    });
    // The local port is part of the signed host, as fetch sends it.
    expect(stored?.headers.host).toBe(new URL(s3.endpoint).host);
    expect(s3.requests[0]?.url).toBe("/gitinside-snapshots/public/acme/shop/x.json.gz");
  });

  it("signs for the configured region, as Oracle's endpoint checks it", async () => {
    const oracle = await startFakeS3(undefined, undefined, "us-ashburn-1");
    try {
      const at = {
        endpoint: oracle.endpoint,
        bucket: oracle.bucket,
        credentials: oracle.credentials,
      };
      await createObjectStore({ ...at, region: "us-ashburn-1" }).put(
        "k",
        Buffer.from("x"),
        options,
      );
      expect(oracle.objects.get("k")?.body.toString()).toBe("x");
      await expect(
        createObjectStore({ ...at, region: "eu-frankfurt-1" }).put("j", Buffer.from("y"), options),
      ).rejects.toMatchObject({ status: 403, s3Code: "SignatureDoesNotMatch" });
      // Without a region the store signs with `auto`, which a regional endpoint refuses.
      await expect(createObjectStore(at).get("k")).rejects.toMatchObject({ status: 403 });
    } finally {
      await oracle.close();
    }
  });

  it("fails with S3's code, and nothing of the secret or the body, on a bad signature", async () => {
    const store = createObjectStore({
      ...config,
      credentials: { accessKeyId: s3.credentials.accessKeyId, secretAccessKey: "wrong-secret-xyz" },
    });
    const error = await store.put("k", Buffer.from("x"), options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ status: 403, s3Code: "SignatureDoesNotMatch" });
    expect((error as Error).message).toBe("PUT answered 403 SignatureDoesNotMatch");
    expect(s3.objects.size).toBe(0);
  });

  it("refuses a body changed in transit", async () => {
    const tampering: typeof fetch = (input, init) =>
      fetch(input, { ...init, body: Buffer.from("changed") });
    const store = createObjectStore(config, { fetch: tampering });
    await expect(store.put("k", Buffer.from("original"), options)).rejects.toMatchObject({
      status: 400,
      s3Code: "XAmzContentSHA256Mismatch",
    });
  });

  it("reports a status without an S3 code when the body has none", async () => {
    s3.handler = (_req, _body, res) => {
      res.writeHead(502);
      res.end("<html>bad gateway</html>");
    };
    const error = await createObjectStore(config)
      .put("k", Buffer.from("x"), options)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, s3Code: undefined, message: "PUT answered 502" });
  });

  it("fails when no response arrives, naming only the host", async () => {
    const store = createObjectStore(config);
    await s3.close();
    const error = await store.put("k", Buffer.from("x"), options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ status: undefined });
    expect((error as Error).message).toBe(`PUT to ${new URL(s3.endpoint).host} failed`);
    s3 = await startFakeS3(); // for afterEach
  });

  it("gives up after its time budget", async () => {
    s3.handler = () => undefined; // never answers
    const store = createObjectStore(config, { timeoutMs: 100 });
    await expect(store.put("k", Buffer.from("x"), options)).rejects.toBeInstanceOf(StorageError);
  });

  it.each(["", "a//b", "../x", "a/./b", "a b", "a/b/", "é"])(
    "refuses the key %j unsent",
    async (key) => {
      await expect(createObjectStore(config).put(key, Buffer.from("x"), options)).rejects.toThrow(
        "invalid object key",
      );
      expect(s3.requests).toHaveLength(0);
    },
  );

  it("reads back what it stored, a gzipped object decoded", async () => {
    const store = createObjectStore(config);
    const json = '{"nodes":[]}';
    await store.put("public/acme/shop/x.json.gz", gzipSync(json), {
      contentType: "application/json",
      contentEncoding: "gzip",
      cacheControl: SNAPSHOT_CACHE_CONTROL.public,
    });
    const object = await store.get("public/acme/shop/x.json.gz");
    expect(object?.contentType).toBe("application/json");
    expect(await new Response(object?.body).text()).toBe(json);
    const get = s3.requests.at(-1);
    expect(get).toMatchObject({
      method: "GET",
      url: "/gitinside-snapshots/public/acme/shop/x.json.gz",
    });
    expect(get?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("answers undefined for a missing object", async () => {
    await expect(createObjectStore(config).get("public/acme/shop/none.json.gz")).resolves.toBe(
      undefined,
    );
  });

  it("fails reads with S3's code on other refusals, a 404 without NoSuchKey included", async () => {
    const wrong = createObjectStore({
      ...config,
      credentials: { accessKeyId: s3.credentials.accessKeyId, secretAccessKey: "wrong-secret-xyz" },
    });
    await expect(wrong.get("k")).rejects.toMatchObject({
      status: 403,
      s3Code: "SignatureDoesNotMatch",
      message: "GET answered 403 SignatureDoesNotMatch",
    });
    const otherBucket = createObjectStore({ ...config, bucket: "other-bucket" });
    await expect(otherBucket.get("k")).rejects.toMatchObject({
      status: 404,
      s3Code: "NoSuchBucket",
    });
    s3.handler = (_req, _body, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    };
    await expect(createObjectStore(config).get("k")).rejects.toMatchObject({
      status: 302,
      message: "GET answered 302",
    });
  });

  it("fails a read when no response arrives, and refuses bad keys unsent", async () => {
    const store = createObjectStore(config);
    await expect(store.get("../x")).rejects.toThrow("invalid object key");
    expect(s3.requests).toHaveLength(0);
    await s3.close();
    await expect(store.get("k")).rejects.toMatchObject({
      status: undefined,
      message: `GET from ${new URL(s3.endpoint).host} failed`,
    });
    s3 = await startFakeS3(); // for afterEach
  });

  it("refuses a bad bucket or an endpoint with a path", () => {
    expect(() => createObjectStore({ ...config, bucket: "Bad" })).toThrow("bucket");
    expect(() => createObjectStore({ ...config, endpoint: `${s3.endpoint}/other` })).toThrow(
      "endpoint must be an origin",
    );
    for (const listPageSize of [0, 1001, 1.5]) {
      expect(() => createObjectStore(config, { listPageSize })).toThrow("listPageSize");
    }
  });

  async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
    const items: unknown[] = [];
    for await (const item of iterable) items.push(item);
    return items;
  }

  function stored(key: string, bytes: number, lastModified: Date) {
    s3.objects.set(key, { body: Buffer.alloc(bytes), headers: {}, lastModified });
  }

  it("lists every object with its size and date, across pages, under a prefix", async () => {
    const day = new Date("2026-10-01T00:00:00.000Z");
    stored("public/b/1.json.gz", 10, day);
    stored("public/a/2.json.gz", 20, day);
    stored("public/a/1.json.gz", 30, day);
    stored("private/1/x.json.gz", 40, day);
    stored("public/odd&<name>.json.gz", 5, day);
    const store = createObjectStore(config, { listPageSize: 2 });

    const all = await collect(store.list());
    expect(all).toEqual([
      { key: "private/1/x.json.gz", size: 40, lastModified: day },
      { key: "public/a/1.json.gz", size: 30, lastModified: day },
      { key: "public/a/2.json.gz", size: 20, lastModified: day },
      { key: "public/b/1.json.gz", size: 10, lastModified: day },
      { key: "public/odd&<name>.json.gz", size: 5, lastModified: day },
    ]);
    const lists = s3.requests.filter((r) => r.url.startsWith("/gitinside-snapshots?"));
    expect(lists).toHaveLength(3);
    expect(lists[1]?.url).toContain("continuation-token=");

    expect((await collect(store.list("public/a/"))).map((o) => (o as { key: string }).key)).toEqual(
      ["public/a/1.json.gz", "public/a/2.json.gz"],
    );
    expect(await collect(store.list("nothing/"))).toEqual([]);
  });

  it("refuses a listing it can't read completely, instead of under-counting", async () => {
    const store = createObjectStore(config);
    const answers = [
      "<html>not a listing</html>",
      "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key><LastModified>2026-10-01T00:00:00Z</LastModified></Contents></ListBucketResult>",
      "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key><Size>-1</Size><LastModified>2026-10-01T00:00:00Z</LastModified></Contents></ListBucketResult>",
      "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key><Size>1</Size><LastModified>soon</LastModified></Contents></ListBucketResult>",
      "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>&#9999999;</Key><Size>1</Size><LastModified>2026-10-01T00:00:00Z</LastModified></Contents></ListBucketResult>",
      "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
      "<ListBucketResult></ListBucketResult>",
    ];
    for (const xml of answers) {
      s3.handler = (_req, _body, res) => {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(xml);
      };
      await expect(collect(store.list())).rejects.toMatchObject({
        name: "StorageError",
        message: "LIST answered an unreadable listing",
      });
    }
  });

  it("stops when a listing hands back the token it was given", async () => {
    s3.handler = (_req, _body, res) => {
      res.writeHead(200);
      res.end(
        "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t</NextContinuationToken></ListBucketResult>",
      );
    };
    await expect(collect(createObjectStore(config).list())).rejects.toThrow(
      "LIST answered the same page twice",
    );
    expect(s3.requests).toHaveLength(2);
  });

  it("fails a refused or unanswered listing, and refuses a bad prefix unsent", async () => {
    const store = createObjectStore(config);
    await expect(collect(store.list("a b"))).rejects.toThrow("invalid listing prefix");
    expect(s3.requests).toHaveLength(0);
    const wrong = createObjectStore({
      ...config,
      credentials: { accessKeyId: s3.credentials.accessKeyId, secretAccessKey: "wrong-secret-xyz" },
    });
    await expect(collect(wrong.list())).rejects.toMatchObject({
      status: 403,
      message: "LIST answered 403 SignatureDoesNotMatch",
    });
    await s3.close();
    await expect(collect(store.list())).rejects.toMatchObject({
      status: undefined,
      message: `LIST from ${new URL(s3.endpoint).host} failed`,
    });
    s3 = await startFakeS3(); // for afterEach
  });

  it("deletes an object, and treats a missing one as deleted", async () => {
    stored("public/a/1.json.gz", 3, new Date());
    const store = createObjectStore(config);
    await store.delete("public/a/1.json.gz");
    expect(s3.objects.has("public/a/1.json.gz")).toBe(false);
    await store.delete("public/a/1.json.gz");
    expect(s3.requests.at(-1)).toMatchObject({ method: "DELETE" });

    s3.handler = (_req, _body, res) => s3Error(res, 404, "NoSuchKey");
    await expect(store.delete("public/a/1.json.gz")).resolves.toBeUndefined();
    s3.handler = (_req, _body, res) => s3Error(res, 403, "AccessDenied");
    await expect(store.delete("public/a/1.json.gz")).rejects.toMatchObject({
      status: 403,
      message: "DELETE answered 403 AccessDenied",
    });
    await expect(store.delete("../x")).rejects.toThrow("invalid object key");
    await s3.close();
    await expect(store.delete("k")).rejects.toMatchObject({
      message: `DELETE at ${new URL(s3.endpoint).host} failed`,
    });
    s3 = await startFakeS3(); // for afterEach
  });
});

describe("countingFetch", () => {
  const ok = () => Promise.resolve(new Response("ok"));

  it("counts every request, refused or failed, and returns the response untouched", async () => {
    let counted = 0;
    const responses = [new Response("a"), new Response("no", { status: 403 })];
    const counting = countingFetch({
      count: async () => void counted++,
      onCountError: () => expect.unreachable(),
      fetch: async () => {
        const next = responses.shift();
        if (next === undefined) throw new TypeError("fetch failed");
        return next;
      },
    });
    expect(await (await counting("https://x.example/a")).text()).toBe("a");
    expect((await counting("https://x.example/b")).status).toBe(403);
    await expect(counting("https://x.example/c")).rejects.toThrow("fetch failed");
    expect(counted).toBe(3);
  });

  it("waits for the count before answering", async () => {
    let finishCount: () => void = () => undefined;
    let answered = false;
    const counting = countingFetch({
      count: () => new Promise<void>((resolve) => (finishCount = resolve)),
      onCountError: () => expect.unreachable(),
      fetch: ok,
    });
    const answer = counting("https://x.example/").then(() => (answered = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answered).toBe(false);
    finishCount();
    await answer;
    expect(answered).toBe(true);
  });

  it("reports a failed count, thrown or rejected, and still answers", async () => {
    const errors: unknown[] = [];
    for (const count of [
      () => Promise.reject(new Error("rejected")),
      () => {
        throw new Error("thrown");
      },
    ]) {
      const counting = countingFetch({ count, onCountError: (e) => errors.push(e), fetch: ok });
      expect(await (await counting("https://x.example/")).text()).toBe("ok");
    }
    expect(errors.map((e) => (e as Error).message)).toEqual(["rejected", "thrown"]);
  });

  it("counts each request a store makes, listing pages included", async () => {
    const s3 = await startFakeS3();
    try {
      for (const name of ["a", "b", "c"]) {
        s3.objects.set(name, { body: Buffer.alloc(1), headers: {}, lastModified: new Date(0) });
      }
      let counted = 0;
      const store = createObjectStore(
        { endpoint: s3.endpoint, bucket: s3.bucket, credentials: s3.credentials },
        {
          listPageSize: 2,
          fetch: countingFetch({ count: async () => void counted++, onCountError: () => {} }),
        },
      );
      const keys: string[] = [];
      for await (const object of store.list()) keys.push(object.key);
      expect(keys).toEqual(["a", "b", "c"]);
      expect(counted).toBe(2);
      await store.delete("a");
      expect(counted).toBe(3);
    } finally {
      await s3.close();
    }
  });
});

describe("uploadSnapshot", () => {
  let s3: FakeS3;
  let dir: string;

  beforeEach(async () => {
    s3 = await startFakeS3();
    dir = await mkdtemp(join(tmpdir(), "gi-storage-"));
  });
  afterEach(async () => {
    await s3.close();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["public", "private"] as const)(
    "stores a %s graph gzipped with its cache headers",
    async (visibility) => {
      const json = `${JSON.stringify({ nodes: Array.from({ length: 500 }, (_, i) => ({ id: `n${i}` })) })}\n`;
      const graphPath = join(dir, "architecture.json");
      await writeFile(graphPath, json);
      const store = createObjectStore({
        endpoint: s3.endpoint,
        bucket: s3.bucket,
        credentials: s3.credentials,
      });

      const stored = await uploadSnapshot(
        store,
        graphPath,
        "public/acme/shop/g.json.gz",
        visibility,
      );

      const object = s3.objects.get("public/acme/shop/g.json.gz");
      expect(object).toBeDefined();
      expect(gunzipSync(object?.body ?? Buffer.alloc(0)).toString()).toBe(json);
      expect(object?.headers).toMatchObject({
        "content-type": "application/json",
        "content-encoding": "gzip",
        "cache-control": SNAPSHOT_CACHE_CONTROL[visibility],
      });
      expect(stored).toEqual({
        key: "public/acme/shop/g.json.gz",
        bytes: Buffer.byteLength(json),
        storedBytes: object?.body.length,
      });
      expect(stored.storedBytes).toBeLessThan(stored.bytes / 5);
    },
  );

  it("fails before any request when the graph file is missing", async () => {
    const store = createObjectStore({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      credentials: s3.credentials,
    });
    await expect(
      uploadSnapshot(store, join(dir, "missing.json"), "k", "public"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(s3.requests).toHaveLength(0);
  });
});
