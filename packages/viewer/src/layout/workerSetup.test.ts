// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// A worker's global, as far as `workerSetup` touches it: no `window`, and
// `addEventListener`. Node's global has neither, so both are stubbed.

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function setUp() {
  const listeners = new Map<string, (event: unknown) => void>();
  vi.stubGlobal("addEventListener", (type: string, listener: (event: unknown) => void) => {
    listeners.set(type, listener);
  });
  expect("window" in globalThis).toBe(false);
  await import("./workerSetup.js");
  return listeners;
}

describe("workerSetup", () => {
  it("names the worker's global `window`, for ELK under a bundler that folds `typeof window`", async () => {
    await setUp();
    expect((globalThis as { window?: unknown }).window).toBe(globalThis);
  });

  it("rethrows a rejected promise as an uncaught error, so the page hears the worker failed", async () => {
    const listeners = await setUp();
    const reason = new ReferenceError("window is not defined");
    expect(() => listeners.get("unhandledrejection")?.({ reason })).toThrow(reason);
  });

  it("leaves an existing `window` alone", async () => {
    const own = {};
    vi.stubGlobal("window", own);
    vi.stubGlobal("addEventListener", () => undefined);
    await import("./workerSetup.js");
    expect((globalThis as { window?: unknown }).window).toBe(own);
  });
});
