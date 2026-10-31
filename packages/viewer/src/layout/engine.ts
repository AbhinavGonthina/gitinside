import ElkApi, { type ELK } from "elkjs/lib/elk-api.js";
import type { HierarchyIndex } from "../model/hierarchy.js";
import type { GraphView } from "../model/view.js";
import { layoutInput, runLayout, type LayoutInput, type LayoutResult } from "./elk.js";

/**
 * Where the explorer's layouts run (M4b.2b, ADR-0107), and the cache that
 * keeps one per expansion state.
 *
 * ELK takes tens of milliseconds on a small view and seconds on a big one, so
 * it runs in a Web Worker and the canvas stays responsive meanwhile. The
 * worker is ELK's own worker script (`@gitinside/viewer/layout-worker`): the
 * main thread sends ELK's graph and reads the result back with `readLayout`.
 * The host's bundler builds the worker, so the host passes a factory (see
 * {@link LayoutWorkerFactory}). Without one, or when the worker fails to load
 * or crashes, layouts run on the main thread with the same ELK build, and
 * give the same result.
 */

/**
 * Makes the layout worker from `@gitinside/viewer/layout-worker`, e.g.
 * `() => new Worker(new URL("./layoutWorker.ts", import.meta.url), { type: "module" })`
 * with a host file that imports the entry: bundlers only build a worker from
 * a path they can see.
 */
export type LayoutWorkerFactory = () => Worker;

/** Options for {@link createLayoutEngine}. */
export interface LayoutEngineOptions {
  /** Makes the layout worker. Without one, layouts run on the main thread. */
  worker?: LayoutWorkerFactory | undefined;
  /** Loads ELK for the main thread, on first use. Defaults to elkjs's bundled build. */
  loadElk?: (() => Promise<ELK>) | undefined;
}

/** Runs layouts: in its worker while that works, else on the main thread. */
export interface LayoutEngine {
  /** Lays out an input. Rejects on ELK's own errors, wherever it ran. */
  layout(input: LayoutInput): Promise<LayoutResult>;
  /** Where the next layout runs. */
  readonly runsIn: "worker" | "main";
  /** Stops the worker. Layouts still running reject, and later ones run on the main thread. */
  dispose(): void;
}

/** The worker failed (didn't load, crashed, or sent what can't be read): run in the thread instead. */
class WorkerFailed extends Error {}

/** A started worker, with a promise that rejects when it fails or is stopped. */
interface RunningWorker {
  elk: ELK;
  failed: Promise<never>;
  stop(reason: Error): void;
}

async function bundledElk(): Promise<ELK> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  return new ELK();
}

function startWorker(factory: LayoutWorkerFactory): RunningWorker | undefined {
  let worker: Worker;
  try {
    worker = factory();
  } catch (error) {
    console.warn(
      "GitInside: couldn't start the layout worker; laying out on the main thread",
      error,
    );
    return undefined;
  }
  let fail: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  // Only ever raced against a layout; nobody awaits it alone.
  failed.catch(() => undefined);
  const onError = (event: Event) => {
    // Handled here (the main thread takes over), so not reported as uncaught.
    event.preventDefault();
    const { message } = event as Partial<ErrorEvent>;
    const reason = typeof message === "string" && message ? message : event.type;
    console.warn(`GitInside: the layout worker failed (${reason}); laying out on the main thread`);
    fail(new WorkerFailed(reason));
  };
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onError);
  const elk = new ElkApi({ workerFactory: () => worker });
  return {
    elk,
    failed,
    stop(reason) {
      fail(reason);
      elk.terminateWorker();
    },
  };
}

/** Starts a layout engine: the worker now (if given), ELK for the main thread only when needed. */
export function createLayoutEngine(options: LayoutEngineOptions = {}): LayoutEngine {
  const loadElk = options.loadElk ?? bundledElk;
  let mainElk: Promise<ELK> | undefined;
  let worker = options.worker ? startWorker(options.worker) : undefined;

  async function inThread(input: LayoutInput): Promise<LayoutResult> {
    mainElk ??= loadElk();
    return runLayout(await mainElk, input);
  }

  return {
    get runsIn() {
      return worker ? "worker" : "main";
    },
    async layout(input) {
      const current = worker;
      if (current) {
        try {
          return await Promise.race([runLayout(current.elk, input), current.failed]);
        } catch (error) {
          if (!(error instanceof WorkerFailed)) throw error;
          if (worker === current) {
            current.stop(error);
            worker = undefined;
          }
        }
      }
      return inThread(input);
    },
    dispose() {
      worker?.stop(new Error("The layout engine was disposed"));
      worker = undefined;
    },
  };
}

/** How many expansion states a {@link LayoutCache} keeps, least recently used out first. */
export const LAYOUT_CACHE_SIZE = 32;

/**
 * The cache key of a view's layout: its open nodes and hidden edge kinds,
 * both sorted, and its filters' key. For one graph, a view is a pure function
 * of these three, so asking for an inner node inside a closed one shares the
 * closed state's key.
 */
export function layoutKey(view: Pick<GraphView, "open" | "hidden" | "filtered">): string {
  return JSON.stringify([view.open, view.hidden, view.filtered]);
}

/** Layouts of one graph's views, one per expansion state (`view.open` + hidden kinds + filters). */
export interface LayoutCache {
  /**
   * The view's layout: the cached one, else laid out by the engine. Asking
   * again before it's done shares the same run; a failed run isn't kept.
   */
  layout(view: GraphView): Promise<LayoutResult>;
  /** The view's layout if it's done, for drawing a known state at once (no pending frame). */
  peek(view: GraphView): LayoutResult | undefined;
  /** How many states are cached, done or running. */
  readonly size: number;
}

interface CacheEntry {
  promise: Promise<LayoutResult>;
  result?: LayoutResult;
}

/**
 * A layout cache for one graph's index. Keys hold no graph identity, so make
 * a new cache when the graph changes.
 */
export function createLayoutCache(
  index: HierarchyIndex,
  engine: Pick<LayoutEngine, "layout">,
  limit = LAYOUT_CACHE_SIZE,
): LayoutCache {
  // A Map iterates in insertion order: re-inserting on use keeps the least recent first.
  const entries = new Map<string, CacheEntry>();
  return {
    get size() {
      return entries.size;
    },
    peek(view) {
      return entries.get(layoutKey(view))?.result;
    },
    layout(view) {
      const key = layoutKey(view);
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return hit.promise;
      }
      const entry: CacheEntry = {
        promise: engine.layout(layoutInput(index, view)).then(
          (result) => {
            entry.result = result;
            return result;
          },
          (error: unknown) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
          },
        ),
      };
      entries.set(key, entry);
      for (const oldest of entries.keys()) {
        if (entries.size <= limit) break;
        entries.delete(oldest);
      }
      return entry.promise;
    },
  };
}
