import type { HighlighterCore, LanguageRegistration, ThemeRegistration } from "shiki/core";

/**
 * Syntax highlighting for the inspector's code preview (M4b.5b), with Shiki
 * loaded lazily and fine-grained: the core, the JavaScript regex engine, and
 * only the grammar a file needs, each its own chunk fetched on first use. The
 * JavaScript engine turns TextMate's Oniguruma patterns into native `RegExp`s,
 * so there's no WebAssembly to allow in the website's CSP.
 *
 * Tokens come back as text plus a {@link SyntaxKind}, never as HTML: the
 * preview renders them as React spans (SECURITY.md T10), and each kind's color
 * is a `--syntax-*` token, so one tokenization serves both themes.
 *
 * Handles `.ts/.mts/.cts`, `.tsx`, `.js/.mjs/.cjs`, `.jsx`, `.json`,
 * `.prisma`, and `.yml/.yaml`. Doesn't handle anything else (it stays plain
 * text), and a line over {@link MAX_LINE_LENGTH} characters (minified code)
 * stays plain too. The tokenizer starts at most {@link CONTEXT_LINES} lines
 * above the preview, so a comment or template string opened further up is
 * colored as code.
 */

/** What a token is, which picks its color. Text outside these is plain. */
export type SyntaxKind = "keyword" | "string" | "function" | "type" | "constant" | "comment";

/** One run of a line's text, with its kind when it has one. */
export interface SyntaxToken {
  text: string;
  kind?: SyntaxKind | undefined;
}

/** The grammars the preview can load. */
export type SyntaxLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "prisma"
  | "yaml";

/** Lines above the preview fed to the tokenizer, so it knows what they opened. */
export const CONTEXT_LINES = 200;

/** Longer lines aren't tokenized (Shiki leaves them one plain token). */
export const MAX_LINE_LENGTH = 1000;

const EXTENSIONS: Record<string, SyntaxLanguage> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  prisma: "prisma",
  yml: "yaml",
  yaml: "yaml",
};

/** The grammar for a repo path, from its extension; `undefined` means plain text. */
export function languageOf(path: string): SyntaxLanguage | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
}

// Explicit imports, one per grammar, so the bundler splits each into its own chunk.
const GRAMMARS: Record<SyntaxLanguage, () => Promise<{ default: LanguageRegistration[] }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const KINDS: readonly SyntaxKind[] = [
  "keyword",
  "string",
  "function",
  "type",
  "constant",
  "comment",
];

/** The CSS color Shiki hands back for a kind; {@link kindOfColor} reads it back. */
function colorOf(kind: SyntaxKind): string {
  return kind === "comment" ? "var(--text-muted)" : `var(--syntax-${kind})`;
}

const KIND_OF_COLOR = new Map(KINDS.map((k) => [colorOf(k), k]));

/** The kind for a color from {@link SYNTAX_THEME}; anything else (plain text) has none. */
export function kindOfColor(color: string | undefined): SyntaxKind | undefined {
  return color === undefined ? undefined : KIND_OF_COLOR.get(color);
}

/**
 * GitInside's own Shiki theme: TextMate scopes to the six kinds. A deeper
 * scope wins over a shallower one, which is how operators stay plain inside
 * `keyword` and JSON keys become keywords inside `support.type`.
 */
export const SYNTAX_THEME: ThemeRegistration = {
  name: "gitinside",
  type: "dark",
  colors: { "editor.foreground": "var(--text)", "editor.background": "var(--canvas)" },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: colorOf("comment") },
    },
    {
      scope: [
        "keyword",
        "storage",
        "keyword.operator.new",
        "keyword.operator.expression",
        "variable.language",
        "entity.name.tag",
        "support.type.property-name",
        "punctuation.definition.template-expression",
      ],
      settings: { foreground: colorOf("keyword") },
    },
    {
      scope: [
        "keyword.operator",
        "meta.template.expression",
        "punctuation.separator",
        "punctuation.terminator",
      ],
      settings: { foreground: "var(--text)" },
    },
    {
      scope: ["string", "punctuation.definition.string"],
      settings: { foreground: colorOf("string") },
    },
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: colorOf("function") },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.type",
        "support.class",
      ],
      settings: { foreground: colorOf("type") },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character.escape",
        "variable.other.constant",
        "variable.other.enummember",
      ],
      settings: { foreground: colorOf("constant") },
    },
  ],
};

const SCRIPT_SAMPLE = [
  'import { Router } from "express";',
  "/** Docs. */",
  "// A comment",
  "export const LIMIT = 25;",
  "export async function list(limit: number = 1): Promise<string[]> {",
  "  const res = await fetch(`/api?limit=${limit}`, { method: 'GET' });",
  '  if (!res.ok) throw new Error("failed");',
  "  return res.json() as Promise<string[]>;",
  "}",
  "export default class Store extends Base implements Api {}",
].join("\n");

