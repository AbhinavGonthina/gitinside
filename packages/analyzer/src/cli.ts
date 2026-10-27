#!/usr/bin/env node
import { rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.js";
import { serializeGraph } from "./assemble.js";

const USAGE =
  "Usage: gitinside analyze <path> [--out <file>] [--owner <owner>] [--name <name>] [--sha <sha>]";

/** Flags that take a value, and the {@link AnalyzeOptions} key each sets (`out` is the CLI's). */
const VALUE_FLAGS = {
  "--out": "out",
  "--owner": "owner",
  "--name": "name",
  "--sha": "sha",
} as const;

/**
 * Write via a sibling temp file and a rename, so a crash or full disk never leaves a
 * truncated graph where an old, valid one used to be.
 */
async function writeAtomically(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Output sinks, injectable so the CLI can be tested without touching the process. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Run the CLI with `argv` (without the node and script entries) and return the exit code.
 * Writes the graph to `--out` if given, otherwise to stdout. `--owner`, `--name`, and
 * `--sha` set the repo identity recorded in the graph; without them it doesn't depend on
 * the checkout's folder, so the same commit gives the same bytes anywhere.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "analyze") {
    io.stderr(`${USAGE}\n`);
    return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }

  let target: string | undefined;
  const values: Partial<Record<(typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS], string>> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg in VALUE_FLAGS) {
      const value = rest[++i];
      if (value === undefined || value === "") {
        io.stderr(`${arg} needs a value\n${USAGE}\n`);
        return 2;
      }
      values[VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS]] = value;
    } else if (arg.startsWith("-") || target !== undefined) {
      io.stderr(`unexpected argument: ${arg}\n${USAGE}\n`);
      return 2;
    } else {
      target = arg;
    }
  }
  if (target === undefined) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }

  const { out, ...identity } = values;
  try {
    const text = serializeGraph(await analyze(target, identity));
    if (out === undefined) io.stdout(text);
    else await writeAtomically(out, text);
    return 0;
  } catch (error) {
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/* v8 ignore start -- process entry point, exercised by the smoke test */
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
/* v8 ignore stop */
