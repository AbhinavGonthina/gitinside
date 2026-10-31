import { describe, expect, it } from "vitest";
import { NO_FILTERS } from "../model/filters.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import {
  decodeState,
  DEFAULT_STATE,
  encodeState,
  withState,
  type ExplorerState,
} from "./deepLink.js";
import { traceFrom } from "./trace.js";

const index = buildHierarchy(shopDemo());
const API = "service:api/";
const SRC = "module:api/src";
const ROUTE = "route:api/POST /api/orders";
const CHECKOUT = "page:web//checkout";
const PLACE_ORDER = "symbol:web/lib/orders.ts#placeOrder";
const checkoutSteps = traceFrom(index, CHECKOUT).steps.length;

const state = (over: Partial<ExplorerState>): ExplorerState => ({ ...DEFAULT_STATE, ...over });

describe("encodeState", () => {
  it("writes nothing for the default state", () => {
    expect(encodeState(DEFAULT_STATE)).toBe("");
  });

  it("writes UX.md's example readably: `/`, `:`, and `@` kept, spaces escaped", () => {
    expect(
      encodeState(state({ open: [API, SRC], selected: ROUTE, trace: CHECKOUT, step: 0 })),
    ).toBe(
      "open=service:api/,module:api/src&sel=route:api/POST%20/api/orders&trace=page:web//checkout",
    );
  });

  it("escapes what would break the query: `,` `&` `=` `#` `+` `%`", () => {
    const odd = "symbol:web/a,b&c=d.ts#x+y%";
    expect(encodeState(state({ selected: odd }))).toBe(
      "sel=symbol:web/a%2Cb%26c%3Dd.ts%23x%2By%25",
    );
    expect(decodeState(encodeState(state({ selected: odd })), index).ignored).toEqual([
      { param: "sel", value: odd },
    ]);
  });

  it("writes the step 1-based, and not on the first step or without a trace", () => {
    expect(encodeState(state({ trace: CHECKOUT, step: 2 }))).toBe(
      "trace=page:web//checkout&step=3",
    );
    expect(encodeState(state({ trace: CHECKOUT, step: 0 }))).toBe("trace=page:web//checkout");
    expect(encodeState(state({ step: 2 }))).toBe("");
  });

  it("writes filters in canonical form, whatever order they were set in", () => {
    const a = encodeState(
      state({
        filters: {
          layers: ["external", "data"],
          kinds: ["symbol", "model", "symbol"],
          confidence: ["heuristic"],
          include: ["./apps/web/"],
          exclude: ["apps/api/src", "apps/api/src"],
          hideTestsAndConfig: false,
        },
        hiddenKinds: ["imports", "calls"],
      }),
    );
    expect(a).toBe(
      "hideLayers=data,external&hideKinds=model,symbol&hideConfidence=heuristic" +
        "&hideLines=calls,imports&only=apps/web&hideFolders=apps/api/src&tests=shown",
    );
    const b = encodeState(
      state({
        filters: {
          layers: ["data", "external"],
          kinds: ["model", "symbol"],
          confidence: ["heuristic"],
          include: ["apps/web"],
          exclude: ["apps/api/src"],
          hideTestsAndConfig: false,
        },
        hiddenKinds: ["calls", "imports"],
      }),
    );
    expect(b).toBe(a);
  });

  it("writes an empty `hideLines` when every connection kind is shown", () => {
    expect(encodeState(state({ hiddenKinds: [] }))).toBe("hideLines=");
    expect(decodeState("hideLines=", index).state.hiddenKinds).toEqual([]);
  });
});

