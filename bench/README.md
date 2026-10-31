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

## Stress (very large repos)

```sh
pnpm bench:stress                       # from the repo root; builds first
pnpm bench:stress -- --runs 2 --heap-mb 12288 --label "laptop"
```

For each repo in `repos.json` `stress` (pinned SHA; microsoft/vscode, #10), `src/stress.ts` measures what production would meet, without production's limits:

1. Downloads the tarball the way the worker does (`openTarball`) to `bench/.repos/<name>-<sha7>.tar.gz` and extracts it with the worker's own `extractTarball`, its 500 MiB and 100,000-entry limits lifted, so the decompressed size and entry count are the numbers those limits check. Both are recorded in `bench/.repos/<name>-<sha7>.json`; a rerun reuses the tree. Nothing in it is installed or run.
2. Takes the analyzer's inventory with the 20,000-source-file and 50 MB source-size limits lifted (the exact `LIMIT_FILES` and `LIMIT_SOURCE_SIZE` counts).
3. Runs `analyze` `--runs` times (default 1, no warm-up), each in a fresh Node process with `--max-old-space-size` from `--heap-mb` (default 12,288 instead of the worker's 3,072), no time limit, and both inventory limits lifted.
4. Writes `results/<date>-stress-<name>.md`: every production limit (`LIMIT_SIZE`, `LIMIT_ENTRIES`, `LIMIT_FILES`, `LIMIT_SOURCE_SIZE`, `LIMIT_MEMORY`, `LIMIT_TIME`, read from the code that enforces them) against what was measured, the first one a job would hit, per-stage times with when each ended (so the stage running at 5 minutes is known), and the graph size; the raw numbers go in the `.json` next to it. Observations are added by hand.

## Capped runs (what a job's analysis step gets)

```sh
pnpm bench:capped .repos/calcom .repos/vscode-11ba54a-tree/src/vs/editor   # folders relative to bench/
```

`src/capped.ts` runs each folder through the worker's own sandboxed runner (`runAnalysis`: 3 GB heap, 5 minutes, no network, the analyzer's default limits), one after another, and prints a JSON line per folder: source files and MiB, outcome or failure code, time, the last analyzer step seen and when, and stage times. It calibrated the 50 MB source-size limit (ADR-0137, `results/2026-10-31-capped-vscode.md`); to measure folders over that limit, raise `MAX_SOURCE_MB` in `packages/analyzer/src/inventory.ts` and rebuild first.

## Render fps

```sh
pnpm bench:render                       # from the repo root; builds first
pnpm bench:render -- --label "laptop"   # label the machine; --seconds sets the run length (10)
```

`src/render.ts` measures the explorer's frame rate while it's panned and zoomed (EVALUATION.md §2):

1. Builds the cases: a synthetic graph at exactly 500, 1,000, and 2,000 visible nodes (`src/renderGraphs.ts`: 10 services broken down into routes or pages, with lines between them), and the first repo in `repos.json` (checked out and analyzed as above), opened shallowest first until the level is as close to each target as it gets without passing it, under the explorer's default filters.
2. Builds `render/` with Vite (production React, ELK in a Web Worker, like the website) and serves it on a local port.
3. For each case, in headless Chromium at 1440×900: waits for the first layout (up to 10 minutes; a case still laying out is reported as not measured), zooms out to 25% and scans the level a canvas at a time to park the camera where the most boxes are drawn, records 2 s idle (the display's frame rate, the ceiling), then records `requestAnimationFrame` timestamps while Playwright pans and zooms for 10 s (wheel pan, Ctrl+wheel zoom in, a drag, Ctrl+wheel zoom out, wheel pan back).
4. Writes `results/<date>-render.md` (median and p5 fps per case, boxes in the DOM, first-layout time, machine) and the raw numbers as `.json`.

`--only <text>` runs only the cases whose ID contains it (e.g. `--only calcom-1000`) and writes no report, for debugging. Commit the code before running, so the report's commit reproduces it.
