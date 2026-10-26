# bench

Benchmarks, run on demand and at milestone gates (docs/EVALUATION.md §2). Results are committed under `results/` and reported exactly as measured.

## Analysis time

```sh
pnpm bench                              # from the repo root; builds first
pnpm bench -- --label "Oracle VM"       # label the machine in the report
```

For each repo in `repos.json` (pinned SHA), `src/analysis.ts`:

1. Shallow-fetches exactly that SHA into `bench/.repos/<name>` (gitignored, LFS smudging off). The checkout is only read; nothing in it is installed or run.
2. Runs `analyze` once to warm up, then 5 measured times. Each run is a fresh Node process (`src/run-once.ts`) so peak RSS belongs to that run alone.
3. Writes `results/<date>-analysis-<name>.md` (median/min/max wall clock, peak RSS, per-stage times, graph size, machine) and the raw per-run numbers as `.json` next to it.

Every run also hashes the canonical graph bytes; the report says whether all runs produced the same graph.
