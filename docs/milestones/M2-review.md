# M2 review: Cross-service links + infra

**Tag:** `m2` · **Range:** `m1..m2` (M2.1–M2.11) · **Date:** 2026-10-28

## What was built

The analyzer now links code across services. A frontend `fetch` or axios call becomes an `http` edge to the backend route it hits, with a confidence level. Calls it can't link become visible `unresolved` nodes with a reason. SDK calls, compose/env datastores, and queues get their own nodes and edges. New stages, in pipeline order:

| Stage | File | What it produces |
|---|---|---|
| Value reading | `packages/analyzer/src/values.ts` | Shared const/object/enum tracing, `redactedText()` for anything shown from source |
| HTTP collection | `http.ts` | One `HttpCallSite` per `fetch`/axios request; axios instances traced through `create()`, imports, factories, workspace packages |
| URL normalization | `url.ts` | `parts()` ⇒ text/hole/env/origin; pure `toUrlPattern()` ⇒ base + segments, or `DYNAMIC_URL` |
| Wrapper inlining | `wrappers.ts` | One request per call to a one-level wrapper, parameters bound; `WRAPPER_DEPTH` beyond |
| Route matching | `match.ts` | DP segment alignment; base/method/path levels, weakest wins; `AMBIGUOUS`; `http`/`external_call` edges, `unresolved` and `external` nodes |
| SDKs | `sdk.ts` | Allowlisted clients (Stripe, AWS, OpenAI, …) ⇒ `external_call` to the API's host node, shared with `fetch` |
| Infra | `infra.ts` | Compose services ⇒ `datastore`/`queue`; `.env` keys + URL authority only; Prisma datasources relinked to the compose service they name |
| Queues | `queues.ts` | BullMQ/Bull/Bee-Queue ⇒ `publishes`/`consumes` through `queue:infra/redis#<name>`; runtime names ⇒ `DYNAMIC_NAME` |

Plus 9 pattern fixtures with goldens (17 fixtures in total), a "no call site dropped" invariant test over every fixture, a secret-leak test, and the line-by-line [resolver walkthrough](../walkthroughs/resolver.md). Decisions are ADR-0030 to ADR-0039.

## Results (exactly as measured)

- **Tests:** 598 green after the review fixes (analyzer 575, schema 15, bench 8); 579 before them. Lint, typecheck, and build green.
- **Coverage (lines):** analyzer 97.49% (target 85%), schema 98.85%, bench 100%. Lowest analyzer files: `wrappers.ts` 92.24%, `queues.ts` 94.34%, `prisma.ts` 94.57%, `sdk.ts` 94.68%.
- **Determinism:** all 17 fixtures are byte-identical across two runs and a third run from a copy under a path with a space and `é`.
- **Acceptance criteria (ROADMAP M2):**
  - Each pattern fixture produces the expected edge and confidence: asserted per fixture in `fixtures.test.ts`.
  - No call site is silently dropped: every collected site yields a request, and every request yields an edge at its site, on all 17 fixtures.
  - Secrets never appear in output: the `fake-secrets` fixture plus the review's new redaction cases.
- **Benchmarks:** no new timing run this milestone. The M1 baseline stands, and M2's stage timings on cal.com are recorded in ADR-0030 to ADR-0037.

## Key decisions and trade-offs

- **"Unknown" is never "absent"** (ADR-0030): `null` means "set, but not statically readable". An unreadable method or base URL becomes an unresolved edge, never a default.
- **Two-layer normalizer** (ADR-0031): checker-dependent evaluation (`parts()`) is separate from a pure URL reader (`toUrlPattern()`). That makes the pure layer property-testable: idempotence through `patternParts()`, checked with fast-check.
- **Inline one wrapper level by re-running the normalizer with bindings** (ADR-0032). The caller's argument is read in the caller's scope with bindings switched off, which is exactly what makes a second level show up as `WRAPPER_DEPTH`.
- **Confidence is a minimum over independent levels** (ADR-0033): base, method, and path each get a level, and the weakest wins. Ambiguity downgrades one level but never below `heuristic`, because the candidates are real routes.
- **Precision over recall everywhere.** SDK and queue values must be traced to an allowlisted import. A literal external host is an `external` node, not a guessed route. An image tells us the engine, not whether the container holds data.
- **Redaction by structure, not pattern** (ADR-0038, extended in ADR-0039): mask every string a reader doesn't need, rather than guessing which strings look like keys.

## Hardest problem: wrappers without losing a single call site

Real clients hide the URL behind helpers: `fetcher(endpoint, init)` → `fetch(BASE + endpoint, { method: "GET", ...init })`. On its own, the inner `fetch` is `/api{}` with an unknown method. The useful URL and method live at each of the helper's callers, possibly in other workspace packages. Two constraints pulled against each other:
- **Inline enough** to get real URLs.
- **Never drop or double-count a site.** That's ROADMAP's "no call site dropped".

