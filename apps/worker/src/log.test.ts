import { describe, expect, it } from "vitest";
import { createJsonLog } from "./log.js";

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

  it("reduces errors to their message", () => {
    const { lines, log } = capture();
    log({
      event: "worker_error",
      error: new Error("ECONNREFUSED"),
      nested: { cause: new TypeError("x") },
    });
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: NOW.toISOString(),
      event: "worker_error",
      error: "ECONNREFUSED",
      nested: { cause: "x" },
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
