// @vitest-environment node
import { gzipSync } from "node:zlib";
import { DEMO_PINS } from "@gitinside/db";
import { describe, expect, it, vi } from "vitest";
import {
  findPrototypeRepo,
  PROTOTYPE_GRAPH_ORIGIN,
  PROTOTYPE_REPOS,
  prototypeGraphUrl,
  prototypeHref,
  prototypeRepoParam,
  upstreamGraphUrl,
} from "./prototype";
import {
  handlePrototypeGraph,
  PROTOTYPE_GRAPH_CACHE_CONTROL,
  type UpstreamGet,
} from "./prototypeGraph";

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

  it("link the page, the proxy, and production's graph", () => {
    const maxun = findPrototypeRepo("getmaxun", "maxun");
    if (!maxun) throw new Error("no maxun");
    expect(prototypeHref(maxun)).toBe("/prototype?repo=getmaxun/maxun");
    expect(prototypeGraphUrl(maxun)).toBe("/api/prototype/graph/getmaxun/maxun");
    expect(upstreamGraphUrl(maxun)).toBe(
      `${PROTOTYPE_GRAPH_ORIGIN}/api/graph/getmaxun/maxun/${maxun.sha}`,
    );
    expect(PROTOTYPE_GRAPH_ORIGIN).toBe("https://gitinside.abhinavgonthina.dev");
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
