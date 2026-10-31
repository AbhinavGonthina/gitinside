import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { analyze } from "@gitinside/analyzer";
import { chromium, errors, type Page } from "@playwright/test";
import { BENCH, benchRepos, checkout, flag, gitinsideCommit, machine, today } from "./env.js";
import { frameStats } from "./fps.js";
import { openToReach, syntheticGraph, type RenderCase } from "./renderGraphs.js";
import { renderRenderReport, type RenderMeta, type RenderRun } from "./renderReport.js";

// Render benchmark (EVALUATION.md §2, M4b.13b): the explorer at 500 / 1,000 /
// 2,000 visible nodes, on a synthetic graph and on the analysis benchmark's
// real repo (bench/repos.json, checked out under bench/.repos/ and only read),
// panned and zoomed by Playwright for 10 s in Chromium while the page records
// requestAnimationFrame timestamps. Writes bench/results/<date>-render.{md,json}.
//
// Usage: pnpm bench:render [--label "<machine label>"] [--seconds 10]

const PAGE = join(BENCH, "render", "dist");
const TARGETS = [500, 1000, 2000] as const;
const VIEWPORT = { width: 1440, height: 900 };
const IDLE_SECONDS = 2;
/** How long a case's first layout may take before it's reported as not done (nothing to pan). */
const LAYOUT_LIMIT_MS = 10 * 60_000;
/** How often Playwright sends a wheel or pointer event: about a trackpad's rate. */
const EVENT_MS = 8;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};