/** Our own code per grammar, tokenized once on load (see {@link loadSyntax}). */
const WARM_UP: Record<SyntaxLanguage, string> = {
  typescript: SCRIPT_SAMPLE,
  tsx: `${SCRIPT_SAMPLE}\nconst a = <Layout title="Shop">{n}</Layout>;`,
  javascript: SCRIPT_SAMPLE.replace(/: number|: Promise<string\[\]>| as Promise<string\[\]>/g, ""),
  jsx: 'const a = <div className="x">{n}</div>;\nexport default a;',
  json: '{ "name": "@shop/api", "private": true, "port": 3000, "list": [null] }',
  prisma:
    'datasource db {\n  provider = "postgresql"\n}\n// note\nmodel Order {\n  id Int @id @default(autoincrement())\n}',
  yaml: 'services:\n  db:\n    image: postgres:16 # pinned\n    ports: [5432]\n    env: "x"',
};

let core: Promise<HighlighterCore> | undefined;
let highlighter: HighlighterCore | undefined;
const loads = new Map<SyntaxLanguage, Promise<boolean>>();
const loaded = new Set<SyntaxLanguage>();

/** Whether `language` can be highlighted right now, without waiting. */
export function syntaxReady(language: SyntaxLanguage): boolean {
  return loaded.has(language);
}

/**
 * Load Shiki (once) and `language`'s grammar. Resolves `true` when it's
 * ready, `false` when something failed to load; a failure isn't remembered,
 * so the next call tries again. Callers share one load per language.
 */
export function loadSyntax(language: SyntaxLanguage): Promise<boolean> {
  const pending = loads.get(language);
  if (pending) return pending;
  core ??= startCore();
  const load = core
    .then(async (h) => {
      await h.loadLanguage(...(await GRAMMARS[language]()).default);
      // The engine compiles a grammar's patterns the first time they run, and
      // Shiki gives each line 500ms before coloring the rest of it like its
      // start (a slow machine's first `import … "express";` came back as one
      // keyword). Pay that cost here, on our own sample, without the limit.
      h.codeToTokensBase(WARM_UP[language], {
        lang: language,
        theme: SYNTAX_THEME.name ?? "gitinside",
        tokenizeTimeLimit: 0,
      });
      loaded.add(language);
      return true;
    })
    .catch(() => {
      loads.delete(language);
      return false;
    });
  loads.set(language, load);
  return load;
}

function startCore(): Promise<HighlighterCore> {
  const started = Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    async ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) => {
      const h = await createHighlighterCore({
        themes: [SYNTAX_THEME],
        langs: [],
        // Forgiving: a pattern the JavaScript engine can't translate matches
        // nothing instead of failing the whole grammar.
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
      highlighter = h;
      return h;
    },
  );
  started.catch(() => {
    core = undefined;
  });
  return started;
}

const CACHE_SIZE = 32;
const cache = new Map<string, SyntaxToken[][] | null>();

/**
 * Tokens for `lines`, tokenized after `context` (the lines above them), one
 * array per line whose texts join back to that line exactly. `undefined`
 * while the language isn't loaded ({@link loadSyntax}); `null` when the
 * tokenizer failed, so the caller shows plain text. Results are cached by
 * content, so selecting a node again doesn't tokenize again.
 */
export function highlightLines(
  language: SyntaxLanguage,
  context: readonly string[],
  lines: readonly string[],
): SyntaxToken[][] | null | undefined {
  if (!highlighter || !loaded.has(language)) return undefined;
  const above = context.slice(-CONTEXT_LINES);
  const key = `${language}\n${above.length}\n${above.join("\n")}\n${lines.join("\n")}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh its place, so the cache drops the least recently used.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let result: SyntaxToken[][] | null;
  try {
    const rows = highlighter.codeToTokensBase([...above, ...lines].join("\n"), {
      lang: language,
      theme: SYNTAX_THEME.name ?? "gitinside",
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
    });
    result = lines.map((line, i) => mergeTokens(line, rows[above.length + i] ?? []));
  } catch {
    result = null;
  }
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return result;
}

/**
 * One line's Shiki tokens as runs of the same kind. If the tokens don't spell
 * the line exactly (they always should), the line comes back plain, so the
 * preview never shows text that isn't in the file.
 */
export function mergeTokens(
  line: string,
  tokens: readonly { content: string; color?: string | undefined }[],
): SyntaxToken[] {
  const runs: SyntaxToken[] = [];
  for (const token of tokens) {
    if (token.content === "") continue;
    const kind = kindOfColor(token.color);
    const last = runs.at(-1);
    if (last && last.kind === kind) last.text += token.content;
    else runs.push(kind ? { text: token.content, kind } : { text: token.content });
  }
  return runs.map((r) => r.text).join("") === line ? runs : [{ text: line }];
}
