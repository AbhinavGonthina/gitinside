import ELK from "elkjs/lib/elk.bundled.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutInput, runLayout } from "../layout/elk.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import {
  exportName,
  MAX_CANVAS_AREA,
  MAX_CANVAS_SIDE,
  PNG_SCALE,
  pngScale,
  saveFile,
  svgToPng,
  viewExport,
} from "./files.js";
import { viewMermaid } from "./mermaid.js";
import { renderViewSvg } from "./svg.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Stubs `URL.createObjectURL` / `revokeObjectURL` (jsdom has neither), handing out `blob:<n>`. */
function stubBlobUrls() {
  const blobs: Blob[] = [];
  const create = vi.fn((blob: Blob) => `blob:${blobs.push(blob)}`);
  const revoke = vi.fn<(url: string) => void>();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  return { blobs, create, revoke };
}

describe("exportName", () => {
  it("names a file after the repo and the commit's first 7 characters", () => {
    expect(exportName({ owner: "acme", name: "shop", sha: "a1b2c3d4e5f6" })).toBe(
      "acme-shop-a1b2c3d",
    );
    expect(exportName({ owner: "acme", name: "shop.js" })).toBe("acme-shop.js");
  });

  it("can't add a folder, an extension, or a hidden file from the repo's name", () => {
    expect(exportName({ owner: "..", name: "../../etc/passwd" })).toBe("etc-passwd");
    expect(exportName({ owner: "a b", name: 'x"<y>\nz' })).toBe("a-b-x-y-z");
    expect(exportName({ owner: "...", name: "///" })).toBe("gitinside");
  });
});

describe("pngScale", () => {
  it("draws at 2× unless that passes a browser's canvas limits", () => {
    expect(pngScale(1200, 800)).toBe(PNG_SCALE);
    // One long side: held to the widest canvas.
    expect(pngScale(12_000, 400)).toBeCloseTo(MAX_CANVAS_SIDE / 12_000);
    // Big both ways: held to Safari's area.
    const area = pngScale(4000, 4000);
    expect(area).toBeCloseTo(Math.sqrt(MAX_CANVAS_AREA) / 4000);
    expect(4000 * area * (4000 * area)).toBeLessThanOrEqual(MAX_CANVAS_AREA + 1);
    expect(pngScale(0, 0)).toBe(PNG_SCALE);
  });
});

describe("viewExport", () => {
  it("renders the view at the layout it was drawn at, in either theme, only when asked", async () => {
    const graph = shopDemo();
    const index = buildHierarchy(graph);
    const view = buildView(index, ["service:api/"]);
    const layout = await runLayout(new ELK(), layoutInput(index, view));
    const exported = viewExport(index, { view, layout });
    expect(exported.name).toBe("fixtures-shop-demo");
    expect(exported.svg("dark")).toBe(renderViewSvg(index, view, layout, { theme: "dark" }));
    expect(exported.svg("light")).toBe(renderViewSvg(index, view, layout, { theme: "light" }));
    expect(exported.svg("light")).not.toBe(exported.svg("dark"));
    expect(exported.mermaid()).toBe(viewMermaid(index, view));
  });
});

describe("saveFile", () => {
  it("clicks a hidden download link to a blob URL, removes it, and revokes the URL later", () => {
    vi.useFakeTimers();
    const { blobs, revoke } = stubBlobUrls();
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true);
      clicked.push(this);
    });
    const blob = new Blob(["flowchart LR"], { type: "text/plain" });
    saveFile("acme-shop.mmd", blob);
    expect(blobs).toEqual([blob]);
    expect(clicked).toHaveLength(1);
    const [link] = clicked;
    expect(link?.download).toBe("acme-shop.mmd");
    expect(link?.getAttribute("href")).toBe("blob:1");
    expect(link?.hidden).toBe(true);
    expect(link?.isConnected).toBe(false);
    // Revoking at once can cancel the download; a minute later it's long started.
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });
});

describe("svgToPng", () => {
  /** A browser's image and canvas, as far as `svgToPng` uses them. */
  function stubBrowser(size: { width: number; height: number }, png: Blob | null) {
    const urls = stubBlobUrls();
    const loaded: string[] = [];
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        naturalWidth = size.width;
        naturalHeight = size.height;
        decode() {
          loaded.push(this.src);
          return Promise.resolve();
        }
      },
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
    );
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      done: BlobCallback,
      type?: string,
    ) {
      expect(type).toBe("image/png");
      canvases.push(this);
      done(png);
    });
    return { ...urls, loaded, drawImage, canvases };
  }

  it("draws the SVG image onto a canvas at 2× and encodes it as PNG", async () => {
    const out = new Blob(["png"], { type: "image/png" });
    const { blobs, loaded, drawImage, canvases, revoke } = stubBrowser(
      { width: 600, height: 300 },
      out,
    );
    const png = await svgToPng("<svg/>");
    expect(png).toEqual({ blob: out, scale: 2 });
    expect(blobs[0]?.type).toBe("image/svg+xml");
    expect(loaded).toEqual(["blob:1"]);
    expect([canvases[0]?.width, canvases[0]?.height]).toEqual([1200, 600]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1200, 600);
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("draws a view too large for 2× smaller, and fails (revoking the URL) when no PNG comes out", async () => {
    const { canvases, revoke } = stubBrowser({ width: 10_000, height: 500 }, new Blob(["png"]));
    expect((await svgToPng("<svg/>")).scale).toBeCloseTo(MAX_CANVAS_SIDE / 10_000);
    expect(canvases[0]?.width).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(revoke).toHaveBeenCalledWith("blob:1");

    vi.restoreAllMocks();
    const failing = stubBrowser({ width: 600, height: 300 }, null);
    await expect(svgToPng("<svg/>")).rejects.toThrow("no PNG");
    expect(failing.revoke).toHaveBeenCalledWith("blob:1");
  });
});
