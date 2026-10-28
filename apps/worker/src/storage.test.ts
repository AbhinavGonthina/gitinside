// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeS3, type FakeS3 } from "./s3.testkit.js";
import {
  SNAPSHOT_CACHE_CONTROL,
  StorageError,
  createObjectStore,
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
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_ACCESS_KEY_ID: "key-id-value",
    R2_SECRET_ACCESS_KEY: "secret-value-never-printed",
    R2_BUCKET: "gitinside-snapshots",
  };

  it("builds R2's endpoint from the account ID", () => {
    expect(storeConfigFromEnv(env)).toEqual({
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      bucket: "gitinside-snapshots",
      credentials: { accessKeyId: "key-id-value", secretAccessKey: "secret-value-never-printed" },
      region: "auto",
    });
  });

  it.each(Object.keys(env))("names a missing %s", (name) => {
    expect(() => storeConfigFromEnv({ ...env, [name]: "" })).toThrow(`${name} is not set`);
    expect(() => storeConfigFromEnv({ ...env, [name]: undefined })).toThrow(`${name} is not set`);
  });

  it("refuses a malformed account ID or bucket without echoing it", () => {
    for (const bad of [
      { R2_ACCOUNT_ID: "evil.example.com/x" },
      { R2_BUCKET: "Bad_Bucket" },
      { R2_BUCKET: "x" },
    ]) {
      const error = (() => {
        try {
          storeConfigFromEnv({ ...env, ...bad });
        } catch (e) {
          return e as Error;
        }
        throw new Error("expected a throw");
      })();
      expect(error.message).toMatch(/^R2_(ACCOUNT_ID|BUCKET) /);
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

  it("stores an object with a signature R2 would accept", async () => {
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

  it("refuses a bad bucket or an endpoint with a path", () => {
    expect(() => createObjectStore({ ...config, bucket: "Bad" })).toThrow("bucket");
    expect(() => createObjectStore({ ...config, endpoint: `${s3.endpoint}/other` })).toThrow(
      "endpoint must be an origin",
    );
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
