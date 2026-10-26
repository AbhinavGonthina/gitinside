#!/usr/bin/env node
import { rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.js";
import { serializeGraph } from "./assemble.js";

const USAGE = "Usage: gitinside analyze <path> [--out <file>]";

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
 * Writes the graph to `--out` if given, otherwise to stdout.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "analyze") {
    io.stderr(`${USAGE}\n`);
    return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }

  let target: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--out") {
      out = rest[++i];
      if (out === undefined) {
        io.stderr(`--out needs a file path\n${USAGE}\n`);
        return 2;
      }
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

  try {
    const text = serializeGraph(await analyze(target));
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