describe("decodeState", () => {
  it("reads an empty query (with or without `?`) as the default state", () => {
    expect(decodeState("", index)).toEqual({ state: DEFAULT_STATE, ignored: [] });
    expect(decodeState("?", index)).toEqual({ state: DEFAULT_STATE, ignored: [] });
  });

  it("round-trips a full state", () => {
    const full = state({
      open: [API, SRC],
      selected: PLACE_ORDER,
      trace: CHECKOUT,
      step: checkoutSteps - 1,
      filters: {
        layers: ["external"],
        kinds: ["model"],
        confidence: ["heuristic"],
        include: [],
        exclude: ["apps/web/lib"],
        hideTestsAndConfig: false,
      },
      hiddenKinds: ["calls"],
    });
    expect(decodeState(`?${encodeState(full)}`, index)).toEqual({ state: full, ignored: [] });
  });

  it("keeps the opening order and drops repeats", () => {
    expect(decodeState(`open=${SRC},${API},${SRC}`, index).state.open).toEqual([SRC, API]);
  });

  it("reads `+` as a space and percent escapes anywhere", () => {
    const { state: s } = decodeState("sel=route%3Aapi%2FPOST+%2Fapi%2Forders", index);
    expect(s.selected).toBe(ROUTE);
  });

  it("leaves out nodes the graph doesn't have, or that can't do what the link asks, and lists them", () => {
    const { state: s, ignored } = decodeState(
      `open=${API},service:gone/,${PLACE_ORDER}&sel=${index.root.id}&trace=${API}`,
      index,
    );
    expect(s.open).toEqual([API]);
    expect(s.selected).toBeNull();
    expect(s.trace).toBeNull();
    expect(s.step).toBeNull();
    expect(ignored).toEqual([
      { param: "open", value: "service:gone/" },
      { param: "open", value: PLACE_ORDER },
      { param: "sel", value: index.root.id },
      { param: "trace", value: API },
    ]);
  });

  it("starts a linked trace at its first step, and refuses a step it doesn't have", () => {
    expect(decodeState(`trace=${CHECKOUT}`, index).state.step).toBe(0);
    expect(decodeState(`trace=${CHECKOUT}&step=2`, index).state.step).toBe(1);
    for (const bad of ["0", "-1", "1.5", "x", String(checkoutSteps + 1)]) {
      const { state: s, ignored } = decodeState(`trace=${CHECKOUT}&step=${bad}`, index);
      expect(s.step).toBe(0);
      expect(ignored).toEqual([{ param: "step", value: bad }]);
    }
    // A step without a trace has nothing to step through.
    expect(decodeState("step=2", index)).toEqual({
      state: DEFAULT_STATE,
      ignored: [{ param: "step", value: "2" }],
    });
  });

  it("refuses a second value where one is expected", () => {
    const { state: s, ignored } = decodeState(`sel=${API},${SRC}`, index);
    expect(s.selected).toBeNull();
    expect(ignored).toEqual([{ param: "sel", value: `${API},${SRC}` }]);
  });

  it("keeps known filter values and folders the repo has, and lists the rest", () => {
    const { state: s, ignored } = decodeState(
      "hideLayers=data,space&hideKinds=symbol,service&hideConfidence=exact,sure" +
        "&hideLines=imports,teleports&only=./apps/web/,apps/nope&hideFolders=apps/api/src&tests=hidden",
      index,
    );
    expect(s.filters).toEqual({
      ...NO_FILTERS,
      layers: ["data"],
      kinds: ["symbol"],
      confidence: ["exact"],
      include: ["apps/web"],
      exclude: ["apps/api/src"],
      hideTestsAndConfig: true,
    });
    expect(s.hiddenKinds).toEqual(["imports"]);
    expect(ignored).toEqual([
      { param: "hideLayers", value: "space" },
      { param: "hideKinds", value: "service" },
      { param: "hideConfidence", value: "sure" },
      { param: "hideLines", value: "teleports" },
      { param: "only", value: "apps/nope" },
      { param: "tests", value: "hidden" },
    ]);
  });

  it("notes a malformed escape and reads the rest", () => {
    const { state: s, ignored } = decodeState(`sel=%E0%A4%A&open=${API}`, index);
    expect(s).toEqual(state({ open: [API] }));
    expect(ignored).toEqual([{ param: "sel", value: "(malformed)" }]);
  });

  it("skips parameters it doesn't know without a note, and the last of a repeated one wins", () => {
    expect(decodeState(`utm_source=x&sel=${API}&sel=${SRC}`, index)).toEqual({
      state: state({ selected: SRC }),
      ignored: [],
    });
  });
});

describe("withState", () => {
  it("adds a state's query to a page, and nothing for the default state", () => {
    expect(withState("/acme/shop", "sel=service:api/")).toBe("/acme/shop?sel=service:api/");
    expect(withState("/acme/shop", encodeState(DEFAULT_STATE))).toBe("/acme/shop");
  });
});
