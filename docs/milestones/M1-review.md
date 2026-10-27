# M1 review: Analyzer CLI

**Tag:** `m1` · **Range:** `a2d53e8..m1` (M1.1–M1.16) · **Date:** 2026-10-27

## What was built

`gitinside analyze <path> [--out file]` (and the `analyze(dir)` library API behind it) turns a TS/JS repo into a schema-valid, byte-deterministic `architecture.json`. The pipeline, in order:

| Stage | File | What it produces |
|---|---|---|
| Inventory | `packages/analyzer/src/inventory.ts` | Sorted file list; skips with warnings (symlinks, >2 MB, generated, depth > 64); `LIMIT_FILES` over 20k |
| Workspace | `workspace.ts` | `service` nodes from npm/yarn/pnpm/Lerna/Nx/Turborepo layouts, single-package fallback |
| Programs | `program.ts` | One `ts.Program` per service over an inventory-only compiler host |
| Files | `files.ts` | `module` + `file` nodes, SHA-256 content hashes |
| Symbols | `symbols.ts` | `symbol` nodes: functions, classes, methods, exported values |
| Imports | `imports.ts` | `imports` edges incl. cross-workspace packages; unresolved local imports shown |
| Calls | `calls.ts` | `calls` edges resolved by the type checker |
| Express | `express.ts` | `route` nodes with composed mount paths, `handles` edges |
| Next.js | `next.ts` | App/pages router `route` + `page` nodes, `handles`/`renders` edges |
| Prisma | `prisma.ts` | `model`/`datastore` nodes, `stores`/`reads`/`writes` edges, raw queries unresolved |
| Assemble | `assemble.ts` | One validated graph; precedence-ordered merge; round-trip validation before write |

Plus: 8 fixture repos with golden graphs (`fixtures/`), a determinism test, and an analysis-time benchmark harness (`bench/`).

## Results (exactly as measured)

- **Tests:** 293 green after the review fixes (analyzer 271, schema 14, bench 8); 257 before. Lint, typecheck, and build green.
- **Coverage (lines):** analyzer 98.18% (target 85%), schema 98.85%, bench 100%.
- **Determinism:** every fixture byte-identical across two in-process runs and a third run from a copy under a path containing a space and `é`. Five benchmark runs on cal.com produced identical graphs.
- **Benchmark baseline** ([report](../../bench/results/2026-10-26-analysis-calcom.md)): cal.com at `0f19cc4`, 5,041 files, 113 services. Median 53.3 s (min 27.1, max 77.1), ~2 GiB peak RSS, on a Windows dev laptop. The 60 s budget is defined on the Oracle VM, so the real budget check is owed at M5.
- **Smoke test:** see "Smoke test" below.

## Key decisions and trade-offs

- **IDs come from what changes least** (ADR-0019, ADR-0021): service keys are folder names, not package names; symbol IDs are `file#Qualified.name`. Folder moves change IDs, which M6's rename detection handles.
- **The compiler host is the sandbox** (ADR-0022): TypeScript only sees inventory files plus its own bundled libs. Nothing is installed or executed, and there's no `node_modules`.
- **No `node_modules` means no framework types.** So detectors prove where an object came from (`express()`, `new PrismaClient()`) before trusting its methods (ADR-0026, ADR-0028). This favors precision over recall; the Prisma name-only match is labeled `heuristic` so the eval can score it separately.
- **Fail visibly, but not noisily** (ADR-0024, ADR-0025): unresolved local imports, dynamic route paths, and raw queries become `unresolved` nodes. Unresolved *calls* produce no node, since third-party calls would bury the diagram. That's a judgment call, recorded in the ADR.
- **Precedence in one place** (ADR-0029): passes are ordered parts; the first node per ID wins, and losers are reported as `DUPLICATE_NODE` warnings.

## Hardest problem: Express mount composition without types

Express builds paths at runtime: `app.use("/api", ordersRouter)` in one file, `router.get("/:id", h)` in another, often through `module.exports = (app) => { … }` factories with untyped parameters. With no `express` types, `app.get("/x", h)` looks just like `cache.get("/x")`.

**Solution** (`express.ts`, ADR-0026):
1. Find router *creations* syntactically (`express()`, `Router()` bound to an `express` import/require).
2. Follow every receiver back with the checker (variables, imports, CommonJS, class props, factories) to one of those creations. Only then does a call count.
3. Bind function parameters to routers passed in at call sites (fixed-point, ≤ 8 rounds), so untyped `(app) => app.get(…)` works.
4. Treat `use` mounts as a graph and DFS from each root app, joining prefixes and cutting cycles. Routers mounted only inside a cycle are still walked (a silent drop I caught in testing).