**Solution** (`wrappers.ts`, `url.ts` `parameterParts`):
1. A wrapper is a symbol whose own function body contains a site whose URL, base, or method reads one of its parameters.
2. Callers are found with the M1.9 symbol resolver, so imports, namespaces, class instances, and workspace packages work exactly as call edges do.
3. Each call re-normalizes the inner site with `parameter ⇒ argument` bindings. The argument is evaluated in the caller's scope with bindings switched off, so recursion terminates. A URL still starting with an unbound parameter is the caller's own parameter, which makes it `WRAPPER_DEPTH`.
4. Methods hidden behind spreads are recorded as a `MethodSource` and re-read with the bindings: the last spread that sets `method` wins.
5. A wrapper with callers yields one request per call. A wrapper with none keeps its own request. The invariant test checks both cases on every fixture.

On cal.com: 217 sites ⇒ 269 requests, 0 dropped. Resolved URLs went from 130 to 157.

## What's still weak

- **Recall on real apps is low and dominated by `DYNAMIC_URL`.** On cal.com, 112 of 269 requests start with a function result (`${WEBAPP_URL}/…` where `WEBAPP_URL = ensureProtocol(…)`). Function results are never evaluated, by design.
- **No NestJS:** cal.com's v2 API routes and queue processors are invisible, so 16 requests are `NO_MATCHING_ROUTE` and there are no queue edges at all.
- **Unbound parameter holes match `:param` routes at `exact`** (review finding 6, kept per DESIGN.md §7.4). An uncalled `get(path) => fetch("/api/" + path)` links to `GET /api/:id` at `exact`, and wrappers nested in callbacks (`retry(() => fetch(...))`) aren't inlined. M3's eval should measure how often this misleads before the rule changes.
- **Root-relative cross-service matches are all `heuristic`**, and env bases only count when named like `*_API_URL`/`*_BASE_URL`. Whether that's too strict is an M3 question.
- **Health-check containers count as datastores** (`postgres_is_ready` on cal.com).
- **Budgets make results depend on traversal order** in pathological inputs. That order is fixed, so output is still deterministic, but which value hits the budget first isn't obvious from reading the code.

## Fresh-eyes review

A subagent with no prior context reviewed `m1..HEAD` against SPEC.md, DESIGN.md, TESTING.md, SECURITY.md, and ADR-0030 to ADR-0038, running scratch repos against the built analyzer. It reported 10 findings, 7 confirmed by running. Fixed with tests in `9fb8991`, `bef1f14`, and `68cc23e` (ADR-0039):

| # | Kind | Finding | Fix |
|---|---|---|---|
| 1 | Availability | Consts that each repeat the last 10× (9 lines) took 70.8 s to normalize and produced a 10,000,005-character label. Nested factories with 10 returns each took 110 s in axios tracing (same in SDK tracing). | A 10,000-expression budget and a 2,048-character cap per value (⇒ `DYNAMIC_URL` "too large or too complex"), plus per-function memoization of axios and SDK factories. Both repros now run in under 1 s. |
| 2 | Availability | `fetch("https:///x")`, `new Queue("")`, or a compose service named `""` gave an empty label or host, so validation threw and **the whole analysis failed**. | Empty host ⇒ `DYNAMIC_URL`; empty queue name ⇒ `DYNAMIC_NAME`; empty service ⇒ skipped with `COMPOSE_INVALID`. |
| 3 | Security | `redactedText` kept `` `${base}&token=…` ``, `base + "&api_key=…"`, and `sign("/x", "key")`. | URL text is cut at the first `?`, `&`, `=`, or `#`; strings passed to calls inside the URL are masked. |
| 4 | Security | Typed-queue and spread-flow `DYNAMIC_NAME` nodes copied the whole call, payload included. | `redactedText`, keeping only a name expression's own strings. |
| 5 | Fail visibly | A publish inside a called worker factory was dropped with no edge and no node. | Only the factory's own `consumes` is replaced per call. |
| 6 | Correctness | Unbound wrapper parameter matched `:param` at `exact`. | **Kept** (DESIGN.md §7.4; ADR-0032 documents the nested-closure gap). Logged for M3. |
| 7 | Correctness | A literal Prisma `url` (a cloud host) was linked to a lone local compose database. | A literal `url` keeps its own datastore. |
| 8 | Correctness | `const opts = { method: "GET" }; opts.method = "POST"` read as `GET` (`let` too). | Only `const`, never-written config objects give a method. |
| 9 | Hygiene | Resolved URL labels and `NO_MATCHING_ROUTE` details were never shortened. | `clip()` to 120 characters. |
| 10 | Fail visibly | One unterminated quote in a `.env` hid every later key. A second claim, that a trailing comment broke Prisma's `env()` regex, was a false positive: comments are stripped first. | A quote that never closes is read as a one-line value, with linear-time look-ahead. |

**Test changes:** one existing expectation changed deliberately. A typed queue's label is now `queue this.other.add('…', {})` instead of showing `'y'`, because the whole call is shown and its strings are masked. Every other change adds tests. No golden changed.

The reviewer also confirmed these were fine: no regex on repo input can backtrack badly; YAML alias expansion is capped and errors don't quote the file; nothing is executed; credentials and queries never reach hosts; env values never leave the parser; every collection is sorted with `compareStrings`; the matcher's tie-breaks and ambiguity rules match ADR-0033; and every detector documents what it handles and doesn't.

