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
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | `308b276` | 68,095 | 978 | not yet (M9.1a3) | |
| [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy) | `298a885` | 19,289 | 29 | [all 29](shadcn-ui__taxonomy.json) | 0 |
| [getmaxun/maxun](https://github.com/getmaxun/maxun) | `99c6bd0` | 18,183 | 142 | not yet (M9.1a2) | |

Stars are as of 2026-11-09. Edge counts come from analyzer 0.2.0 at the pinned commit.

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