## What's still weak

- **Inline and wrapped handlers** (`app.get("/x", async (req, res) => …)`, `asyncHandler(fn)`) get no `handles` edge, which breaks route → logic chains in trace mode. Prisma calls inside inline handlers are attributed to the route, but `calls` aren't.
- **`next.config` is never read:** `basePath`, `pageExtensions`, and rewrites are invisible, so a repo with `basePath` gets wrong paths with no warning.
- **Call-edge recall:** methods on instances from another workspace package, callbacks passed as parameters, and computed access are missed.
- **Memory and speed:** ~2 GiB RSS and up to 33 s just building programs on cal.com. M6's incremental cache and the M5 worker limits must account for this.
- **Prisma model ambiguity across schemas:** a repo with an extra example schema (cal.com) turns 108 client calls into `AMBIGUOUS` unresolved nodes (see Smoke test).
- **No cross-service links yet.** Frontend → backend matching is M2; M3 provides the first precision and recall numbers.

## Fresh-eyes review

A subagent with no prior context reviewed `a2d53e8..HEAD` against SPEC.md, DESIGN.md, TESTING.md, and SECURITY.md. Every finding was checked against the code and fixed with a test, in commits `f1e6852`, `27ce9e4`, `a910e3a`, `c9f047a`, `6ceb273`, and `92b6cc6`:

| # | Kind | Finding | Fix |
|---|---|---|---|
| 1 | Security | Repo-supplied workspace globs like `**/**/…/z` compiled to a backtracking RegExp: over 60 s against one deep folder. | Globs are matched by dynamic programming, O(tokens × path) for any pattern. |
| 2 | Security | `{a,b}{a,b}…` brace expansion was exponential (30 groups = 2^30 strings). | Iterative expansion capped at 256 alternatives and 1,024 characters, with a `WORKSPACE_PATTERN_TOO_COMPLEX` warning. |
| 3 | Security | Express mount composition enumerated every path, so shared routers under 2 prefixes per level grew 2^n. | 20,000-step budget plus an `EXPRESS_ROUTE_LIMIT` warning. |
| 4 | Bug | Pages API `if (GET) return a(); return b();` emitted only `GET`, silently dropping the fall-through. | `handledMethods` decides whether other methods stay open; if so it adds `ALL`. Closed patterns (405, `!==`, `default`, last statement) are unchanged. |
| 5 | Bug | A nameless `packages/config` was importable as `config`, capturing the npm package. | Only `package.json` names resolve imports (`packageName`). |
| 6 | Determinism | The CLI's default `repo.name` was the checkout folder name, so the same commit in two folders gave different bytes. | Default is the root `package.json` name, else `repo`; added `--owner`/`--name`/`--sha`; added a two-folder CLI test. |
| 7 | Fail visibly | Source files outside every workspace package vanished without a warning. | `FILES_OUTSIDE_SERVICE` warning per top-level folder. |
| — | Bug | `export type GET` in `route.ts` created a route. | Only value exports count. |
| — | Bug | Nx `project.json` folders ignored `!` exclusions. | Exclusions now apply. |
| — | Fail visibly | Models in a datasource-less schema with 0 or 2+ service datasources got no `stores` edge and no warning. | `PRISMA_NO_DATASOURCE` warning. |
| — | Bug | Any "do not edit" in a file's first 1 KB marked it generated. | Requires `@generated`, or "generated" plus "do not edit" on one line. |

No fixture golden changed. One existing test was deliberately rewritten: "survives an unparseable manifest" asserted the folder-name import behavior from finding 5. It now asserts no edge plus the `INVALID_JSON` warning, and still checks that the run survives.

The reviewer also confirmed these were fine: the compiler host can't read outside the root or follow symlinks, out-of-repo `extends` is never read, every sort uses `compareStrings`, there's no clock or randomness in output, machine paths are stripped, and every detector documents what it handles and doesn't.

**After the fixes:** 293 tests green (analyzer 271, schema 14, bench 8). Analyzer line coverage 98.18%. Lint and typecheck green.

## Smoke test

Built CLI on a real public repo, as a user would run it: `node packages/analyzer/dist/cli.js analyze bench/.repos/calcom --out …` (cal.com at `0f19cc4`). Exit 0, a 25 MB graph that passes validation, with counts identical to the benchmark run:

