import { describe, expect, it } from "vitest";
import { JobFailure } from "./failure.js";
import { createJsonLog, errorFields } from "./log.js";
import { DB_HOST } from "./log.testkit.js";
import { StorageError } from "./storage.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");

function capture() {
  const lines: string[] = [];
  const log = createJsonLog(
    (line) => void lines.push(line),
    () => NOW,
  );
  return { lines, log };
}

describe("createJsonLog", () => {
  it("writes one JSON line per event, time first", () => {
    const { lines, log } = capture();
    log({ event: "job_done", id: "analyze-1", nodes: 3 });
    log({ event: "worker_ready", port: 8080 });
    expect(lines).toEqual([
      '{"time":"2026-10-28T12:00:00.000Z","event":"job_done","id":"analyze-1","nodes":3}\n',
      '{"time":"2026-10-28T12:00:00.000Z","event":"worker_ready","port":8080}\n',
    ]);
  });

  it("reduces errors to their name, never their message", () => {
    const { lines, log } = capture();
    log({
      event: "worker_error",
      error: new Error("connect ECONNREFUSED db.example.neon.tech"),
      nested: { cause: new TypeError("x") },
    });
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: NOW.toISOString(),
      event: "worker_error",
      error: "Error",
      nested: { cause: "TypeError" },
    });
  });

  it("never throws on a value JSON can't hold", () => {
    const { lines, log } = capture();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    log({ event: "weird", cycle });
    log({ event: 7, big: 1n });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { time: NOW.toISOString(), event: "log_unserializable", original: "weird" },
      { time: NOW.toISOString(), event: "log_unserializable", original: null },
    ]);
  });

  it("uses the real clock by default", () => {
    const lines: string[] = [];
    createJsonLog((line) => void lines.push(line))({ event: "x" });
    const { time } = JSON.parse(lines[0] as string) as { time: string };
    expect(Math.abs(Date.parse(time) - Date.now())).toBeLessThan(60_000);
  });
});

describe("errorFields", () => {
  const HOST = DB_HOST;

  it("gives an error's name and never its message", () => {
    const fields = errorFields(new TypeError(`fetch failed for ${HOST}`));
    expect(fields).toEqual({ error: "TypeError" });
    expect(JSON.stringify(fields)).not.toContain(HOST);
  });

  it("keeps a code-shaped code: a socket's, Postgres's SQLSTATE, a failure code", () => {
    const socket = Object.assign(new Error(`connect ECONNREFUSED ${HOST}:5432`), {
      code: "ECONNREFUSED",
    });
    expect(errorFields(socket)).toEqual({ error: "Error", errorCode: "ECONNREFUSED" });
    const postgres = Object.assign(new Error('relation "analyses" does not exist'), {
      name: "PostgresError",
      code: "42P01",
    });
    expect(errorFields(postgres)).toEqual({ error: "PostgresError", errorCode: "42P01" });
    expect(errorFields(new JobFailure("PUBLISH_FAILED", HOST))).toEqual({
      error: "JobFailure",
      errorCode: "PUBLISH_FAILED",
    });
  });

  it("drops a code that isn't code-shaped", () => {
    const odd = Object.assign(new Error("x"), { code: `no route to ${HOST}` });
    expect(errorFields(odd)).toEqual({ error: "Error" });
    expect(errorFields(Object.assign(new Error("x"), { code: 42 }))).toEqual({ error: "Error" });
  });

  it("takes the code from a wrapped cause, as Drizzle wraps Postgres's error", () => {
    const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${HOST}`), { code: "ENOTFOUND" });
    const drizzle = new Error(`Failed query: select 1 from ${HOST}`, { cause });
    drizzle.name = "DrizzleQueryError";
    expect(errorFields(drizzle)).toEqual({ error: "DrizzleQueryError", errorCode: "ENOTFOUND" });
  });

  it("gives a storage error's status and S3 code", () => {
    const denied = new StorageError("LIST answered 403 AccessDenied", 403, "AccessDenied");
    expect(errorFields(denied)).toEqual({
      error: "StorageError",
      errorCode: "AccessDenied",
      httpStatus: 403,
    });
    expect(errorFields(new StorageError("PUT answered 503", 503))).toEqual({
      error: "StorageError",
      httpStatus: 503,
    });
    expect(errorFields(Object.assign(new Error("x"), { status: "503" }))).toEqual({
      error: "Error",
    });
  });

  it("names what was thrown when it isn't an Error", () => {
    expect(errorFields(`db at ${HOST} down`)).toEqual({ error: "string" });
    expect(errorFields(undefined)).toEqual({ error: "undefined" });
    expect(errorFields(null)).toEqual({ error: "object" });
  });

  it("stops after a few causes, even in a cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(errorFields(a)).toEqual({ error: "Error" });
  });
});
