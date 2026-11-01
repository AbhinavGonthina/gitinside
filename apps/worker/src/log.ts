import type { WorkerLog } from "./attempt.js";

/**
 * Structured logs (DESIGN.md §13): one JSON object per line on stdout, `time` first, then
 * `event` and the event's fields. Cloud Run sends stdout to Cloud Logging, which parses
 * each line as a JSON payload.
 *
 * Callers log codes, IDs, counts, and timings only: never a secret, a URL with credentials,
 * or a repo's file contents. Errors are reduced to their message. A field that can't be
 * serialized (a `BigInt`, a cycle) never throws: the line says `log_unserializable` instead,
 * with the event name.
 */
export function createJsonLog(
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): WorkerLog {
  return (event) => {
    const time = now().toISOString();
    let line: string;
    try {
      line = JSON.stringify({ time, ...event }, (_key, value: unknown) =>
        value instanceof Error ? value.message : value,
      );
    } catch {
      line = JSON.stringify({
        time,
        event: "log_unserializable",
        original: typeof event.event === "string" ? event.event : null,
      });
    }
    write(`${line}\n`);
  };
}
