# Demo repos

The three open-source repos the landing page shows pre-analyzed (SPEC M9, D13.1). Each is
pinned to one commit, and every edge the analyzer infers there is checked by hand: the bar
is **zero wrong edges** (D13.4).

- [`repos.json`](repos.json): the rules, the three picks with their commits, and every
  candidate rejected with the first rule it fails.
- `<owner>__<name>.json`: one repo's hand check, one entry per inferred edge.

## The picks

| Repo | Commit | Stars | Inferred edges | Checked | Wrong |
| --- | --- | ---: | ---: | --- | ---: |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | `308b276` | 68,095 | 873 | [all 873](Mintplex-Labs__anything-llm.json) | 0 (244 + 11 + 117 fixed) |
| [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy) | `298a885` | 19,289 | 29 | [all 29](shadcn-ui__taxonomy.json) | 0 |
| [getmaxun/maxun](https://github.com/getmaxun/maxun) | `99c6bd0` | 18,183 | 142 | [all 142](getmaxun__maxun.json) | 0 |

Stars are as of 2026-11-09. Edge counts come from analyzer 0.2.0 at the pinned commit, as of
the latest fix, and are the same at 0.3.0 (the version bump changed no output) and at 0.3.1
(M9.3e's fixture rule changed nothing in these repos; see "In production"). anything-llm was pinned at 978 edges (`repos.json`); M9.1a3a removed 244 wrong
ones and added 131 right ones, M9.1a3b replaced 11 more wrong ones with 9 unresolved ones, and
M9.1a3e2a replaced 117 wrong SDK edges with 120 (50 to their real host or route, 70 unresolved).

## What "checked" means

An **inferred edge** is any edge the analyzer works out rather than reading it off
TypeScript: `http`, `external_call`, `reads`, `writes`, `stores`, `publishes`, `consumes`.
Structural edges (`imports`, `calls`, `renders`, `handles`) are TypeScript's own resolution,
covered by the fixtures and the eval, and not re-checked here.

For each inferred edge, every call site is read at the pinned commit (`git show <sha>:<file>`):

- **`http`**: the URL and method at the call site, and the route file or router that answers
  it.
- **`external_call`**: the client traced back to its package import (or a literal host).
- **`reads` / `writes`**: the receiver traced to the Prisma client and its model.
- **`stores`**: the model against its schema's datasource.

Each edge gets one verdict:

- **`correct`**: what the code does.
- **`wrong`**: points somewhere the code doesn't go.
- **`unresolved`**: the analyzer drew no target and gave a reason. That's no claim, so it
  can't be wrong, but its reason is still read.

Then every request, Prisma, and SDK call in the app's source is matched to an edge, so the
check also notes what's missing. Missing edges don't break the bar, but they're written
down.

A `wrong` verdict blocks the repo from the gallery until the analyzer is fixed (with a
test and its eval delta) and the check is rerun, or another repo replaces it.

The site knows the pins too (`DEMO_PINS` in `packages/db/src/demos.ts`, checked against
`repos.json`): opening a pin's permalink that nobody has analyzed queues that commit, however
far the default branch has moved, and one with only an older analyzer version's graph queues
the current version (ADR-0257). Retention never evicts a pin (ADR-0255).

The landing page's gallery (M9.1b3, ADR-0259) links each pin's permalink, its thumbnail the
pin's own diagram image (`/api/diagram/<owner>/<name>/<sha>.svg`). Each card's counts come
from that repo's record here, and a test (`apps/web/lib/gallery.test.ts`) fails if they drift
or any edge's verdict is `wrong`.

## In production

Production now holds each pin at analyzer 0.3.1. On 2026-11-11 (M9.7c) each pin's 0.3.1
graph was fetched from the site (`/api/graph/<owner>/<name>/<full sha>` with a throwaway
query, so the CDN couldn't answer with an older copy) and compared with a local 0.3.1
analysis built the same way as below (`apps/web/dist/m91b2-compare.mjs`):

| Repo | Commit | Files extracted | Nodes | Edges (inferred) | Warnings | Bytes | Production vs local |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| anything-llm | `308b276` | 1,586 | 7,784 | 12,630 (873) | 3 | 10,560,747 | identical (SHA-256 `f8a40489…`) |
| taxonomy | `298a885` | 188 | 529 | 542 (29) | 1 | 439,847 | identical (SHA-256 `5fa2275c…`) |
| maxun | `99c6bd0` | 276 | 1,525 | 2,323 (142) | 0 | 1,999,969 | identical (SHA-256 `716b8f63…`) |

Every count and size equals 0.3.0's below. The hashes can't, since the graph records its
analyzer version (`"0.3.0"` and `"0.3.1"` are the same length, so the sizes still can).

At 0.3.2 (M9.7d, ADR-0264: typed and branching SDK clients) each pin was analyzed again the
same way and compared with the 0.3.1 graph above, node by node and edge by edge
(`apps/web/dist/m97d-pins.mjs`): every node, edge, and warning is identical, only the
version differs (same counts and byte sizes). All three pins are JavaScript, so no edge
changed and none needed rechecking by hand.

At 0.3.3 (M9.7e, ADR-0265: an SDK client's env base goes to the outside host its example env
file names) each pin was analyzed again the same way (`apps/web/dist/m97e-pins.mjs`) and is
again identical to the 0.3.1 graph but for the version: anything-llm's five example env files
and taxonomy's one change no edge, and maxun has none. No edge needed rechecking by hand.

At 0.3.4 (M9.7g, ADR-0266: every write and branch of an SDK client counts, and an example's
placeholder host is no API) each pin was analyzed again the same way
(`apps/web/dist/m97g-pins.mjs`) and is again identical to the 0.3.1 graph but for the
version (same counts and byte sizes): none of anything-llm's SDK clients is written on two
branches or beside an unread value, and no pin's example names a placeholder host for an SDK
base. No edge needed rechecking by hand.

At 0.3.5 (M9.7j, ADR-0267: an unread branch beside a client built with no base option is
unresolved, and a global member is a cache only where its file writes it) each pin was
analyzed again the same way (`apps/web/dist/m97j-pins.mjs`) and is again identical to the
0.3.1 graph but for the version (same counts and byte sizes): no pin pairs an injected client
with a default-built one or reads an SDK client off the global object. No edge needed
rechecking by hand.

At 0.3.6 (M9.7l, ADR-0268) and 0.3.7 (M9.7m, ADR-0269: `??=`/`||=` read their left side, a
`let`'s writes are read, and a global path's writes are read in every file of the service)
each pin was analyzed again the same way (`apps/web/dist/m97l-pins.mjs`,
`m97m-pins.mjs`) and is again identical to the 0.3.1 graph but for the version (same counts
and byte sizes): no pin builds an SDK client in a compound assignment, a reassigned `let`, or
on the global object. No edge needed rechecking by hand.

At 0.3.8 (M9.7n, ADR-0270: a result traced while something it reads is still being traced
isn't kept as final, a global `var` read or written by its bare name is its global path, and
a use of the global object the matcher can't follow makes the paths below it unread) each pin
was analyzed again the same way (`apps/web/dist/m97n-pins.mjs`) and is again identical to the
0.3.1 graph but for the version: 7,784 / 529 / 1,525 nodes, 12,630 (873) / 542 (29) /
2,323 (142) edges, and 10,560,747 / 439,847 / 1,999,969 bytes, with no node or edge added,
removed, or changed. No pin reads an SDK client through a getter written back to what it
reads, or off the global object. No edge needed rechecking by hand.

At 0.3.10 (M9.7p, ADR-0272: a property holding an SDK client is trusted only when every
store to it is seen, `new` of a wrapper or a repo class is unread, and a parameter's default
is joined with what callers pass) each pin was analyzed again the same way
(`apps/web/dist/m97p-pins.mjs`) and is again identical to the 0.3.1 graph but for the
version: 7,784 / 529 / 1,525 nodes, 12,630 (873) / 542 (29) / 2,323 (142) edges, and
10,560,748 / 439,848 / 1,999,970 bytes (one more than 0.3.1's each, for the version's extra
digit), with no node or edge added, removed, or changed. No pin's SDK client is a property
stored from outside its declarations. No edge needed rechecking by hand.

### At 0.3.0

All three pins were analyzed on the site at analyzer 0.3.0 on 2026-11-10 (M9.1b2b), right
after 0.3.0 deployed: maxun's and anything-llm's by opening their permalinks (no graph of
either existed), taxonomy's by opening its repo page (its head is still the pin, and its
graph was 0.2.0's). Each production graph was then compared with a local analysis at the same
version, built the way the worker builds one: GitHub's tarball of the commit, extracted with
the worker's `extractTarball`, then `analyze` + `serializeGraph` with the owner, name, and
SHA, no cache.

| Repo | Commit | Files extracted | Nodes | Edges (inferred) | Warnings | Bytes | Production vs local |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| anything-llm | `308b276` | 1,586 | 7,784 | 12,630 (873) | 3 | 10,560,747 | identical (SHA-256 `614f5e3b…`) |
| taxonomy | `298a885` | 188 | 529 | 542 (29) | 1 | 439,847 | identical (SHA-256 `bc08e4e1…`) |
| maxun | `99c6bd0` | 276 | 1,525 | 2,323 (142) | 0 | 1,999,969 | identical (SHA-256 `0951985d…`) |

Each inferred-edge count is the one checked by hand above. Before 0.3.0, production's
taxonomy graph (0.2.0, 439,252 bytes) differed from a local 0.2.0 run: the version hadn't
moved with the output (ADR-0256).

One gap: the graph's URL has no version in it, and the CDN keeps a graph for a day, so
taxonomy's permalink was still served the cached 0.2.0 graph after the 0.3.0 analysis
finished (a fresh URL served 0.3.0). It expires within a day. M9.1b2c fixes it for every
version bump.

## Results so far

- **shadcn-ui/taxonomy** (`298a885`, checked 2026-11-09): 29 inferred edges.
  - 27 correct, 0 wrong. The 2 unresolved edges are `app/api/og/route.tsx` loading its
    bundled fonts with `fetch(new URL("…", import.meta.url))`.
  - Every `fetch(`, `db.<model>.`, and `stripe.` call in the app is on an edge.
    `stripe.webhooks.constructEvent` correctly has none, since it checks a signature
    locally.
  - Missing: NextAuth's `PrismaAdapter` uses Account, Session, and VerificationToken from
    inside the library, so those models have no reads or writes drawn.
  - At the first check the font loads' reason (`DYNAMIC_URL`, "only known at runtime")
    misdescribed `import.meta.url`, the module's own file. Since M9.1a4 (ADR-0251) they are
    `NO_MATCHING_ROUTE`, "the URL is a file next to the module …, which no route serves".
    Re-dumped at that fix, only those two reasons changed. They stay on the diagram: the eval
    labels every `fetch`, so dropping them would count as missing call sites. maxun's and
    anything-llm's pins have no request on an `import.meta.url` base (only
    `fileURLToPath(import.meta.url)` and `new Worker(new URL(…))`), so their records don't
    change.
- **getmaxun/maxun** (`99c6bd0`, checked 2026-11-09): 142 inferred edges.
  - 93 correct (74 frontend requests to their Express routes, 19 external calls), 0 wrong,
    49 unresolved.
  - The unresolved ones: 28 LLM requests to a user-configured base, 14 MCP worker requests
    through a `this.apiUrl` wrapper, 2 user webhooks, 2 screenshot downloads, 2 health checks
    to the browser service's raw `http` server, and 1 request to a route that doesn't exist.
  - Every `fetch(` and `axios` call in the app is on an edge.
  - The routers in `server/src/api/` (26 of 101 routes) are mounted at `/api` by a
    `readdirSync` + `require` loop that picks `route.default || route`. At the first check the
    analyzer didn't read the `||`, so it warned "never mounted" and labeled them without the
    prefix (`GET /robots` for `GET /api/robots`). Since M9.1a5 (ADR-0162's amendment) all 26
    carry `/api` and the warning is gone. Re-dumped at that fix, the 142 edges are identical:
    no request reaches those routes.
  - Missing: the database (Sequelize; v1 reads Prisma only), MinIO, the Airtable SDK's
    record calls, Google's token exchange, and socket.io traffic.
- **Mintplex-Labs/anything-llm** (`308b276`, checked 2026-11-09): 873 inferred edges, checked
  one service pair at a time (M9.1a3a–f), and each later fix's changed edges by hand.
  - 659 correct, 0 wrong, 214 unresolved. 372 wrong edges were found along the way and fixed
    in the analyzer (below), and the check was rerun at each fix.
  - Before any verdict, the first read of the edges found 244 wrong ones. Literal-path
    frontend requests (`${API_BASE}/admin/users`, …) went to both services' `app.all("*")` 404
    handlers instead of the server's `/api` routes (122 frontend functions, two edges
    each). The frontend's base is
    `VITE_API_BASE || "/api"`, and `frontend/.env.example` sets it to `…:3001/api`. The
    analyzer put the example's `/api` in front of the fallback's `/api`, so it looked for
    `/api/api/…`, and only the catch-alls take that.
  - Fixed in M9.1a3a (ADR-0202's amendment, no eval delta): the example's path now replaces
    the fallback's. 978 → 865 edges: the 244 are gone, and each of the 122 functions now
    links only to server routes (131 edges).
  - 11 more edges landed on a catch-all from a loopback host, a wrapper's root-relative
    branch, or an env base (Ollama, Outlook's Graph API, a SearXNG search URL). Fixed in
    M9.1a3b (ADR-0033's amendment, no eval delta): a route that matches every path never
    picks one, so these 9 requests are unresolved and name the catch-all. 865 → 863 edges.
  - **Frontend → server** (M9.1a3c, checked 2026-11-09): 224 edges (228 call sites), all
    correct, 0 wrong. Each request's method and path is the route's, and where a second
    route also takes the path (`GET /api/agent-flows/:uuid` for `…/list`, three more), Express
    runs the one the edge names, since it's registered first.
  - The frontend's 4 unresolved edges build their URL from `fullApiUrl()`, which is the page's
    own origin at runtime when the base is `/api`. The reason is accurate; they're missing
    edges to 4 real routes, not wrong ones.
  - At this check the chat streams and embedding progress were missing: they go through
    `fetchEventSource(` (`@microsoft/fetch-event-source`, 3 calls), which the analyzer didn't
    collect, so the app's main request (`POST /api/workspace/:slug/stream-chat`) had no edge.
    Since M9.1a6 (ADR-0252, a `fetch` in all but name) they are 3 edges to their routes,
    checked by hand: all correct. Re-dumped at that fix, 866 → 869 edges, nothing else
    changed. Still missing: one `navigator.sendBeacon` to the onboarding survey's host, which
    a `fetch` beside it already reaches. Every other request call in `frontend/` is on an edge.
  - **Server, collector, and `extras/` http edges** (M9.1a3d, checked 2026-11-09): 162 edges
    (133 server, 28 collector, 1 root), all unresolved, 0 wrong. For 129 the reason is
    accurate: the base is a parameter, the user's settings or env, a link the user gives, a
    URL from a response, or a test's own server (38 edges in two test files).
  - For the other 33, `DYNAMIC_URL`'s "only known at runtime" overstates it. The base is a
    literal in a class or object member that the analyzer doesn't read: a constructor's
    `this.endpoint`, a static field or getter, an object property read through `this`, or a
    private method returning a template. Planned as M9.1a7.
  - The biggest gap this leaves is **server → collector**. Every request from the server to
    the collector goes through `CollectorApi`, whose `this.endpoint` is
    `http://127.0.0.1:${COLLECTOR_PORT || 8888}`, so the demo draws no server → collector
    link at all. 8 of its 9 requests would reach a collector route (`POST /process`,
    `/process-link`, `/parse`, …).
  - Since M9.1a7a (ADR-0253, an instance field written once is read as what was written),
    `CollectorApi`'s 7 literal-path requests are edges to the collector's routes, checked by
    hand: all correct, the demo's first server → collector links. `online()`'s `GET /` names
    the collector's `ALL /*`, and `forwardExtensionRequest`'s path, its caller's `endpoint`,
    reads as unknown. Deepgram's request reaches api.deepgram.com. Re-dumped at that fix, 869
    edges: 18 replaced, 13 reasons changed, nothing else. The other 23 overstated reasons
    (static fields and getters, `CommunityHub.apiBase`, `#getBaseUrl()`) are M9.1a7b's.
  - Since M9.1a7b (ADR-0254, static members, `#private` methods, and an object's own property
    read through `this`), all 23 are resolved, checked by hand. Foundry's catalog, the
    context-window map, Gmail's and Calendar's Apps Script, and `CommunityHub`'s 4 requests
    are external calls to their hosts: all correct. `CommunityHub.apiBase` is a `NODE_ENV`
    ternary, so each hub request also draws its development branch (`127.0.0.1:5001`, the
    hub's local emulator) unresolved. Lemond's 15 requests read `http://127.0.0.1:{}/api/v1/…`,
    a binary the server downloads and runs, not a service in the repo: only the `ALL /*` 404
    handlers take those paths, so they're unresolved naming them. Re-dumped at that fix,
    869 → 873 edges: 5 removed, 9 added, 20 reasons changed, nothing else.
  - Sweep: every `fetch(`, `axios`, `http(s).get/request(`, `got(`, and `request(` call in
    `server/`, `collector/`, and `extras/` is on an edge, or is a wrapper body drawn at its
    callers, or isn't an HTTP request (a WebSocket in an example page, an MSSQL request, an
    SDK method rebinding).
  - **External calls** (M9.1a3e1, checked 2026-11-09): 191 edges, 74 correct, **117 wrong**.
    All 59 `fetch(` edges to a literal host are correct (Microsoft Graph, search APIs, model
    lists, YouTube). So are the 15 SDK edges whose client is built without a `baseURL` (10
    `openai`, 5 `@anthropic-ai/sdk`).
  - The 117 wrong ones all come from one gap: the SDK detector sends every call on an
    `openai` or Anthropic client to the SDK's default host, ignoring the constructor's
    `baseURL`. anything-llm uses the `openai` package as the client for most providers, so
    `new OpenAI({ baseURL: "https://api.groq.com/openai/v1" })` was drawn as a call to
    api.openai.com.
  - Of the 117, 56 name another provider in a literal base (20 hosts), 57 use a base the user
    configures (LM Studio, LiteLLM, Azure, Vertex, Bedrock, …) or the loopback lemond, 2 are
    Bedrock's Anthropic client, 1 is a script calling AnythingLLM's own API on
    `localhost:3001`, and 1 is a Jest mock (`create.mockImplementation(…)`).
  - Fixed in M9.1a3e2a (ADR-0249, no eval delta): the detector reads the client's `baseURL`
    where it's built, and its calls go through the same route matcher as `fetch` calls.
  - **Rechecked** (M9.1a3e2b, 2026-11-09): re-dumped at the fix, the 117 wrong edges are gone
    and nothing else changed (863 → 866: 117 removed, 120 added at their sites). 0 wrong.
    - 46 of the 56 literal-base edges now go to their own host (16 hosts, api.groq.com to
      api.z.ai). The other 10 set `baseURL: this.basePath`, a constructor field holding a
      literal, and are unresolved.
    - The compatibility script's 5 calls are 4 edges to the server's `/api/v1/openai/*` routes
      (models, chat completions ×2, embeddings, vector stores), each the route Express runs.
    - The 57 runtime bases and Bedrock's 2 Anthropic calls are 60 unresolved edges. The Jest
      mock has no edge.
  - Of the 70 unresolved, 58 reasons are accurate (a parameter, the user's settings, a region
    the user picks, a plain env var, Azure's unread deployment path). 12 overstate "only known
    at runtime": the 10 `this.basePath` fields, and embedded lemond's static getter
    (`http://127.0.0.1:${port()}`, 2). That's M9.1a3d's class-member gap, planned as M9.1a7.
  - Since M9.1a7a (ADR-0253): the 10 literal `this.basePath` calls are external calls to their
    own hosts (apipie.ai, api.cometapi.com, api.novita.ai, openrouter.ai, api.ppinfra.com),
    checked by hand: all correct. 11 calls on a `this.basePath` read from an env var now name
    the variable. Lemond's 2 stay for M9.1a7b.
  - Since M9.1a7b (ADR-0254): lemond's 2 SDK calls read `http://127.0.0.1:{}/api/v1/chat/completions`
    through its static method and getter, unresolved naming the `ALL /*` handlers, the only
    routes taking it. No overstated reason is left among the SDK edges.
  - Missing, not wrong: 83 SDK calls on clients the detector doesn't trace (the agent
    providers' `this.client`, helpers taking `client` as a parameter, the image generators,
    Mistral's wrapped client).
  - **Prisma** (M9.1a3f, checked 2026-11-09): 282 edges (117 reads, 132 writes, 33 stores),
    all correct, 0 wrong.
    - The 249 reads/writes edges (258 call sites) all go through the server's one client,
      `server/utils/prisma`'s `new PrismaClient(…)`. The exceptions are 7 calls on the `tx`
      of a `prisma.$transaction(async (tx) => …)` callback and the seed script's own
      client. Each call's op is the edge's kind, and its accessor is the edge's model.
    - The 33 `stores` edges are the schema's 33 models, each to its only datasource
      (SQLite, `file:../storage/anythingllm.db`).
    - Sweep: every `<receiver>.<model>.<op>(` call for the 33 models is on an edge. The 9
      `$transaction` calls wrap calls that are each drawn, and there are no raw queries and
      no computed `prisma[…]` access, so no Prisma edge is missing.
