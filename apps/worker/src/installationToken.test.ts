import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobFailure } from "./failure.js";
import {
  derivedSecret,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  TOKEN_REQUEST_PURPOSE,
  verifyRequest,
} from "./hmac.js";
import { createTokenClient, TOKEN_ROUTE_PATH } from "./installationToken.js";

const SECRET = "s".repeat(43);
const OLD = "o".repeat(43);
const NOW = Date.UTC(2026, 10, 7, 12);
const ASK = { jobId: `analyze-${"a".repeat(32)}`, installationId: 42 };
const TOKEN = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";

interface Seen {
  method: string;
  url: string;
  body: string;
  verified: boolean;
  /** Whether the enqueue secret itself (not the derived key) would verify it. */
  verifiedWithSecret: boolean;
}

let server: Server;
let origin: string;
let seen: Seen[];
let answer: (res: ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  answer = (res) => json(res, 200, { token: TOKEN, expiresAt: "2026-11-07T13:00:00.000Z" });
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const parts = { method: req.method ?? "", path: req.url ?? "", body };
      const headers = {
        timestamp: req.headers[TIMESTAMP_HEADER],
        signature: req.headers[SIGNATURE_HEADER],
      };
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: body.toString(),
        verified: verifyRequest([derivedSecret(SECRET, TOKEN_REQUEST_PURPOSE)], parts, headers, NOW)
          .ok,
        verifiedWithSecret: verifyRequest([SECRET], parts, headers, NOW).ok,
      });
      answer(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

const client = (secrets: readonly string[] = [SECRET, OLD]) =>
  createTokenClient({ origin, secrets, now: () => NOW });

async function failure(promise: Promise<unknown>): Promise<JobFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JobFailure) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("createTokenClient", () => {
  it("asks the route, signed with the current secret's derived key, and returns the token", async () => {
    expect(await client()(ASK, new AbortController().signal)).toBe(TOKEN);
    expect(seen).toEqual([
      {
        method: "POST",
        url: TOKEN_ROUTE_PATH,
        body: JSON.stringify(ASK),
        verified: true,
        verifiedWithSecret: false,
      },
    ]);
  });

  it("asks once more with the previous secret's key when the website hasn't the new one yet", async () => {
    // The website still signs and verifies with the old secret: it refuses the current key.
    answer = (res) => {
      const last = seen.at(-1);
      if (last?.verified === true) json(res, 401, { error: "BAD_SIGNATURE" });
      else json(res, 200, { token: TOKEN });
    };
    expect(await client([SECRET, OLD])(ASK, new AbortController().signal)).toBe(TOKEN);
    expect(seen.map((s) => s.verified)).toEqual([true, false]);

    seen = [];
    answer = (res) => json(res, 401, { error: "BAD_SIGNATURE" });
    const failed = await failure(client([SECRET])(ASK, new AbortController().signal));
    expect(failed.code).toBe("TOKEN_REFUSED");
    expect(seen).toHaveLength(1);
  });

  it("doesn't ask again with the previous key for anything but a 401", async () => {
    answer = (res) => json(res, 403, { error: "INSTALLATION_SUSPENDED" });
    await failure(client([SECRET, OLD])(ASK, new AbortController().signal));
    expect(seen).toHaveLength(1);
  });

  it("maps the route's permanent refusals to their own codes", async () => {
    for (const [status, error, code] of [
      [403, "INSTALLATION_SUSPENDED", "INSTALLATION_SUSPENDED"],
      [403, "INSTALLATION_NOT_FOUND", "INSTALLATION_NOT_FOUND"],
      [403, "REPO_NOT_INSTALLED", "REPO_NOT_INSTALLED"],
      [404, "JOB_NOT_FOUND", "JOB_NOT_LIVE"],
    ] as const) {
      answer = (res) => json(res, status, { error });
      const failed = await failure(client()(ASK, new AbortController().signal));
      expect([failed.code, failed.retriable, failed.detail]).toEqual([
        code,
        false,
        `the website answered ${String(status)} ${error}`,
      ]);
    }
  });

  it("retries what may pass: a 5xx, or no answer at all", async () => {
    for (const [status, error] of [
      [502, "GITHUB_UNAVAILABLE"],
      [503, "APP_AUTH_FAILED"],
      [503, "UNAVAILABLE"],
      [500, "INTERNAL"],
    ] as const) {
      answer = (res) => json(res, status, { error });
      const failed = await failure(client()(ASK, new AbortController().signal));
      expect([failed.code, failed.retriable]).toEqual(["TOKEN_UNAVAILABLE", true]);
    }
    answer = (res) => res.socket?.destroy();
    const dropped = await failure(client()(ASK, new AbortController().signal));
    expect([dropped.code, dropped.retriable]).toEqual(["TOKEN_UNAVAILABLE", true]);
  });

  it("refuses for good what a retry would only repeat", async () => {
    const cases: ((res: ServerResponse) => void)[] = [
      (res) => json(res, 401, { error: "BAD_SIGNATURE" }),
      (res) => json(res, 400, { error: "INVALID_REQUEST" }),
      (res) => json(res, 403, { error: "constructor" }),
      (res) => json(res, 404, { error: "NOPE" }),
      (res) => json(res, 200, { token: "ghs_x\r\nx-evil: 1" }),
      (res) => json(res, 200, { expiresAt: "2026-11-07T13:00:00.000Z" }),
      (res) => json(res, 200, [TOKEN]),
      (res) => {
        res.writeHead(200, { "content-type": "text/plain", connection: "close" });
        res.end(TOKEN);
      },
    ];
    for (const respond of cases) {
      answer = respond;
      const failed = await failure(client()(ASK, new AbortController().signal));
      expect([failed.code, failed.retriable]).toEqual(["TOKEN_REFUSED", false]);
    }
  });

  it("never follows a redirect", async () => {
    let elsewhere = 0;
    const other = createServer((_req, res) => {
      elsewhere++;
      json(res, 200, { token: TOKEN });
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const target = `http://127.0.0.1:${(other.address() as AddressInfo).port}${TOKEN_ROUTE_PATH}`;
      answer = (res) => {
        res.writeHead(307, { location: target, connection: "close" });
        res.end();
      };
      const failed = await failure(client()(ASK, new AbortController().signal));
      expect(failed.code).toBe("TOKEN_UNAVAILABLE");
      expect(elsewhere).toBe(0);
    } finally {
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("rethrows the signal's reason when it fires", async () => {
    answer = () => undefined;
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = client()(ASK, controller.signal);
    setTimeout(() => controller.abort(reason), 20);
    await expect(pending).rejects.toBe(reason);
  });

  it("needs the signing secret", () => {
    expect(() => createTokenClient({ origin, secrets: [] })).toThrow(/signing secret/);
  });
});
