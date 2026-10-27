# GitInside

**Git inside your repo.**

See how any codebase really works. Break it down from services to functions, trace every request, and catch broken connections before they ship.

(Status: in development. M1, the analyzer CLI, is done; the website and PR bot come later.)

## Quickstart (analyzer CLI)

GitInside builds the diagram from static analysis. It parses the repo and never installs or runs anything from it.

```sh
pnpm install
pnpm build
node packages/analyzer/dist/cli.js analyze path/to/repo --out architecture.json
```

The output is a schema-valid `architecture.json`, the same bytes every time for the same commit. It covers workspace services, modules, files, symbols, imports, calls, Express and Next.js routes, and Prisma models. Anything it can't resolve appears as an `unresolved` node or a warning, never a guess. Optional flags `--owner`, `--name`, and `--sha` record the repo identity.

## Architecture

A pnpm + Turborepo monorepo:
- `packages/schema` holds the graph format (types + Zod validator).
- `packages/analyzer` holds the analysis pipeline and CLI (inventory → workspaces → per-service TypeScript programs → detectors → validated graph).
- `bench/` holds benchmarks, and `fixtures/` holds golden test repos.

Design notes: [docs/DESIGN.md](docs/DESIGN.md). M1 review: [docs/milestones/M1-review.md](docs/milestones/M1-review.md).

## Results so far

Reported exactly as measured; each links to the committed report.

- **Analysis time (M1 baseline):** cal.com at a pinned SHA (5,041 files, 113 workspace packages) analyzes in a median of 53.3 s (range 27–77 s) with ~2 GiB peak memory on a dev laptop, and every run produces a byte-identical graph. [Report](bench/results/2026-10-26-analysis-calcom.md). Reproduce with `pnpm bench`.

## Contributing setup

After cloning, install the git hooks once:

```sh
sh scripts/setup-hooks.sh        # macOS / Linux / Git Bash
```

```powershell
.\scripts\setup-hooks.ps1        # Windows PowerShell
```
