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
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | `308b276` | 68,095 | 863 | [581 of 863](Mintplex-Labs__anything-llm.json) (M9.1a3c–f) | 244 + 11 fixed; 117 open (M9.1a3e2) |
| [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy) | `298a885` | 19,289 | 29 | [all 29](shadcn-ui__taxonomy.json) | 0 |
| [getmaxun/maxun](https://github.com/getmaxun/maxun) | `99c6bd0` | 18,183 | 142 | [all 142](getmaxun__maxun.json) | 0 |

Stars are as of 2026-11-09. Edge counts come from analyzer 0.2.0 at the pinned commit, as of
the latest fix. anything-llm was pinned at 978 edges (`repos.json`); M9.1a3a removed 244 wrong
ones and added 131 right ones, and M9.1a3b replaced 11 more wrong ones with 9 unresolved ones.

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

## Results so far

- **shadcn-ui/taxonomy** (`298a885`, checked 2026-11-09): 29 inferred edges.
  - 27 correct, 0 wrong. The 2 unresolved edges are `app/api/og/route.tsx` loading its
    bundled fonts with `fetch(new URL("…", import.meta.url))`.
  - Every `fetch(`, `db.<model>.`, and `stripe.` call in the app is on an edge.
    `stripe.webhooks.constructEvent` correctly has none, since it checks a signature
    locally.
  - Missing: NextAuth's `PrismaAdapter` uses Account, Session, and VerificationToken from
    inside the library, so those models have no reads or writes drawn.
  - The font loads' reason (`DYNAMIC_URL`, "only known at runtime") misdescribes
    `import.meta.url`, the module's own file, and draws an unresolved box for a font on
    the demo. Planned as M9.1a4.
- **getmaxun/maxun** (`99c6bd0`, checked 2026-11-09): 142 inferred edges.
  - 93 correct (74 frontend requests to their Express routes, 19 external calls), 0 wrong,
    49 unresolved.
  - The unresolved ones: 28 LLM requests to a user-configured base, 14 MCP worker requests
    through a `this.apiUrl` wrapper, 2 user webhooks, 2 screenshot downloads, 2 health checks
    to the browser service's raw `http` server, and 1 request to a route that doesn't exist.
  - Every `fetch(` and `axios` call in the app is on an edge.
  - The routers in `server/src/api/` (26 of 101 routes) are mounted at `/api` by a
    `readdirSync` + `require` loop the analyzer doesn't follow. It warns, and labels them
    without the prefix (`GET /robots` for `GET /api/robots`). No edge points at them, but the
    labels on the demo are short. Planned as M9.1a5.
  - Missing: the database (Sequelize; v1 reads Prisma only), MinIO, the Airtable SDK's
    record calls, Google's token exchange, and socket.io traffic.
- **Mintplex-Labs/anything-llm** (`308b276`, in progress): checked one service pair at a time
  (M9.1a3a–f). The record lists all 863 edges; the ones not yet checked are `pending`, with
  the task that checks them.
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
  - Missing from the frontend: the chat streams and embedding progress go through
    `fetchEventSource(` (`@microsoft/fetch-event-source`, 3 calls), which the analyzer doesn't
    collect, so the app's main request (`POST /api/workspace/:slug/stream-chat`) has no edge.
    Planned as M9.1a6. Also missing: one `navigator.sendBeacon` to the onboarding survey's
    host, which a `fetch` beside it already reaches. Every other request call in `frontend/`
    is on an edge.
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
    `localhost:3001`, and 1 is a Jest mock (`create.mockImplementation(…)`). The fix is planned
    as M9.1a3e2, and the repo stays out of the gallery until the fix lands and these edges are
    checked again.
  - Missing, not wrong: 83 SDK calls on clients the detector doesn't trace (the agent
    providers' `this.client`, helpers taking `client` as a parameter, the image generators,
    Mistral's wrapped client).
