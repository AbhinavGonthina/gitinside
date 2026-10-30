import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { authorization, type Credentials } from "./sigv4.js";

/**
 * A fake S3 bucket for tests, on 127.0.0.1. It checks each request the way an
 * S3-compatible store (Oracle Object Storage, R2) does:
 * the SigV4 signature (recomputed from the headers the request says it signed) and the
 * body against `x-amz-content-sha256`. A good `PUT /<bucket>/<key>` is stored in
 * {@link FakeS3.objects}, a good `GET` returns it (`404 NoSuchKey` if absent), `DELETE`
 * removes it (`204` either way), and `GET /<bucket>?list-type=2` lists keys in order, paged
 * by `max-keys` with a continuation token; anything else gets S3's XML error. `handler` can
 * be replaced per test; every request is recorded.
 */
export interface StoredObject {
  body: Buffer;
  headers: Record<string, string>;
  /** Default: when it was stored. Tests set it to age an object. */
  lastModified?: Date;
}

const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function listing(fake: FakeS3, query: URLSearchParams, res: ServerResponse): void {
  const prefix = query.get("prefix") ?? "";
  const maxKeys = Number(query.get("max-keys") ?? "1000");
  const after = query.get("continuation-token");
  const start = after === null ? "" : Buffer.from(after, "base64").toString();
  const keys = [...fake.objects.keys()]
    .filter((key) => key.startsWith(prefix) && key > start)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const page = keys.slice(0, maxKeys);
  const truncated = keys.length > page.length;
  const contents = page.map((key) => {
    const object = fake.objects.get(key) as StoredObject;
    return (
      `<Contents><Key>${xmlEscape(key)}</Key>` +
      `<LastModified>${(object.lastModified ?? new Date()).toISOString()}</LastModified>` +
      `<ETag>&quot;x&quot;</ETag><Size>${object.body.length}</Size>` +
      `<StorageClass>STANDARD</StorageClass></Contents>`
    );
  });
  const next = truncated
    ? `<NextContinuationToken>${Buffer.from(page.at(-1) ?? "").toString("base64")}</NextContinuationToken>`
    : "";
  res.writeHead(200, { "content-type": "application/xml" });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${fake.bucket}</Name>` +
      `<Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
      `<MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}` +
      `${contents.join("")}</ListBucketResult>`,
  );
}

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  credentials: Credentials;
  /** The signing region it checks (Oracle's region identifier, or R2's `auto`). */
  region: string;
  objects: Map<string, StoredObject>;
  requests: { method: string; url: string; headers: IncomingMessage["headers"] }[];
  /** Answers after the body is read; the default checks and stores. */
  handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void;
  close(): Promise<void>;
}

export function s3Error(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
      `<Message>secret-looking detail that must not be kept</Message></Error>`,
  );
}

const AUTH =
  /^AWS4-HMAC-SHA256 Credential=[^,]+, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$/;

/** Start a fake bucket named `bucket` accepting `credentials` signed for `region`. */
export async function startFakeS3(
  bucket = "gitinside-snapshots",
  credentials: Credentials = { accessKeyId: "test-key-id", secretAccessKey: "test-secret-key" },
  region = "auto",
): Promise<FakeS3> {
  const fake = {
    bucket,
    credentials,
    region,
    objects: new Map(),
    requests: [],
  } as unknown as FakeS3;

  fake.handler = (req, body, res) => {
    const given = req.headers.authorization ?? "";
    const signed = AUTH.exec(given)?.[1];
    if (signed === undefined) return s3Error(res, 403, "AccessDenied");
    const headers: Record<string, string> = {};
    for (const name of signed.split(";")) {
      const value = req.headers[name];
      if (typeof value !== "string") return s3Error(res, 403, "AccessDenied");
      headers[name] = value;
    }
    const payloadHash = createHash("sha256").update(body).digest("hex");
    if (headers["x-amz-content-sha256"] !== payloadHash) {
      return s3Error(res, 400, "XAmzContentSHA256Mismatch");
    }
    const expected = authorization(
      { method: req.method ?? "", url: new URL(req.url ?? "/", "http://x"), headers, payloadHash },
      credentials,
      { region, service: "s3" },
    );
    if (expected !== given) return s3Error(res, 403, "SignatureDoesNotMatch");
    const prefix = `/${bucket}/`;
    const url = req.url ?? "";
    const parsed = new URL(url, "http://x");
    if (req.method === "GET" && parsed.pathname === `/${bucket}`) {
      if (parsed.searchParams.get("list-type") !== "2") return s3Error(res, 400, "InvalidArgument");
      return listing(fake, parsed.searchParams, res);
    }
    if (!url.startsWith(prefix)) return s3Error(res, 404, "NoSuchBucket");
    const key = decodeURIComponent(url.slice(prefix.length));
    if (req.method === "DELETE") {
      fake.objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET") {
      const object = fake.objects.get(key);
      if (object === undefined) return s3Error(res, 404, "NoSuchKey");
      // Served with the headers it was stored with, as S3 does.
      const { "content-type": type, "content-encoding": encoding } = object.headers;
      res.writeHead(200, {
        ...(type === undefined ? {} : { "content-type": type }),
        ...(encoding === undefined ? {} : { "content-encoding": encoding }),
        "content-length": object.body.length,
      });
      res.end(object.body);
      return;
    }
    if (req.method !== "PUT") return s3Error(res, 405, "MethodNotAllowed");
    fake.objects.set(key, { body, headers, lastModified: new Date() });
    res.writeHead(200, { etag: '"x"' });
    res.end();
  };

  const server = createServer((req, res) => {
    fake.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => fake.handler(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  fake.endpoint = `http://127.0.0.1:${port}`;
  fake.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}