- **Nodes:** 113 services, 1,392 modules, 5,041 files, 11,578 symbols, 91 routes, 97 pages, 103 models, 2 datastores, 589 unresolved (465 `UNKNOWN_SYMBOL`, 108 `AMBIGUOUS`, 16 `RAW_QUERY`).
- **Edges:** 19,045 imports, 10,238 calls, 87 handles, 97 renders, 977 reads, 608 writes, 103 stores.
- **Warnings (139):** 85 `TSCONFIG_MISSING`, 22 `TSCONFIG_INVALID`, 18 `SKIPPED_LARGE`, 13 `IMPORT_OUTSIDE_SERVICE`, 1 `SKIPPED_GENERATED`.

**Spot checks:**
- `route:base/ALL /api/get-users` → `handler` is correct for a pages-router API file.
- `web/app/api/auth/reset-password/route.ts#handler` reads `ResetPasswordRequest` [email, expires, id] (`exact`).
- `TaskRepository.getFailed` reads `Task` (`heuristic`, name-matched receiver).

**Re-run after the review fixes:** the same node and edge counts. Two differences:
- `repo.name` is `calcom-monorepo` (from the root `package.json`) instead of the checkout folder name.
- 5 new `FILES_OUTSIDE_SERVICE` warnings cover 32 files that were previously dropped silently: 7 root configs, `.snaplet/`, `__checks__/`, 9 `scripts/`, and 12 under `packages/` that sit in no workspace package, such as `packages/sms/*`.

**Finding:** the 108 `AMBIGUOUS` nodes are mostly `prismaClient.user.*` calls in `packages/features/auth`. `packages/platform/examples/base` has its own `schema.prisma` with a second `User` model. When a client is only *typed* `PrismaClient` (so no creating service is known) and the calling service has no schema, two services own `User`, and the call is marked ambiguous rather than guessed. That behavior is honest, but it costs recall. A tie-break by "which candidate service does the caller depend on" would resolve most of them. Logged for M3's eval to measure before changing it.

## Interview questions

**1. How do you guarantee that the same commit always produces a byte-identical graph?**
Three layers. Inputs: the inventory walk sorts by full path, symlinks are never followed, and machine paths are stripped from diagnostics. Processing: no clocks or randomness, and every collection is sorted with `compareStrings` (code-unit order, not locale-dependent `localeCompare`, which lint bans). Output: only `stringifyGraph` serializes, in canonical order. `determinism.test.ts` enforces this by analyzing each fixture twice plus once from a different checkout path and byte-comparing.

**2. Why build a TypeScript program per service instead of one for the whole repo?**
Each service has its own tsconfig (`paths`, `baseUrl`, `jsx`, module resolution), and the same alias, like `@/lib`, means different folders in different apps. One program would have to choose one set of options. The cost is that cross-workspace imports fall between programs, so `createModuleResolver` bridges them by reading the target package's `package.json` (`exports`, `main`, …) ourselves.

**3. You never install dependencies. How do you know `prisma.user.findMany()` is a Prisma call?**
The checker traces the receiver back through variables, imports, `??`, factories, and class properties to `new PrismaClient()`, a subclass, or a `PrismaClient`-typed declaration. Those edges are `exact`. If tracing fails but the receiver is named like a client (`db`, `tx`, `*prisma*`) and the accessor and op match, the edge is `heuristic`. The confidence tier makes the guess explicit, and M3 scores it separately.

**4. What does "fail visibly" mean concretely in M1, and where did you deliberately not apply it?**
Unresolvable local imports, dynamic Express paths, raw SQL, and ambiguous models become `unresolved` nodes with reasons. Skipped files and odd configs become warnings, and duplicate node IDs produce `DUPLICATE_NODE`. The exception is calls to things outside the repo (libraries, built-ins): they produce no node, because they're most calls and would drown the diagram. Failed local imports are already visible through unresolved `imports` edges.

**5. How is an untrusted repo kept from doing anything during analysis?**
It's never executed or installed. The compiler host only answers from the inventory, so TS can't read outside the repo or into `node_modules`. Symlinks are never followed. Files over 2 MB and folders deeper than 64 levels are skipped, and over 20k source files the run aborts. Prisma schemas are read with our own line parser, not Prisma's engine binary. Config files are parsed as JSON/YAML data, never `require`d. *Follow-up:* "parsed, not executed" isn't enough on its own. The M1 review found that a hostile `pnpm-workspace.yaml` glob could make a backtracking RegExp run for minutes, and shared Express mounts could explode combinatorially. So repo-controlled input also needs bounded algorithms: globs are matched by dynamic programming in O(pattern × path), brace expansion is capped, and mount composition has a step budget that ends in a visible warning.

Quiz yourself: open Claude Code and say 'quiz me on M1'.
