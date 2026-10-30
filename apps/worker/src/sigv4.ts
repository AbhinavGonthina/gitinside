import { createHash, createHmac } from "node:crypto";
import { compareStrings } from "@gitinside/schema";

/**
 * AWS Signature Version 4, the request signing S3-compatible APIs (Oracle Object
 * Storage's, R2's) accept (ADR-0062).
 *
 * Hand-written instead of pulling in an AWS SDK: the worker only ever signs a handful of
 * object requests, and SigV4 is a fixed recipe of SHA-256 and HMAC-SHA256 that
 * `node:crypto` already has (SECURITY.md T12, minimal dependencies). The tests check it
 * against the worked examples in AWS's documentation.
 *
 * ```text
 * canonical request = METHOD \n path \n sorted query \n "name:value\n"… \n signed names \n payload hash
 * string to sign    = AWS4-HMAC-SHA256 \n <amz date> \n <scope> \n hex(sha256(canonical request))
 * signing key       = HMAC("AWS4" + secret, date) → region → service → "aws4_request"
 * ```
 *
 * Paths are signed as S3 expects: each segment percent-encoded once (RFC 3986 unreserved
 * characters kept), `/` kept, never double-encoded.
 */

/** The hash S3 expects in `x-amz-content-sha256` for an empty body. */
export const EMPTY_PAYLOAD_HASH = createHash("sha256").update("").digest("hex");

/** An access key pair. */
export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** What a signature is bound to besides the request: the bucket's region (Oracle's region identifier) and `s3`. */
export interface SigningScope {
  region: string;
  service: string;
}

/** The request as it will be sent. Every header in `headers` is signed. */
export interface SignableRequest {
  method: string;
  url: URL;
  /** Must include `host` and `x-amz-date`. Names in any case. */
  headers: Readonly<Record<string, string>>;
  /** Lowercase hex SHA-256 of the body. */
  payloadHash: string;
}

/** Percent-encode like SigV4's `UriEncode`: everything but `A–Z a–z 0–9 - . _ ~`. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20130524T000000Z` for a time. */
export function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
const hmac = (key: Buffer | string, text: string): Buffer =>
  createHmac("sha256", key).update(text).digest();

function canonicalPath(url: URL): string {
  // `URL` already percent-encodes some characters; decode first so nothing is encoded twice.
  return url.pathname
    .split("/")
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
  pairs.sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  text: string;
  signed: string;
} {
  const entries = Object.entries(headers).map(
    ([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const,
  );
  entries.sort((a, b) => compareStrings(a[0], b[0]));
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]?.[0] === entries[i - 1]?.[0]) {
      throw new Error(`header ${entries[i]?.[0] ?? ""} given twice`);
    }
  }
  return {
    text: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  };
}

/** The canonical request text (step 1 of the recipe); exposed for tests and debugging. */
export function canonicalRequest(request: SignableRequest): string {
  const headers = canonicalHeaders(request.headers);
  return [
    request.method.toUpperCase(),
    canonicalPath(request.url),
    canonicalQuery(request.url),
    headers.text,
    headers.signed,
    request.payloadHash,
  ].join("\n");
}

/**
 * The `Authorization` header value for `request`. The request's `x-amz-date` header must be
 * {@link amzDate} of the same instant the scope's date is taken from, so it is read from
 * the headers rather than passed separately.
 */
export function authorization(
  request: SignableRequest,
  credentials: Credentials,
  scope: SigningScope,
): string {
  const date = Object.entries(request.headers).find(
    ([name]) => name.toLowerCase() === "x-amz-date",
  )?.[1];
  if (date === undefined || !/^\d{8}T\d{6}Z$/.test(date)) {
    throw new Error("x-amz-date header missing or malformed");
  }
  const day = date.slice(0, 8);
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    credentialScope,
    sha256Hex(canonicalRequest(request)),
  ].join("\n");
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  key = hmac(key, scope.region);
  key = hmac(key, scope.service);
  key = hmac(key, "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return (
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${canonicalHeaders(request.headers).signed}, Signature=${signature}`
  );
}