**After the fixes:** 598 tests green, analyzer line coverage 97.49%, lint and typecheck green.

## Smoke test

Built CLI on a real public repo, as a user would run it: `node packages/analyzer/dist/cli.js analyze bench/.repos/calcom --out …` (cal.com at `0f19cc4`). Exit 0, a 25 MB graph that passes validation.

- **Nodes:** 113 services, 1,392 modules, 5,041 files, 11,578 symbols, 91 routes, 97 pages, 103 models, 7 datastores, 29 externals, 724 unresolved (465 `UNKNOWN_SYMBOL`, 112 `DYNAMIC_URL`, 108 `AMBIGUOUS`, 23 `NO_MATCHING_ROUTE`, 16 `RAW_QUERY`).
- **Cross-service edges:** 38 `http` to routes (22 exact, 7 pattern, 9 heuristic), 135 `http` to unresolved nodes, 138 `external_call` (exact) to 29 hosts, 103 `stores` (102 heuristic onto `datastore:infra/packages/prisma/postgres`, 1 exact).
- **Unchanged from M1:** 19,045 imports, 10,238 calls, 87 handles, 97 renders, 977 reads, 608 writes; same 144 warnings.

**Before vs. after the review fixes:** identical node and edge counts. Only two nodes differ, both in `packages/app-store/zohocalendar/api/callback.ts`: a string passed to a function inside the URL (`getOAuthBaseUrl(server_location || "com")`) is now masked as `"…"`.

**Spot checks:**
- `symbol:base/src/pages/_app.tsx#App` → `route:base/ALL /api/get-users` is `exact`: same service, root-relative, pages-router `ALL`.
- `file:web/cron-tester.ts` → `route:web/GET /api/tasks/cron` is `heuristic`: a loopback host.
- `useAddAppMutation` → `route:web/ALL /api/integrations/*args` is `heuristic`: a cross-service root-relative call into a catch-all.

## Interview questions

**1. How do you link a frontend `fetch` to a backend route without running either?**
Evaluate the URL expression statically into literal text, holes, and env/origin bases, using the type checker to follow consts, enums, and imports across workspace packages. Then align its segments against every candidate route's segments with dynamic programming (literal = literal is `exact`, hole or literal into `:param` is `pattern`/`exact`, wildcards are `pattern`). Score base, method, and path independently, and keep the weakest. An index by method and first literal segment keeps it fast. Anything the evaluator can't read becomes an unresolved node with a reason, never a guess.

**2. Why is "the weakest level wins" the right way to combine confidence?**
Each level is an independent assumption. An `exact` path under a heuristic base is still only as trustworthy as the base assumption ("this root-relative URL reaches that other service through a proxy"). Taking the minimum means a confidence label never claims more than its weakest premise. Before declaring ambiguity, ties are broken by path level first and then by specific method over `ALL`. *Follow-up:* "Why not pick the most specific route, like Express does?" Express decides by registration order, which you can't see across files. Picking one would be a guess.

**3. How do you guarantee no call site is silently dropped, even with wrapper inlining?**
By construction plus a test. Every site either yields its own request or, when it's a wrapper body with visible callers, one request per call. Every request gets an edge: to a route, to an external host, or to an unresolved node at its site. `fixtures.test.ts` asserts this on all 17 fixtures, and a companion test checks that the fixtures exercise every outcome (wrapper, top-level, axios, `WRAPPER_DEPTH`, `DYNAMIC_URL`). Without that companion, the invariant could pass vacuously.

**4. The review found a 9-line file that took 70 seconds. Why didn't the depth limit catch it, and what's the general lesson?**
`MAX_HOPS` bounds depth, not branching. Each const referenced the previous one 10 times, so evaluation was 10^8 expressions at depth 8. The fix is a work budget (10,000 expressions per value) plus an output cap (2,048 characters), and memoizing factory results so a shared function is traced once. The lesson: on attacker-controlled input, "terminates" isn't enough. Every recursive evaluator needs a bound on total work, and hitting it must be a visible outcome (`DYNAMIC_URL`, "too complex"), not a crash or a silent hole.

**5. How do you keep secrets out of a graph that shows source code on unresolved nodes?**
Three layers. Env files are parsed into keys plus scheme/host/port, and values never leave `parseEnv`. Credentials are stripped from hosts during normalization. Any source text shown goes through `redactedText`, which keeps the code's shape (identifiers, operators, property names, `method`) but masks every string's contents, except URL path text up to the first `?`, `&`, `=`, or `#`. Strings passed into calls inside the URL are masked too. A test plants fake secrets in every channel (env, compose, URL credentials, headers, query, wrapper argument) and checks that none appear. It also checks that the expected nodes exist, so an empty graph can't pass. *Follow-up:* the first version of the leak test found a real leak (ADR-0038), and the fresh-eyes review found two more paths (ADR-0039).

Quiz yourself: open Claude Code and say 'quiz me on M2'.
