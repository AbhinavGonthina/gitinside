// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { DEMO_PINS } from "@gitinside/db";
import { parseGraph } from "@gitinside/schema";
import { renderDiagram } from "@gitinside/viewer/image";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_CSP } from "./csp";
import {
  findPrototypeRepo,
  HERO_REPO,
  PROTOTYPE_GRAPH_ORIGIN,
  PROTOTYPE_REPOS,
  prototypeGraphUrl,
  prototypeHref,
  prototypeRepoParam,
  TOUR_REPO,
  upstreamGraphUrl,
} from "./prototype";
import {
  handlePrototypeGraph,
  PROTOTYPE_GRAPH_CACHE_CONTROL,
  type UpstreamGet,
} from "./prototypeGraph";
import {
  GALLERY_COLUMNS_FROM,
  GALLERY_CROP,
  GALLERY_THUMB_HEIGHT,
  handlePrototypeImage,
  prototypeImageUrl,
} from "./prototypeImage";

const GRAPH = JSON.stringify({ schemaVersion: 1, nodes: [] });

const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** A production that answers `status` with the graph, gzipped unless told otherwise. */
const upstream = (status = 200, gzip = true): UpstreamGet & ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({
    status,
    encoding: gzip ? "gzip" : undefined,
    body: stream(gzip ? gzipSync(GRAPH) : new TextEncoder().encode(GRAPH)),
  }));

