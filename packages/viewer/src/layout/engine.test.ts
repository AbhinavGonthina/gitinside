// @vitest-environment node
import ELK from "elkjs/lib/elk.bundled.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo } from "../prototype/shopDemo.testkit.js";
import { layoutInput, runLayout, type LayoutInput, type LayoutResult } from "./elk.js";
import {
  createLayoutCache,
  createLayoutEngine,
  LAYOUT_CACHE_SIZE,
  layoutKey,
  type LayoutEngine,
} from "./engine.js";

const index = buildHierarchy(shopDemo());
const elk = new ELK();
const API_OPEN = ["service:api/"];
const input = (expanded: readonly string[] = API_OPEN) =>
  layoutInput(index, buildView(index, expanded));

type Message = { id: number; cmd: string; graph?: unknown; layoutOptions?: object };
type Listener = (event: Event) => void;

/**
 * A stand-in for the layout worker: answers ELK's worker messages with the
 * bundled ELK, after a structured clone each way as `postMessage` does.
 * `crash()` fires an error event as a worker that failed to load would.
 */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly received: Message[] = [];
  terminated = false;
  /** Answer nothing (a worker still loading, or hung). */
  silent = false;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(data: unknown) {
    const message = structuredClone(data) as Message;
    this.received.push(message);
    if (this.silent) return;
    setTimeout(() => void this.answer(message), 0);
  }

  terminate() {
    this.terminated = true;
  }

  crash(type = "error", message = "Failed to load worker script") {
    const event = Object.assign(new Event(type, { cancelable: true }), { message });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  private async answer(message: Message) {
    if (this.terminated) return;
    const reply = (data: object) => this.onmessage?.({ data: structuredClone(data) });
    if (message.cmd !== "layout") return reply({ id: message.id });
    try {
      const graph = await elk.layout(message.graph as Parameters<typeof elk.layout>[0], {
        layoutOptions: message.layoutOptions as Record<string, string>,
      });
      reply({ id: message.id, data: graph });
    } catch (error) {
      reply({ id: message.id, error: String(error) });
    }
  }
}

const asWorker = (fake: FakeWorker) => fake as unknown as Worker;
const layouts = (fake: FakeWorker) => fake.received.filter((m) => m.cmd === "layout");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLayoutEngine", () => {
  it("lays out on the main thread without a worker, loading ELK once on first use", async () => {
    const loadElk = vi.fn(() => Promise.resolve(new ELK()));
    const engine = createLayoutEngine({ loadElk });
    expect(engine.runsIn).toBe("main");
    expect(loadElk).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([engine.layout(input()), engine.layout(input([]))]);
    expect(a).toEqual(await runLayout(elk, input()));
    expect(b).toEqual(await runLayout(elk, input([])));
    expect(loadElk).toHaveBeenCalledTimes(1);
  });

  it("defaults to elkjs's bundled build on the main thread", async () => {
    expect(await createLayoutEngine().layout(input())).toEqual(await runLayout(elk, input()));
  });

  it("lays out in the worker, with the same result, and never loads ELK in the thread", async () => {
    const fake = new FakeWorker();
    const loadElk = vi.fn(() => Promise.resolve(new ELK()));
    const engine = createLayoutEngine({ worker: () => asWorker(fake), loadElk });
    expect(engine.runsIn).toBe("worker");
    const result = await engine.layout(input());
    expect(result).toEqual(await runLayout(elk, input()));
    expect(fake.received.map((m) => m.cmd)).toEqual(["register", "layout"]);
    expect(loadElk).not.toHaveBeenCalled();
    expect(engine.runsIn).toBe("worker");
  });

  it("falls back to the main thread for good when the worker fails, finishing what was pending", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = new FakeWorker();
    fake.silent = true;
    const engine = createLayoutEngine({ worker: () => asWorker(fake) });
    const pending = engine.layout(input());
    const event = fake.crash();
    expect(event.defaultPrevented, "handled, not reported as uncaught").toBe(true);
    expect(await pending).toEqual(await runLayout(elk, input()));
    expect(engine.runsIn).toBe("main");
    expect(fake.terminated).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to load worker script"));

    // Later layouts don't go near the worker.
    fake.silent = false;
    expect(await engine.layout(input([]))).toEqual(await runLayout(elk, input([])));
    expect(layouts(fake)).toHaveLength(1);
  });

  it("treats a message the worker can't deliver as a failure too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = new FakeWorker();
    fake.silent = true;
    const engine = createLayoutEngine({ worker: () => asWorker(fake) });
    const pending = engine.layout(input());
    fake.crash("messageerror", "");
    expect(await pending).toEqual(await runLayout(elk, input()));
    expect(engine.runsIn).toBe("main");
  });

  it("runs on the main thread when the worker can't be made", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = createLayoutEngine({
      worker: () => {
        throw new Error("Worker is not defined");
      },
    });
    expect(engine.runsIn).toBe("main");
    expect(await engine.layout(input())).toEqual(await runLayout(elk, input()));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects on ELK's own errors without leaving the worker", async () => {
    const broken: LayoutInput = {
      nodes: [{ id: "a", parent: null, width: 10, height: 10 }],
      edges: [{ id: "e", from: "a", to: "missing", label: { width: 10, height: 22 } }],
    };
    const fake = new FakeWorker();
    const engine = createLayoutEngine({ worker: () => asWorker(fake) });
    await expect(engine.layout(broken)).rejects.toBeDefined();
    expect(engine.runsIn).toBe("worker");
    expect(await engine.layout(input())).toEqual(await runLayout(elk, input()));

    await expect(createLayoutEngine().layout(broken)).rejects.toBeDefined();
  });

  it("stops the worker on dispose, rejecting what was pending", async () => {
    const fake = new FakeWorker();
    fake.silent = true;
    const engine = createLayoutEngine({ worker: () => asWorker(fake) });
    const pending = engine.layout(input());
    engine.dispose();
    await expect(pending).rejects.toThrow("The layout engine was disposed");
    expect(fake.terminated).toBe(true);
    expect(engine.runsIn).toBe("main");
    engine.dispose(); // twice is fine
  });
});

