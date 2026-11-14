import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import shopDemo from "../../../../fixtures/shop-demo/expected.json";
import { findPrototypeRepo } from "../../lib/prototype";
import { PrototypeHero } from "./PrototypeHero";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("times the hero", async () => {
  const t0 = performance.now();
  const log = (what: string) => console.log(`ALONE ${Math.round(performance.now() - t0)} ${what}`);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(shopDemo)));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly report: ResizeObserverCallback) {}
      observe() {
        this.report(
          [{ contentRect: { width: 720, height: 480 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
  const maxun = findPrototypeRepo("getmaxun", "maxun");
  if (!maxun) throw new Error("no maxun");
  const { container } = render(<PrototypeHero repo={maxun} />);
  const open = screen.getByRole("link", { name: "Open the full diagram" });
  const root = () => container.querySelector<HTMLElement>(".gi-explorer");
  const seen = new Set<string>();
  const observer = new MutationObserver(() => {
    const r = root();
    const marks = [
      ["explorer", r !== null],
      ["layout=" + (r?.querySelector("[data-layout]")?.getAttribute("data-layout") ?? ""), true],
      ["settled", r?.hasAttribute("data-settled") ?? false],
      ["href=" + open.getAttribute("href"), true],
    ] as const;
    for (const [name, on] of marks) {
      if (on && !seen.has(name)) {
        seen.add(name);
        log(name);
      }
    }
  });
  observer.observe(container, { subtree: true, attributes: true, childList: true });
  await waitFor(() => expect(open.getAttribute("href")).toMatch(/&(.+&)?trace=page/), {
    timeout: 25_000,
  });
  log("done");
  observer.disconnect();
}, 30_000);
