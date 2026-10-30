#!/usr/bin/env node
import { rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { diffGraphs, renderMermaidSummary } from "@gitinside/diff";
import { stringifyDiff } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { serializeGraph } from "./assemble.js";
import { openSide, type DiffSide } from "./revisions.js";

const USAGE = [
  "Usage: gitinside analyze <path> [--out <file>] [--owner <owner>] [--name <name>] [--sha <sha>]",
  "       gitinside diff <base> <head> [--repo <dir>] [--format json|mermaid] [--out <file>]",
  "",
  "diff: <base> and <head> are each a graph file from `gitinside analyze`, a folder to analyze,",
  "or a commit, branch, or tag in the git repo at --repo (default: the current folder).",
].join("\n");

/** Flags each command takes, all with a value. */
const COMMAND_FLAGS = {
  analyze: ["--out", "--owner", "--name", "--sha"],
  diff: ["--out", "--repo", "--format"],
} as const;

/** How many positional arguments each command needs. */
const POSITIONALS = { analyze: 1, diff: 2 } as const;

type Command = keyof typeof COMMAND_FLAGS;

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

interface Parsed<C extends Command> {
  targets: string[];
  values: Partial<Record<(typeof COMMAND_FLAGS)[C][number], string>>;
}

/** Split `rest` into positionals and flag values, or print why it can't and return `undefined`. */
function parseArgs<C extends Command>(
  command: C,
  rest: string[],
  io: CliIo,
): Parsed<C> | undefined {
  const flags: readonly string[] = COMMAND_FLAGS[command];
  const parsed: Parsed<C> = { targets: [], values: {} };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (flags.includes(arg)) {
      const value = rest[++i];
      if (value === undefined || value === "") {
        io.stderr(`${arg} needs a value\n${USAGE}\n`);
        return undefined;
      }
      parsed.values[arg as (typeof COMMAND_FLAGS)[C][number]] = value;
    } else if (arg.startsWith("-") || parsed.targets.length === POSITIONALS[command]) {
      io.stderr(`unexpected argument: ${arg}\n${USAGE}\n`);
      return undefined;
    } else {
      parsed.targets.push(arg);
    }
  }
  if (parsed.targets.length < POSITIONALS[command]) {
    io.stderr(`${USAGE}\n`);
    return undefined;
  }
  return parsed;
}

/** Print `text` to stdout, or write it to `out`. */
async function emit(text: string, out: string | undefined, io: CliIo): Promise<void> {
  if (out === undefined) io.stdout(text);
  else await writeAtomically(out, text);
}

async function runAnalyze(target: string, parsed: Parsed<"analyze">, io: CliIo): Promise<number> {
  const { "--out": out, "--owner": owner, "--name": name, "--sha": sha } = parsed.values;
  const identity = {
    ...(owner === undefined ? {} : { owner }),
    ...(name === undefined ? {} : { name }),
    ...(sha === undefined ? {} : { sha }),
  };
  await emit(serializeGraph(await analyze(target, identity)), out, io);
  return 0;
}

async function runDiff(
  base: string,
  head: string,
  parsed: Parsed<"diff">,
  io: CliIo,
): Promise<number> {
  const { "--out": out, "--repo": repo = ".", "--format": format = "json" } = parsed.values;
  if (format !== "json" && format !== "mermaid") {
    io.stderr(`--format must be json or mermaid\n${USAGE}\n`);
    return 2;
  }
  const sides: DiffSide[] = [];
  try {
    for (const spec of [base, head]) sides.push(await openSide(spec, repo));
    const [before, after] = sides as [DiffSide, DiffSide];
    const diff = diffGraphs(before.graph, after.graph, {
      contents: { base: before.read, head: after.read },
    });
    await emit(
      format === "json"
        ? stringifyDiff(diff)
        : renderMermaidSummary(diff, before.graph, after.graph),
      out,
      io,
    );
    return 0;
  } finally {
    for (const side of sides) await side.close();
  }
}

/**
 * Run the CLI with `argv` (without the node and script entries) and return the exit code:
 * 0 on success, 1 when the command fails, 2 for bad usage.
 *
 * - `analyze <path>` writes the graph to `--out` if given, otherwise to stdout. `--owner`,
 *   `--name`, and `--sha` set the repo identity recorded in the graph; without them it
 *   doesn't depend on the checkout's folder, so the same commit gives the same bytes anywhere.
 * - `diff <base> <head>` writes the `GraphDiff` between two sides (see `openSide`) as
 *   canonical JSON, or with `--format mermaid` a Mermaid flowchart of the change
 *   (`renderMermaidSummary`). Temporary worktrees are removed even when it fails.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "analyze" && command !== "diff") {
    io.stderr(`${USAGE}\n`);
    return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }
  try {
    if (command === "analyze") {
      const parsed = parseArgs(command, rest, io);
      if (parsed === undefined) return 2;
      return await runAnalyze(parsed.targets[0] as string, parsed, io);
    }
    const parsed = parseArgs(command, rest, io);
    if (parsed === undefined) return 2;
    const [base, head] = parsed.targets as [string, string];
    return await runDiff(base, head, parsed, io);
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