describe("the prototype's repos (M10.3a)", () => {
  it("are M10.1's five, the demo pins at their pinned commits", () => {
    expect(PROTOTYPE_REPOS.map((r) => `${r.owner}/${r.name}`)).toEqual([
      "krishnaacharyaa/wanderlust",
      "documenso/documenso",
      "Mintplex-Labs/anything-llm",
      "shadcn-ui/taxonomy",
      "getmaxun/maxun",
    ]);
    for (const pin of DEMO_PINS) {
      expect(findPrototypeRepo(pin.owner, pin.name)?.sha).toBe(pin.sha);
    }
    for (const r of PROTOTYPE_REPOS) expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("are found by `owner/name` in any case, and nothing else is", () => {
    expect(prototypeRepoParam("GETMAXUN/Maxun")?.name).toBe("maxun");
    for (const value of [undefined, ["getmaxun/maxun"], "getmaxun", "getmaxun/maxun/x", "a/b"]) {
      expect(prototypeRepoParam(value)).toBeUndefined();
    }
    expect(findPrototypeRepo("getmaxun", undefined)).toBeUndefined();
  });

  it("lead the landing with hand-checked pins: the hero and the tour (M10.3e1)", () => {
    const pins = DEMO_PINS.map((p) => `${p.owner}/${p.name}`);
    expect(pins).toContain(`${HERO_REPO.owner}/${HERO_REPO.name}`);
    expect(pins).toContain(`${TOUR_REPO.owner}/${TOUR_REPO.name}`);
    expect(TOUR_REPO.name).toBe("anything-llm");
  });

  it("link the page, the proxy, and production's graph", () => {
    const maxun = findPrototypeRepo("getmaxun", "maxun");
    if (!maxun) throw new Error("no maxun");
    expect(prototypeHref(maxun)).toBe("/prototype?repo=getmaxun/maxun");
    // An explorer state goes after `repo=`, with or without its `?`.
    expect(prototypeHref(maxun, "?trace=page%3Ax&step=2")).toBe(
      "/prototype?repo=getmaxun/maxun&trace=page%3Ax&step=2",
    );
    expect(prototypeHref(maxun, "trace=x")).toBe("/prototype?repo=getmaxun/maxun&trace=x");
    expect(prototypeGraphUrl(maxun)).toBe("/api/prototype/graph/getmaxun/maxun");
    expect(upstreamGraphUrl(maxun)).toBe(
      `${PROTOTYPE_GRAPH_ORIGIN}/api/graph/getmaxun/maxun/${maxun.sha}`,
    );
    expect(PROTOTYPE_GRAPH_ORIGIN).toBe("https://gitinside.abhinavgonthina.dev");
  });
});

describe("handlePrototypeImage (M10.3e2a)", () => {
  const GRAPH_JSON = readFileSync(
    fileURLToPath(new URL("../../../fixtures/shop-demo/expected.json", import.meta.url)),
    "utf8",
  );
  const production = (status = 200): UpstreamGet & ReturnType<typeof vi.fn> =>
    vi.fn(async () => ({ status, encoding: "gzip", body: stream(gzipSync(GRAPH_JSON)) }));

  it("refuses a repo the prototype doesn't draw before fetching anything", async () => {
    const get = production();
    const response = await handlePrototypeImage({ owner: "evil", repo: "x" }, "dark", get);
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("draws the README image's crop around the hub from production's graph, in the theme asked", async () => {
    const get = production();
    const response = await handlePrototypeImage({ owner: "getmaxun", repo: "maxun" }, "light", get);
    const maxun = findPrototypeRepo("getmaxun", "maxun");
    if (!maxun) throw new Error("no maxun");
    expect(get).toHaveBeenCalledWith(upstreamGraphUrl(maxun));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(PROTOTYPE_GRAPH_CACHE_CONTROL);
    expect(response.headers.get("content-security-policy")).toBe(IMAGE_CSP);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const graph = parseGraph(JSON.parse(GRAPH_JSON));
    expect(await response.text()).toBe(
      renderDiagram(graph, { theme: "light", crop: GALLERY_CROP }),
    );
    // A theme it doesn't know follows the reader's.
    const auto = await handlePrototypeImage(
      { owner: "getmaxun", repo: "maxun" },
      "x",
      production(),
    );
    expect(await auto.text()).toBe(renderDiagram(graph, { theme: "auto", crop: GALLERY_CROP }));
  });

  it("covers every thumbnail with room for the hover's pan, the focus inside the narrowest", () => {
    expect(GALLERY_CROP.height - GALLERY_THUMB_HEIGHT).toBeGreaterThanOrEqual(8);
    // One card per row: the landing's 24px padding each side, just under three columns.
    expect(GALLERY_CROP.width).toBeGreaterThanOrEqual(GALLERY_COLUMNS_FROM - 1 - 48 + 8);
    // Three columns at their narrowest: the padding, two 24px gaps, and each card's border.
    const narrowest = (GALLERY_COLUMNS_FROM - 48 - 48) / 3 - 2;
    expect(GALLERY_CROP.focus).toBeLessThanOrEqual(narrowest - 2 * 4);
    const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
    // Asserted as booleans, so a failure names the rule rather than printing the whole sheet.
    const breakpoint = `@media (max-width: ${GALLERY_COLUMNS_FROM - 1}px)`;
    expect(css.includes(breakpoint), breakpoint).toBe(true);
    const thumb = new RegExp(`\\.demo__thumb \\{[^}]*height: ${GALLERY_THUMB_HEIGHT}px`);
    expect(thumb.test(css), String(thumb)).toBe(true);
  });

  it("answers 502, never cached, when production fails, can't be reached, or sends no graph", async () => {
    const params = { owner: "getmaxun", repo: "maxun" };
    const failed = await handlePrototypeImage(params, "dark", production(404));
    expect(failed.status).toBe(502);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    const down = await handlePrototypeImage(params, "dark", () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    expect(down.status).toBe(502);
    const invalid = await handlePrototypeImage(params, "dark", upstream());
    expect(invalid.status).toBe(502);
  });

  it("links each repo's image by theme", () => {
    const maxun = findPrototypeRepo("getmaxun", "maxun");
    if (!maxun) throw new Error("no maxun");
    expect(prototypeImageUrl(maxun, "dark")).toBe(
      "/api/prototype/diagram/getmaxun/maxun?theme=dark",
    );
  });
});

describe("handlePrototypeGraph", () => {
  it("refuses a repo the prototype doesn't draw before fetching anything", async () => {
    const get = upstream();
    const response = await handlePrototypeGraph({ owner: "evil", repo: "x" }, "gzip", get);
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("passes production's gzip on to a client that takes it, cached a day on the CDN", async () => {
    const get = upstream();
    const response = await handlePrototypeGraph(
      { owner: "documenso", repo: "documenso" },
      "gzip, br",
      get,
    );
    expect(get).toHaveBeenCalledWith(
      `${PROTOTYPE_GRAPH_ORIGIN}/api/graph/documenso/documenso/1e2333d534e151578ffb05394428e2a7efea5f50`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("cache-control")).toBe(PROTOTYPE_GRAPH_CACHE_CONTROL);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(bytes).equals(gzipSync(GRAPH))).toBe(true);
  });

  it("decompresses for a client that refuses gzip, and passes an identity body as it is", async () => {
    const refused = await handlePrototypeGraph(
      { owner: "getmaxun", repo: "maxun" },
      "gzip;q=0",
      upstream(),
    );
    expect(refused.headers.get("content-encoding")).toBeNull();
    expect(await refused.text()).toBe(GRAPH);
    const plain = await handlePrototypeGraph(
      { owner: "getmaxun", repo: "maxun" },
      "gzip",
      upstream(200, false),
    );
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(GRAPH);
  });

  it("answers 502 when production fails or can't be reached, never cached", async () => {
    const failed = await handlePrototypeGraph(
      { owner: "getmaxun", repo: "maxun" },
      "gzip",
      upstream(404),
    );
    expect(failed.status).toBe(502);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(((await failed.json()) as { message: string }).message).toContain("404");
    const down = await handlePrototypeGraph({ owner: "getmaxun", repo: "maxun" }, "gzip", () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    expect(down.status).toBe(502);
  });
});