/** An engine that counts its layouts and can be told to fail the next one. */
function countingEngine() {
  const engine = createLayoutEngine({ loadElk: () => Promise.resolve(elk) });
  const counter = {
    calls: [] as LayoutInput[],
    failNext: false,
    layout(i: LayoutInput): Promise<LayoutResult> {
      counter.calls.push(i);
      if (counter.failNext) {
        counter.failNext = false;
        return Promise.reject(new Error("layout failed"));
      }
      return engine.layout(i);
    },
  } satisfies Pick<LayoutEngine, "layout"> & Record<string, unknown>;
  return counter;
}

describe("createLayoutCache", () => {
  it("keys a view by its open nodes and hidden kinds", () => {
    expect(layoutKey(buildView(index, API_OPEN))).toBe('[["service:api/"],["imports"]]');
    // Asked open inside a closed node: the same state as nothing open.
    expect(layoutKey(buildView(index, ["module:api/src"]))).toBe(layoutKey(buildView(index, [])));
    expect(layoutKey(buildView(index, [], { hiddenKinds: new Set() }))).not.toBe(
      layoutKey(buildView(index, [])),
    );
  });

  it("lays out each expansion state once, and shares a run still going", async () => {
    const engine = countingEngine();
    const cache = createLayoutCache(index, engine);
    const view = buildView(index, API_OPEN);
    expect(cache.peek(view)).toBeUndefined();
    const [a, b] = await Promise.all([cache.layout(view), cache.layout(view)]);
    expect(a).toBe(b);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toEqual(layoutInput(index, view));

    // A rebuilt view of the same state, and a request that leaves the same nodes open.
    expect(await cache.layout(buildView(index, API_OPEN))).toBe(a);
    expect(cache.peek(buildView(index, [...API_OPEN, "file:web/app/page.tsx"]))).toBe(a);
    expect(engine.calls).toHaveLength(1);

    // Other states and other hidden kinds are laid out on their own.
    await cache.layout(buildView(index, []));
    await cache.layout(buildView(index, [], { hiddenKinds: new Set() }));
    expect(engine.calls).toHaveLength(3);
    expect(cache.size).toBe(3);
  });

  it("doesn't keep a failed layout", async () => {
    const engine = countingEngine();
    const cache = createLayoutCache(index, engine);
    const view = buildView(index, API_OPEN);
    engine.failNext = true;
    await expect(cache.layout(view)).rejects.toThrow("layout failed");
    expect(cache.size).toBe(0);
    expect(await cache.layout(view)).toEqual(await runLayout(elk, layoutInput(index, view)));
    expect(engine.calls).toHaveLength(2);
  });

  it("drops the least recently used state past its limit", async () => {
    const engine = countingEngine();
    const cache = createLayoutCache(index, engine, 2);
    const none = buildView(index, []);
    const api = buildView(index, API_OPEN);
    const web = buildView(index, ["service:web/"]);
    await cache.layout(none);
    await cache.layout(api);
    await cache.layout(none); // used again: api is now the oldest
    await cache.layout(web);
    expect(cache.size).toBe(2);
    expect(cache.peek(none)).toBeDefined();
    expect(cache.peek(web)).toBeDefined();
    expect(cache.peek(api)).toBeUndefined();
    expect(engine.calls).toHaveLength(3);
    expect(LAYOUT_CACHE_SIZE).toBeGreaterThanOrEqual(16);
  });
});
