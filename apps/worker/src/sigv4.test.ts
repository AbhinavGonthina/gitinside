import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EMPTY_PAYLOAD_HASH,
  amzDate,
  authorization,
  canonicalRequest,
  uriEncode,
} from "./sigv4.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// The worked examples from AWS's documentation, with their published results.
describe("AWS documentation examples", () => {
  it("signs the IAM ListUsers example (General Reference, SigV4 tasks 1–4)", () => {
    const request = {
      method: "GET",
      url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Host: "iam.amazonaws.com",
        "X-Amz-Date": "20150830T123600Z",
      },
      payloadHash: EMPTY_PAYLOAD_HASH,
    };
    expect(sha256(canonicalRequest(request))).toBe(
      "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
    );
    expect(
      authorization(
        request,
        {
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        },
        { region: "us-east-1", service: "iam" },
      ),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  const s3Credentials = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const s3 = { region: "us-east-1", service: "s3" };

  it("signs the S3 GET Object example", () => {
    const header = authorization(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: {
          Host: "examplebucket.s3.amazonaws.com",
          Range: "bytes=0-9",
          "x-amz-content-sha256": EMPTY_PAYLOAD_HASH,
          "x-amz-date": "20130524T000000Z",
        },
        payloadHash: EMPTY_PAYLOAD_HASH,
      },
      s3Credentials,
      s3,
    );
    expect(header).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("signs the S3 PUT Object example (a `$` in the key is encoded once)", () => {
    const payloadHash = sha256("Welcome to Amazon S3.");
    expect(payloadHash).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const header = authorization(
      {
        method: "PUT",
        url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
        headers: {
          Date: "Fri, 24 May 2013 00:00:00 GMT",
          Host: "examplebucket.s3.amazonaws.com",
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": "20130524T000000Z",
          "x-amz-storage-class": "REDUCED_REDUNDANCY",
        },
        payloadHash,
      },
      s3Credentials,
      s3,
    );
    expect(header).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });
});

describe("canonicalRequest", () => {
  const base = {
    method: "put",
    headers: { host: "h", "x-amz-date": "20261028T000000Z" },
    payloadHash: EMPTY_PAYLOAD_HASH,
  };

  it("encodes each path segment once and keeps the slashes", () => {
    const text = canonicalRequest({
      ...base,
      url: new URL("https://h/bucket/a b/c%20d/e+f/x(1)~.json.gz"),
    });
    expect(text.split("\n").slice(0, 2)).toEqual([
      "PUT",
      "/bucket/a%20b/c%20d/e%2Bf/x%281%29~.json.gz",
    ]);
  });

  it("sorts and encodes the query", () => {
    const text = canonicalRequest({ ...base, url: new URL("https://h/?b=2&a=x y&a=1&c") });
    expect(text.split("\n")[2]).toBe("a=1&a=x%20y&b=2&c=");
  });

  it("lowercases, trims, and folds header values", () => {
    const text = canonicalRequest({
      ...base,
      url: new URL("https://h/"),
      headers: { ...base.headers, "X-Custom": "  a   b  " },
    });
    expect(text).toContain("x-custom:a b\n");
    expect(text.split("\n").at(-2)).toBe("host;x-amz-date;x-custom");
  });

  it("refuses a header given twice in different case", () => {
    expect(() =>
      canonicalRequest({
        ...base,
        url: new URL("https://h/"),
        headers: { ...base.headers, Host: "h" },
      }),
    ).toThrow("header host given twice");
  });
});

describe("authorization", () => {
  it("requires a well-formed x-amz-date header", () => {
    const request = {
      method: "GET",
      url: new URL("https://h/"),
      headers: { host: "h" },
      payloadHash: EMPTY_PAYLOAD_HASH,
    };
    const credentials = { accessKeyId: "a", secretAccessKey: "b" };
    const scope = { region: "auto", service: "s3" };
    expect(() => authorization(request, credentials, scope)).toThrow("x-amz-date");
    expect(() =>
      authorization(
        { ...request, headers: { host: "h", "x-amz-date": "2026-10-28" } },
        credentials,
        scope,
      ),
    ).toThrow("x-amz-date");
  });
});

describe("helpers", () => {
  it("formats the date AWS's way", () => {
    expect(amzDate(new Date("2026-10-28T09:05:07.123Z"))).toBe("20261028T090507Z");
  });

  it("encodes everything but the unreserved characters", () => {
    expect(uriEncode("Az09-._~!*'() /+=$")).toBe("Az09-._~%21%2A%27%28%29%20%2F%2B%3D%24");
  });
});
