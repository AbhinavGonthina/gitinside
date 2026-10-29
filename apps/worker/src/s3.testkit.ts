import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { authorization, type Credentials } from "./sigv4.js";

/**
 * A fake S3 bucket for tests, on 127.0.0.1. It checks each request the way R2 does:
 * the SigV4 signature (recomputed from the headers the request says it signed) and the
 * body against `x-amz-content-sha256`. A good `PUT /<bucket>/<key>` is stored in
 * {@link FakeS3.objects} and a good `GET` returns it (`404 NoSuchKey` if absent); anything
 * else gets S3's XML error. `handler` can be replaced
 * per test; every request is recorded.
 */
export interface StoredObject {
  body: Buffer;
  headers: Record<string, string>;
}

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  credentials: Credentials;
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

/** Start a fake bucket named `bucket` accepting `credentials`. */
export async function startFakeS3(
  bucket = "gitinside-snapshots",
  credentials: Credentials = { accessKeyId: "test-key-id", secretAccessKey: "test-secret-key" },
): Promise<FakeS3> {
  const fake = { bucket, credentials, objects: new Map(), requests: [] } as unknown as FakeS3;

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
      { region: "auto", service: "s3" },
    );
    if (expected !== given) return s3Error(res, 403, "SignatureDoesNotMatch");
    const prefix = `/${bucket}/`;
    const url = req.url ?? "";
    if (!url.startsWith(prefix)) return s3Error(res, 404, "NoSuchBucket");
    const key = decodeURIComponent(url.slice(prefix.length));
    if (req.method === "GET") {
      const object = fake.objects.get(key);
      if (object === undefined) return s3Error(res, 404, "NoSuchKey");
      // Served with the headers it was stored with, as R2 does.
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
    fake.objects.set(key, { body, headers });
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
