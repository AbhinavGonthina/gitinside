import type { FrameStats } from "./fps.js";
import type { Machine } from "./report.js";

/** The fps target at 2,000 visible nodes (SPEC.md, EVALUATION.md §2). */
export const TARGET_FPS = 60;

/** What the page's frames measured once the first layout was drawn. */
export interface FrameRun {
  /** Fewest and most boxes in the DOM while panning and zooming (culling draws fewer). */
  drawn: { min: number; max: number };
  /** The page left alone for the idle sample: the display's own frame rate. */
  idle: FrameStats;
  /** While Playwright panned and zoomed. */
  moving: FrameStats;
}

/** What one render case measured in the browser. */
export interface RenderRun {
  /** Which graph: "synthetic" or the real repo's name. */
  graph: string;
  /** The visible nodes asked for. */
  target: number;
  /** Boxes on the canvas at the case's expansion (what the level holds, culled or not). */
  nodes: number;
  /** Lines on the canvas at that expansion. */
  lines: number;
  /**
   * From opening the page to the first drawn layout (`data-layout="done"`),
   * in ms; when it didn't finish, how long it was waited for.
   */
  layoutMs: number;
  /** The frames, or null when the first layout didn't finish in time (nothing to pan). */
  frames: FrameRun | null;
}

/** Everything the report says besides the runs. */
export interface RenderMeta {
  date: string;
  gitinsideSha: string;
  machine: Machine;
  /** Browser name and version, and whether it ran headless. */
  browser: string;
  viewport: { width: number; height: number };
  /** How long each case was panned and zoomed, in seconds. */
  seconds: number;
  /** How long the idle sample was, in seconds. */
  idleSeconds: number;
  /** The real graph's repo. */
  real: { name: string; url: string; sha: string };
}

const fps = (n: number): string => n.toFixed(1);
const int = (n: number): string => Math.round(n).toLocaleString("en-US");
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

/**
 * Whether a run met the target: its median fps, rounded to a whole frame
 * per second, is at least {@link TARGET_FPS}. A 60Hz display's frames are
 * 16.6–16.7 ms apart, so a strict 60.0 would fail on timer rounding. A run
 * whose first layout never finished didn't meet it.
 */
export function meetsTarget(run: RenderRun): boolean {
  return run.frames !== null && Math.round(run.frames.moving.medianFps) >= TARGET_FPS;
}

/** One line saying whether each graph's largest case met the target, exactly as measured. */
function verdicts(runs: readonly RenderRun[]): string[] {
  const largest = new Map<string, RenderRun>();
  for (const run of runs) {
    const prev = largest.get(run.graph);
    if (!prev || run.target > prev.target) largest.set(run.graph, run);
  }
  return [...largest.values()].map((run) => {
    const head = `- **${run.graph}, ${int(run.nodes)} visible nodes:**`;
    if (!run.frames) {
      return `${head} **not measured**: the first layout didn't finish within ${minutes(run.layoutMs)}, so there was nothing to pan.`;
    }
    const { moving } = run.frames;
    return `${head} ${fps(moving.medianFps)} fps median, ${fps(moving.p5Fps)} fps p5: ${
      meetsTarget(run) ? "meets" : "**misses**"
    } the ${TARGET_FPS}fps median target.`;
  });
}

/** One table row; a run without frames says its layout didn't finish. */
function row(r: RenderRun): string {
  const head = `| ${r.graph} | ${int(r.target)} | ${int(r.nodes)} | ${int(r.lines)} |`;
  if (!r.frames) {
    return `${head} – | not done after ${minutes(r.layoutMs)} | – | – | – | – | – |`;
  }
  const { drawn, idle, moving } = r.frames;
  return `${head} ${int(drawn.min)}–${int(drawn.max)} | ${int(r.layoutMs)} ms | ${fps(idle.medianFps)} | ${fps(moving.medianFps)} | ${fps(moving.p5Fps)} | ${int(moving.longFrames)} of ${int(moving.frames)} | ${int(moving.worstMs)} ms |`;
}

/** Render the committed Markdown report. Numbers are printed exactly as measured. */
export function renderRenderReport(meta: RenderMeta, runs: readonly RenderRun[]): string {
  const m = meta.machine;
  const lines = [
    `# Render benchmark (${meta.date})`,
    "",
    `- **GitInside:** \`${meta.gitinsideSha}\``,
    `- **Graphs:** a synthetic graph (10 services broken down into routes or pages, \`bench/src/renderGraphs.ts\`) and ${meta.real.name} (${meta.real.url} at \`${meta.real.sha}\`), each opened to the level closest to 500, 1,000, and 2,000 visible nodes without passing it, under the explorer's default filters.`,
    `- **Method:** the explorer in a production build (\`bench/render/\`), ${meta.browser}, ${meta.viewport.width}×${meta.viewport.height}, dark theme. After the first layout, ${meta.idleSeconds} s left idle, then ${meta.seconds} s of Playwright panning and zooming (wheel pan, Ctrl+wheel zoom in, a drag, Ctrl+wheel zoom out, wheel pan back). fps comes from \`requestAnimationFrame\` timestamps: the median, and p5 (the 95th-percentile frame time) (EVALUATION.md §2).`,
    `- **Machine:** ${m.label}: ${m.cpu} (${m.cores} logical cores), ${m.ramGiB} GiB RAM, ${m.os}, Node ${m.node}`,
    "",
    "## Result",
    "",
    ...verdicts(runs),
    "",
    `A run meets the target when its median fps rounds to ${TARGET_FPS} or more; requestAnimationFrame never runs faster than the display, so the idle column is the ceiling.`,
    "",
    "## Runs",
    "",
    "| Graph | Target | Visible nodes | Lines | Boxes in the DOM | First layout | Idle fps | Median fps | p5 fps | Frames over 50 ms | Worst frame |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...runs.map(row),
    "",
    "Raw numbers are in the JSON file next to this report.",
    "",
  ];
  return lines.join("\n");
}
