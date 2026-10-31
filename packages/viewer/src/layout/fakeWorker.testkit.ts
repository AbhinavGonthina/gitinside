import ELK from "elkjs/lib/elk.bundled.js";

const elk = new ELK();

/** A message ELK's API sends its worker. */
export type WorkerMessage = { id: number; cmd: string; graph?: unknown; layoutOptions?: object };
type Listener = (event: Event) => void;

/**
 * A stand-in for the layout worker: answers ELK's worker messages with the
 * bundled ELK, after a structured clone each way as `postMessage` does.
 * `crash()` fires an error event as a worker that failed to load would.
 */
export class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly received: WorkerMessage[] = [];
  terminated = false;
  /** Answer nothing (a worker still loading, or hung). */
  silent = false;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(data: unknown) {
    const message = structuredClone(data) as WorkerMessage;
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

  private async answer(message: WorkerMessage) {
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

/** A fake as the `Worker` the engine's factory returns. */
export const asWorker = (fake: FakeWorker) => fake as unknown as Worker;

/** The layouts a fake was asked for. */
export const layouts = (fake: FakeWorker) => fake.received.filter((m) => m.cmd === "layout");
