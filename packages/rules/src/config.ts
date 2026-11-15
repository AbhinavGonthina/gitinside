import { EdgeKind, compareStrings } from "@gitinside/schema";
import { LineCounter, isAlias, parseDocument, visit } from "yaml";
import { z } from "zod";
import { GlobError, compileGlob, type Glob } from "./glob.js";

/**
 * `.gitinside.yml`, a repo's architecture rules (M11.3, ADR-0300). Read as data, never executed:
 * a YAML document (no anchors or aliases, no custom tags) checked against a strict Zod schema, so
 * an unknown key, a bad glob, or a rule naming a layer that doesn't exist is an error shown to the
 * user, with its line when the file has one. The format is in docs/RULES.md.
 */

/** The `version:` this code reads. A file with another version is an error, not a guess. */
export const RULES_VERSION = 1;
/** The largest file read, in UTF-8 bytes (ADR-0295). */
export const MAX_CONFIG_BYTES = 64 * 1024;
/** The most rules a file may hold (ADR-0295). */
export const MAX_RULES = 200;
/** The most layers a file may define. */
export const MAX_LAYERS = 100;
/** The most globs in one list (a layer's `services` or `paths`, a rule's `allow`). */
export const MAX_GLOBS = 100;

const globList = z.array(z.string()).min(1).max(MAX_GLOBS);
const ruleId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "use letters, digits, `-`, `_`, `.` (at most 64)");
const level = z.enum(["error", "warning"]);
const layerName = ruleId;

const Layer = z
  .object({
    /** Service names (the `service` node's label, a package's `name`), as globs. */
    services: globList.optional(),
    /** Repo-relative paths of files, as globs. */
    paths: globList.optional(),
  })
  .strict()
  .refine((l) => l.services !== undefined || l.paths !== undefined, {
    message: "a layer needs `services`, `paths`, or both",
  });

const ruleBase = { id: ruleId.optional(), level: level.optional() };

const Rule = z.discriminatedUnion("type", [
  z
    .object({
      ...ruleBase,
      type: z.literal("forbid-dependency"),
      from: layerName,
      to: layerName,
      /** Which edge kinds count; all by default. */
      edges: z.array(EdgeKind).min(1).optional(),
    })
    .strict(),
  z.object({ ...ruleBase, type: z.literal("no-service-cycles") }).strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal("datastore-access"),
      /** A glob over the datastore's name or engine (`postgres`, `db`, `redis*`). */
      datastore: z.string(),
      /** The layers whose code may read or write it. */
      only: z.array(layerName).min(1).max(MAX_LAYERS),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal("no-new-hosts"),
      /** Hosts that are always fine, as globs (`api.stripe.com`, `*.amazonaws.com`). */
      allow: globList.optional(),
    })
    .strict(),
]);

const ConfigFile = z
  .object({
    version: z.literal(RULES_VERSION),
    layers: z.record(layerName, Layer).optional(),
    rules: z.array(Rule).max(MAX_RULES),
  })
  .strict();

/** What a rule's violation is. */
export type RuleType = z.infer<typeof Rule>["type"];
/** `error` fails a check; `warning` is reported only. */
export type RuleLevel = z.infer<typeof level>;

/** A layer with its globs compiled. */
export interface RulesLayer {
  name: string;
  services: Glob[];
  paths: Glob[];
}

/** A rule as evaluated: its ID (given, or `<type>-<n>` from its position) and level filled in. */
export type RulesRule =
  | {
      id: string;
      level: RuleLevel;
      type: "forbid-dependency";
      from: string;
      to: string;
      edges?: EdgeKind[];
    }
  | { id: string; level: RuleLevel; type: "no-service-cycles" }
  | { id: string; level: RuleLevel; type: "datastore-access"; datastore: Glob; only: string[] }
  | { id: string; level: RuleLevel; type: "no-new-hosts"; allow: Glob[] };

/** A parsed, checked `.gitinside.yml`. */
export interface RulesConfig {
  version: typeof RULES_VERSION;
  /** Sorted by name. */
  layers: RulesLayer[];
  /** In file order. */
  rules: RulesRule[];
}

/** One thing wrong with a config file. */
export interface ConfigIssue {
  /** Where in the file, as a dotted path (`rules.2.from`), or `""` for the whole file. */
  path: string;
  /** 1-based line, when the file has one for `path`. */
  line?: number;
  message: string;
}

/** {@link parseRulesConfig}'s answer: the config, or every issue found. */
export type ConfigResult = { ok: true; config: RulesConfig } | { ok: false; issues: ConfigIssue[] };

/** UTF-8 length of a string, without `TextEncoder` (this package has no DOM or Node types). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Parses and checks a `.gitinside.yml`'s text. Never throws on bad input: every problem comes back
 * as an issue (the file's size, YAML syntax, aliases, unknown keys, wrong types, bad globs, names
 * of layers that don't exist, duplicate rule IDs), so the caller can show them all at once.
 */
