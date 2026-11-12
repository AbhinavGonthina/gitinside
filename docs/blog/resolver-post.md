<!--
DRAFT (M9.5), not published. Claude drafted this in Abhinav's voice for him to edit (D13.3);
he decides whether, where, and when it goes out (planned host: abhinavgonthina.dev).
Every number is quoted as measured, from the committed reports linked beside it:
eval/results/2026-11-11-0.3.1.md (analyzer 0.3.1, every score the same as 0.3.0's),
eval/results/2026-11-batch6-diagnosis.md, docs/demos/README.md, and
eval/backtest/results/2026-11-07.md. Links are relative to this file, so they work on GitHub;
make them absolute (https://github.com/AbhinavGonthina/gitinside/blob/main/...) before
publishing anywhere else.
-->

# How GitInside matches frontend calls to backend routes without running code

GitInside draws a repo's architecture from its code: the services, the pages and routes, the database models, the outside APIs. The part people ask about most is the arrows between the frontend and the backend. When a React component calls `fetch("/api/users/" + id)`, the diagram draws a line to the Express route `GET /api/users/:id` in another package. When it can't work out where a call goes, it says so and says why.

This post is about how that matching works, and how well it works. The short version: on 16 repos it had never seen, every route it predicted was right (521 of 521), and it found 69.0% of the requests a person reading the code would find (521 of 755).

## The rules

Three rules shaped everything else.

**Never run the repo's code.** GitInside analyzes repos that anyone can paste in, so it can't install their dependencies or run their scripts. That rules out the easy route of starting the app and watching its network traffic. Everything comes from reading the code with the TypeScript compiler, without even a `node_modules` folder.

**No guessing.** There's no LLM anywhere in the analysis. The same commit always gives the same graph, byte for byte. If a URL can't be read from the code, the answer is "unknown", not a plausible-looking route.

**Nothing is dropped.** Every request the analyzer finds ends up in the graph, either as a line to a route or as an *unresolved* box that says why it isn't one. A missing line you can't see is worse than a gray box you can.

The resolver runs in four stages: find the requests, read their URLs, follow wrapper functions, and match the result to routes.

## 1. Finding the requests

The first stage looks for every `fetch` and axios call. This is harder than searching for the word `fetch`.

A repo can define its own `function fetch(path) { … }`. That's not a request, it's a helper that makes one. The analyzer tells the two apart by asking TypeScript where the name is declared: the browser's `fetch` lives in a `.d.ts` file, a local one lives in the repo's code.

axios is harder, because its instances carry state. Most apps do something like this:

```ts
// api.ts
export const api = axios.create({ baseURL: "/api" });

// users.ts
import { api } from "./api";
api.get("/users/me");
```

Without `node_modules`, TypeScript can't open the `axios` package at all, so `import axios from "axios"` points at nothing. The analyzer reads the import declaration itself to see that the name came from `"axios"`, then follows `api` through `axios.create`, exports, re-exports, factory functions, and workspace packages, carrying the `baseURL` along.

Each request comes out with a method, a URL expression, and a base. Each of those can be readable, absent, or unreadable, and keeping the last two apart matters. An absent method means the default, `GET`. An unreadable one (`{ method: verb }`, or a `...init` spread that might set it) must not default to `GET`, or the analyzer would quietly draw a line to the wrong route.

## 2. Reading a URL without running it

The second stage turns a URL expression into a pattern of text and *holes*. A hole is a value only known at runtime:

| Code | Pattern |
|---|---|
| `"/api/users/" + id` | `/api/users/{}` |
| `` `/api/teams/${team.slug}/members` `` | `/api/teams/{}/members` |
| `` `${process.env.NEXT_PUBLIC_API_URL}/orders` `` | `{env:NEXT_PUBLIC_API_URL}/orders` |
| `` `${base}/users` `` with `let base` | unresolved: starts with a runtime value |

Constants are followed across files, so `const BASE = "/api"` in one module and `BASE + "/users"` in another read as `/api/users`. So are enum members, properties of `const` objects, and, since the launch fixes, class fields written once.

A URL that *starts* with a hole is unresolved (`DYNAMIC_URL`). There's nothing to anchor a match on, and matching `${base}/users` against every route ending in `/users` would be a guess. A hole in the middle is fine, because that's exactly what a route parameter is.

Two details took longer than they look. First, axios and `new URL` join a base and a path differently. `axios.create({ baseURL: "/api" })` plus `"/users"` gives `/api/users`, but `new URL("/users", "https://host/api")` gives `/users`, because a root-relative path replaces the base's path. The normalizer copies each rule exactly. Second, credentials in a URL (`https://user:pass@host`) are removed before any label is built, and everything outside a URL's path is masked in the text the diagram shows, so a token in a header never reaches the graph. That one came from a test that planted fake secrets and caught them being copied.

## 3. Following wrappers

Apps rarely call `fetch` directly. They call a helper:

```ts
// http.ts
const BASE = "/api";
export async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, { method: "GET", ...init });
  return res.json();
}

// projects.ts
export function listProjects() {
  return request("/projects");
}
export function createProject(name: string) {
  return request("/projects", { method: "POST", body: JSON.stringify({ name }) });
}
```

The `fetch` inside `request` can't be resolved on its own: its URL is `/api` plus a parameter. But each *call* to `request` can. So when a request's URL reads a parameter of the function it's in, the analyzer treats that function as a wrapper. It finds every call to it, binds the parameters to that call's arguments, and reads the URL again. `listProjects` becomes `GET /api/projects`, and `createProject` becomes `POST /api/projects`, because the `POST` in its spread overrides the `GET` before it.

Each request is drawn at the caller, not inside the helper, since the caller is the code that decides where the request goes. Wrappers that call wrappers are followed up to three levels deep. Past that, the request is unresolved with its own reason (`WRAPPER_DEPTH`), so a deep chain shows up as a limit, not as a silent gap.

## 4. Matching patterns to routes

On the other side, the Express and Next.js detectors have already found every route, with mounts composed: a `router.get("/:id")` inside a router mounted at `/api/users` is `GET /api/users/:id`. Next.js routes come from file paths (`app/api/users/[id]/route.ts`).

Matching a pattern to a route is an alignment problem, because routes can have optional parameters and wildcards. The matcher walks both segment lists with a small dynamic program. Each step gets a level (an exact literal, a hole in a parameter's slot, a literal standing in for a parameter), an alignment is only as strong as its weakest step, and the matcher keeps the strongest alignment. With memoization, that's at most (call segments + 1) × (route segments + 1) states, even against a route like `/*/*/*`.

Every match gets a confidence level:
- **exact:** everything literal, in the caller's own service, with a known method.
- **pattern:** a literal hitting a parameter (`/users/me` against `/users/:id`), or a wildcard.
- **heuristic:** an assumption about the base, such as an env var named like an API URL, a root-relative path across services (which needs a proxy the analyzer can't see), a loopback host, or an unknown method.

When two routes fit equally well, the request is drawn to both, one level weaker and marked ambiguous. (If the only thing that would pick one is a method the analyzer couldn't read, it's unresolved instead.) A literal route beats a parameter route that also fits, so `/users/me` goes to `GET /users/me`, not `GET /users/:id`. And a catch-all that matches every path (a 404 handler, `app.all("*")`) never wins a match on its own. That rule came from the demo check below.

Anything that doesn't match becomes an unresolved box with its reason: `DYNAMIC_URL` ("the URL starts with a value only known at runtime"), `NO_MATCHING_ROUTE` ("no route matches GET to /api/teams"), `AMBIGUOUS`, or `WRAPPER_DEPTH`.

## How well it works

I wanted numbers I could defend, so the eval is set up to make fooling myself hard.

- **Labels come from the code, not from the analyzer.** For each repo, every request in the frontend was labeled with the route it really hits, by reading the code. The labels are committed before the analyzer first runs on the repo. (The labels were drafted by Claude from each repo's code. My review of a random 20% of them isn't done yet, so these numbers may still change.)
- **Repos are drawn at random by a rule written down first.** The search queries, strata, seed, and exclusions are committed before any candidate is looked at.
- **Each batch is scored once, blind.** Once I fix the analyzer using a batch's misses, that batch counts as *seen*. Its later numbers show the fixes work, not that they generalize.

The final batch, batch 6, is 16 public React/Next.js and Express repos the analyzer had never been run on: 790 labels at 783 call sites, 755 of them with a route.

- **Precision: 100.0% (521 of 521).** No predicted route is wrong, at either level it used (`exact` 312, `heuristic` 209). All 35 labels whose request has no route in the repo got no route.
- **Recall: 69.0% (521 of 755),** below my 80% target. 6 of the 16 repos are mapped completely.

The misses are lopsided. Every labeled route is in the graph, so all 234 misses are on the calling side. One form causes 141 of them: a single repo's only axios instance trims its base with `.replace(/\/+$/, "")`, which the analyzer doesn't evaluate, so every request on it is unresolved. Without that repo, recall is 84.8% (518 of 611). The next causes are a test's `let baseUrl` first set inside a `listen(0)` callback (23), a base spelled `window.location.protocol + "//" + window.location.host` (21), and a base held in a constructor parameter's default (12). None of them is fixed, so batch 6 stays unseen. ([Report](../../eval/results/2026-11-11-0.3.1.md#held-out-batch-6-unseen), [diagnosis](../../eval/results/2026-11-batch6-diagnosis.md).)

The earlier batches tell the same story from the other end. On the first five repos, the first run's recall was 20.3% (28 of 138). Most of the work since then has been reading misses like the ones above and teaching the normalizer one more way people write a base URL. The random batches' blind runs went from 51.1% to 63.0% to 69.0% recall, with precision at 94.4%, 93.5%, and 100.0%.

### What the eval didn't catch

Precision on labeled frontend requests isn't the whole graph. Before putting three well-known repos on the landing page, I wanted every inferred edge in them checked by hand: every `http` edge, external API call, Prisma read and write, and datastore link. The bar was zero wrong edges.

The first read of anything-llm found 244 wrong ones. Its frontend's base is `VITE_API_BASE || "/api"`, and `frontend/.env.example` sets `VITE_API_BASE` to a URL ending in `/api`. The analyzer put the example's `/api` in front of the fallback's `/api`, looked for `/api/api/…`, and the only routes that take that path are the two services' `app.all("*")` 404 handlers. So 122 frontend functions each drew two confident-looking lines to a 404 page. Fixing that changed no eval score, which means no labeled request in the eval had that shape. The check found 128 more wrong edges after that, all fixed in the analyzer and rechecked. Most were an SDK gap: `new OpenAI({ baseURL: "https://api.groq.com/openai/v1" })` was drawn as a call to api.openai.com.

In the end, the three demo repos' 1,044 inferred edges are 779 correct, 0 wrong, and 265 unresolved with a reason. That's the bar met where it was worked for, not a claim about how often it holds elsewhere. ([Demo check](../demos/README.md).)

### Broken connections in real PRs

The same graph powers GitInside's PR bot, which diffs a PR's architecture against its base and flags calls the PR breaks. I replayed 926 merged PRs from 7 public apps (July to September 2026). It flagged 5 broken edges, all in one PR that emptied a file whose class other code still called. All 5 were drafted as true breaks (by Claude; I haven't reviewed them yet), and a direct push fixed all 5 about 55 minutes later. No cross-service break was flagged in any PR. This isn't a blind result either: the first replay flagged nothing, a hand check of 38 PRs found that one, and the detector learned the rule that flags it before the re-run. ([Backtest report](../../eval/backtest/results/2026-11-07.md).)

## What it doesn't do

Each detector lists the patterns it handles and the ones it doesn't ([coverage](../COVERAGE.md)). The ones that matter most here:

- **No env values, but for one host.** Values can be secrets, so from an env file the analyzer keeps only the key names and, for a URL value, its scheme, host, and port; credentials, paths, and queries are dropped as the file is read. What's kept only decides things (a `postgres://` URL is a PostgreSQL datastore, and its host picks the compose service it runs on), and a request whose base is an env var not named like an API URL stays unresolved. The one value drawn is a committed example env file's host, for an SDK client whose base is that variable and whose example names an API outside the repo (`UPSTREAM_BASE_URL=https://api.openai.com/v1` draws `api.openai.com`). The analyzer also borrows the URL *path* from an example env file (the `/api` above), and reads Next.js `rewrites` and `basePath` and Vite and CRA dev proxies from their configs, but only to match requests.
- **No runtime-built URLs.** A base computed by a function the normalizer doesn't know (the `.replace` trim above, `qs.stringifyUrl`) is a runtime value.
- **No route order.** When two routes overlap, Express runs the one registered first. The matcher marks the pair ambiguous instead.
- **TypeScript and JavaScript only,** with `fetch`, axios, and a handful of clients built on them (ky, ofetch, SWR, RTK Query).

The thing I'd keep from all this is the second rule: unknown is an answer. A gray box that says "this base is only known at runtime" is something you can check in a minute. A wrong line looks just like a right one.

The code is on [GitHub](../../README.md). The [resolver walkthrough](../walkthroughs/resolver.md) goes through every function in order, line by line.