/** Serve the built page on a free local port. */
async function serve(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = normalize(join(PAGE, path === "/" ? "index.html" : path));
    if (!file.startsWith(PAGE + sep) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start recording frame timestamps and the number of boxes in the DOM, in the page. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Each recording has its own object: a stopped loop's last pending callback
    // sees its own `on` turn false, so it never adds frames to the next recording.
    const run = { frames: [] as number[], boxes: [] as number[], on: true };
    (window as unknown as { benchRun: typeof run }).benchRun = run;
    let frame = 0;
    const tick = (t: number) => {
      if (!run.on) return;
      run.frames.push(t);
      // Counting boxes costs a query; every 15th frame is enough to see culling work.
      if (frame++ % 15 === 0) run.boxes.push(document.querySelectorAll(".gi-drill__node").length);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Stop recording; the timestamps and box counts since `record`. */
async function stop(page: Page): Promise<{ frames: number[]; boxes: number[] }> {
  return page.evaluate(() => {
    const run = (
      window as unknown as { benchRun: { frames: number[]; boxes: number[]; on: boolean } }
    ).benchRun;
    run.on = false;
    return { frames: run.frames, boxes: run.boxes };
  });
}

/**
 * Pan and zoom for `seconds`, in five equal phases: wheel pan, Ctrl+wheel
 * zoom in around the center, a circular drag, Ctrl+wheel zoom out, and a
 * wheel pan back. Each event waits {@link EVENT_MS}.
 */
async function drive(page: Page, seconds: number): Promise<void> {
  const box = await page.locator(".gi-explorer__canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const phase = (seconds * 1000) / 5;
  const start = performance.now();
  await page.mouse.move(cx, cy);
  let current = -1;
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed = performance.now() - start) {
    const at = Math.min(4, Math.floor(elapsed / phase));
    if (at !== current) {
      // Leaving a phase: let go of what it held.
      if (current === 1 || current === 3) await page.keyboard.up("Control");
      if (current === 2) await page.mouse.up();
      if (at === 1 || at === 3) await page.keyboard.down("Control");
      if (at === 2) {
        await page.mouse.move(cx + 150, cy);
        await page.mouse.down();
      }
      current = at;
    }
    if (at === 0) await page.mouse.wheel(6, 4);
    else if (at === 1) await page.mouse.wheel(0, -2);
    else if (at === 2) {
      const angle = ((elapsed - 2 * phase) / phase) * 2 * Math.PI;
      await page.mouse.move(cx + 150 * Math.cos(angle), cy + 150 * Math.sin(angle));
    } else if (at === 3) await page.mouse.wheel(0, 2);
    else await page.mouse.wheel(-6, -4);
    await pause(EVENT_MS);
  }
  if (current === 1 || current === 3) await page.keyboard.up("Control");
  if (current === 2) await page.mouse.up();
}

/** One case: open it, wait for the first layout, sample idle, then pan and zoom. */
async function measure(
  page: Page,
  origin: string,
  id: string,
  seconds: number,
): Promise<Pick<RenderRun, "layoutMs" | "frames">> {
  const opened = performance.now();
  await page.goto(`${origin}/?case=${id}`);
  try {
    await page.locator('[data-layout="done"]').waitFor({ timeout: LAYOUT_LIMIT_MS });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    return { layoutMs: LAYOUT_LIMIT_MS, frames: null };
  }
  const layoutMs = performance.now() - opened;
  // The first fit and the edges' fade-in finish before anything is measured.
  await pause(1500);
  await record(page);
  await pause(IDLE_SECONDS * 1000);
  const idle = await stop(page);
  await record(page);
  await drive(page, seconds);
  const moving = await stop(page);
  return {
    layoutMs,
    frames: {
      drawn: { min: Math.min(...moving.boxes), max: Math.max(...moving.boxes) },
      idle: frameStats(idle.frames),
      moving: frameStats(moving.frames),
    },
  };
}

async function main(): Promise<void> {
  const label = flag("label", "dev machine");
  const seconds = Number(flag("seconds", "10"));
  if (!existsSync(join(PAGE, "index.html")))
    throw new Error("build the page first (pnpm bench:render)");
  const [repo] = await benchRepos();
  if (!repo) throw new Error("bench/repos.json has no repo");

  process.stderr.write(`${repo.name}: checking out ${repo.sha}, analyzing\n`);
  const real = await analyze(await checkout(repo), {
    owner: repo.owner,
    name: repo.repo,
    sha: repo.sha,
  });
  const cases: { id: string; graph: string; target: number; data: RenderCase }[] = [];
  for (const target of TARGETS) {
    cases.push({
      id: `synthetic-${target}`,
      graph: "synthetic",
      target,
      data: syntheticGraph(target),
    });
    const reached = openToReach(real, target);
    process.stderr.write(
      `${repo.name} ${target}: ${reached.nodes} nodes, ${reached.open.length} open\n`,
    );
    cases.push({ id: `${repo.name}-${target}`, graph: repo.name, target, data: reached });
  }
  await mkdir(join(PAGE, "cases"), { recursive: true });
  for (const c of cases) {
    await writeFile(
      join(PAGE, "cases", `${c.id}.json`),
      JSON.stringify({ graph: c.data.graph, open: c.data.open }),
    );
  }

  const { server, origin } = await serve();
  const browser = await chromium.launch({ headless: true });
  const browserName = `Chromium ${browser.version()} (headless)`;
  const runs: RenderRun[] = [];
  try {
    for (const c of cases) {
      const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      const measured = await measure(page, origin, c.id, seconds);
      if (pageErrors.length > 0) {
        throw new Error(`${c.id}: page errors: ${pageErrors.join("; ")}`);
      }
      await context.close();
      const run = {
        graph: c.graph,
        target: c.target,
        nodes: c.data.nodes,
        lines: c.data.lines,
        ...measured,
      };
      process.stderr.write(
        run.frames
          ? `${c.id}: ${run.nodes} nodes, layout ${Math.round(run.layoutMs)} ms, ` +
              `${run.frames.moving.medianFps.toFixed(1)} fps median, ` +
              `${run.frames.moving.p5Fps.toFixed(1)} p5\n`
          : `${c.id}: ${run.nodes} nodes, first layout not done after ${run.layoutMs} ms\n`,
      );
      runs.push(run);
    }
  } finally {
    await browser.close();
    server.close();
  }

  const date = today();
  const meta: RenderMeta = {
    date,
    gitinsideSha: gitinsideCommit(),
    machine: machine(label),
    browser: browserName,
    viewport: VIEWPORT,
    seconds,
    idleSeconds: IDLE_SECONDS,
    real: { name: repo.name, url: repo.url, sha: repo.sha },
  };
  await mkdir(join(BENCH, "results"), { recursive: true });
  const base = join(BENCH, "results", `${date}-render`);
  await writeFile(`${base}.json`, `${JSON.stringify({ meta, runs }, null, 2)}\n`);
  await writeFile(`${base}.md`, renderRenderReport(meta, runs));
  process.stderr.write(`wrote ${base}.md\n`);
}

await main();