export function parseRulesConfig(text: string): ConfigResult {
  const bytes = utf8Length(text);
  if (bytes > MAX_CONFIG_BYTES)
    return fail([
      { path: "", message: `the file is ${bytes} bytes; the limit is ${MAX_CONFIG_BYTES}` },
    ]);

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
  });
  const lineAt = (offset: number | undefined): number | undefined =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;
  if (doc.errors.length > 0)
    return fail(
      doc.errors.map((e) => ({
        path: "",
        ...withLine(lineAt(e.pos[0])),
        message: `YAML: ${e.message.split("\n")[0] ?? e.code}`,
      })),
    );
  // Aliases can multiply a small file into a huge value ("billion laughs"), so none are read.
  const aliases: (number | undefined)[] = [];
  visit(doc, {
    Alias(_key, node) {
      aliases.push(node.range?.[0]);
      return visit.BREAK;
    },
  });
  if (aliases.length > 0)
    return fail([
      {
        path: "",
        ...withLine(lineAt(aliases[0])),
        message: "anchors and aliases (`&`, `*`) aren't allowed",
      },
    ]);

  const lineOf = (path: readonly (string | number)[]): number | undefined => {
    for (let n = path.length; n >= 0; n -= 1) {
      const node: unknown = doc.getIn(path.slice(0, n), true);
      if (node !== undefined && node !== null && typeof node === "object" && "range" in node) {
        const range = (node as { range?: [number, number, number] | null }).range;
        if (range) return lineAt(range[0]);
      }
      if (isAlias(node)) break;
    }
    return undefined;
  };
  const issue = (path: readonly (string | number)[], message: string): ConfigIssue => ({
    path: path.join("."),
    ...withLine(lineOf(path)),
    message,
  });

  const parsed = ConfigFile.safeParse(doc.toJS());
  if (!parsed.success) return fail(parsed.error.issues.map((i) => issue(i.path, zodMessage(i))));
  const file = parsed.data;

  const issues: ConfigIssue[] = [];
  const globs = (list: readonly string[] | undefined, path: (string | number)[]): Glob[] =>
    (list ?? []).flatMap((pattern, i) => {
      try {
        return [compileGlob(pattern)];
      } catch (error) {
        if (!(error instanceof GlobError)) throw error;
        issues.push(issue([...path, i], `bad glob \`${pattern}\`: ${error.message}`));
        return [];
      }
    });

  const layerEntries = Object.entries(file.layers ?? {});
  if (layerEntries.length > MAX_LAYERS)
    issues.push(issue(["layers"], `at most ${MAX_LAYERS} layers`));
  const layers: RulesLayer[] = layerEntries
    .map(([name, layer]) => ({
      name,
      services: globs(layer.services, ["layers", name, "services"]),
      paths: globs(layer.paths, ["layers", name, "paths"]),
    }))
    .sort((a, b) => compareStrings(a.name, b.name));
  const known = new Set(layers.map((l) => l.name));
  const layerRef = (name: string, path: (string | number)[]): void => {
    if (!known.has(name)) issues.push(issue(path, `no layer named \`${name}\` under \`layers\``));
  };

  const ids = new Set<string>();
  const rules: RulesRule[] = file.rules.map((rule, i) => {
    const id = rule.id ?? `${rule.type}-${i + 1}`;
    if (ids.has(id)) issues.push(issue(["rules", i, "id"], `two rules are named \`${id}\``));
    ids.add(id);
    const base = { id, level: rule.level ?? "error" } as const;
    switch (rule.type) {
      case "forbid-dependency":
        layerRef(rule.from, ["rules", i, "from"]);
        layerRef(rule.to, ["rules", i, "to"]);
        if (rule.from === rule.to)
          issues.push(issue(["rules", i, "to"], "`from` and `to` name the same layer"));
        return {
          ...base,
          type: rule.type,
          from: rule.from,
          to: rule.to,
          ...(rule.edges ? { edges: [...new Set(rule.edges)].sort(compareStrings) } : {}),
        };
      case "no-service-cycles":
        return { ...base, type: rule.type };
      case "datastore-access":
        rule.only.forEach((name, j) => layerRef(name, ["rules", i, "only", j]));
        return {
          ...base,
          type: rule.type,
          datastore: globs([rule.datastore], ["rules", i, "datastore"])[0] ?? compileGlob("**"),
          only: [...new Set(rule.only)].sort(compareStrings),
        };
      case "no-new-hosts":
        return { ...base, type: rule.type, allow: globs(rule.allow, ["rules", i, "allow"]) };
    }
  });
  if (issues.length > 0) return fail(issues);
  return { ok: true, config: { version: RULES_VERSION, layers, rules } };
}

const withLine = (line: number | undefined): { line?: number } =>
  line === undefined ? {} : { line };

/** Issues sorted by line (those without one first), then path, so the same file gives the same list. */
function fail(issues: ConfigIssue[]): ConfigResult {
  issues.sort(
    (a, b) =>
      (a.line ?? 0) - (b.line ?? 0) ||
      compareStrings(a.path, b.path) ||
      compareStrings(a.message, b.message),
  );
  return { ok: false, issues };
}

/** Zod's words, made plainer for the few cases a config author hits most. */
function zodMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.unrecognized_keys:
      return `unknown key${issue.keys.length > 1 ? "s" : ""}: ${issue.keys.map((k) => `\`${k}\``).join(", ")}`;
    case z.ZodIssueCode.invalid_union_discriminator:
      return `\`type\` must be one of ${issue.options.map((o) => `\`${String(o)}\``).join(", ")}`;
    case z.ZodIssueCode.invalid_literal:
      return issue.path.join(".") === "version"
        ? `\`version\` must be ${RULES_VERSION}`
        : issue.message;
    default:
      return issue.message;
  }
}
