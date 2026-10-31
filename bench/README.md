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
