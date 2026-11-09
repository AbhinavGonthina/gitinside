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
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | `308b276` | 68,095 | 865 | in progress (M9.1a3) | 244 fixed |
| [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy) | `298a885` | 19,289 | 29 | [all 29](shadcn-ui__taxonomy.json) | 0 |
| [getmaxun/maxun](https://github.com/getmaxun/maxun) | `99c6bd0` | 18,183 | 142 | [all 142](getmaxun__maxun.json) | 0 |

Stars are as of 2026-11-09. Edge counts come from analyzer 0.2.0 at the pinned commit, as of
the latest fix. anything-llm was pinned at 978 edges (`repos.json`); M9.1a3a removed 244 wrong
ones and added 131 right ones.

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
  (M9.1a3a–f).
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
  - 11 edges still land on a catch-all from a loopback host or another wrapper (Ollama,
    Outlook's Graph API, web search). They're next (M9.1a3b).
