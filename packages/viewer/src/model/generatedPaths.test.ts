// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  commonGeneratedPath,
  GENERATED_PATHS,
  GENERATED_PATHS_VERSION,
  generatedPathFor,
} from "./generatedPaths.js";

const shown = (expression: string) => generatedPathFor(expression)?.shown;

describe("generatedPathFor", () => {
  it("matches an entry's segments anywhere in the path, in a row", () => {
    expect(shown("./+types/root")).toBe("./+types/*");
    expect(shown("../+types/_index")).toBe("./+types/*");
    expect(shown("@documenso/prisma/generated/zod/modelSchema/UserSchema")).toBe(
      "prisma/generated/*",
    );
    expect(shown("../../../prisma/generated/types")).toBe("prisma/generated/*");
    expect(shown("contentlayer/generated")).toBe("contentlayer/generated");
    expect(shown("./server/node_modules/globals/index.js")).toBe("node_modules/*");
    expect(shown("../.next/types/app/page")).toBe(".next/*");
    expect(shown("./__generated__/graphql")).toBe("__generated__/*");
    expect(shown(".react-router/types/app/+types/root")).toBe("./+types/*");
  });

  it("matches whole segments only", () => {
    expect(shown("my+types/x")).toBeUndefined();
    expect(shown("./prisma/generator")).toBeUndefined();
    expect(shown("contentlayer/generated-x")).toBeUndefined();
    expect(shown("./next/config")).toBeUndefined();
    expect(shown("~/components/button")).toBeUndefined();
  });

  it("reads past a query or hash", () => {
    expect(shown("./+types/root?url")).toBe("./+types/*");
    expect(shown("./app.css?url")).toBeUndefined();
  });
});

describe("commonGeneratedPath", () => {
  it("names the entry most imports match when it's at least half", () => {
    const remix = [
      ...Array.from({ length: 5 }, (_, i) => `./+types/page${i}`),
      "@documenso/prisma/generated/types",
      "~/utils",
    ];
    expect(commonGeneratedPath(remix)).toEqual({
      path: GENERATED_PATHS[0],
      count: 5,
    });
    expect(commonGeneratedPath(["./+types/a", "./x"])?.count).toBe(1);
  });

  it("names nothing when under half match", () => {
    expect(commonGeneratedPath(["./+types/a", "./x", "./y"])).toBeUndefined();
    expect(commonGeneratedPath(["./x", "./y"])).toBeUndefined();
    expect(commonGeneratedPath([])).toBeUndefined();
  });

  it("breaks a tie by table order", () => {
    const tie = ["./node_modules/a", "./+types/b"];
    expect(commonGeneratedPath(tie)?.path.shown).toBe("./+types/*");
    expect(commonGeneratedPath([...tie].reverse())?.path.shown).toBe("./+types/*");
  });
});

describe("GENERATED_PATHS", () => {
  it("keeps notes short enough for a card's subtitle", () => {
    for (const g of GENERATED_PATHS) expect(g.note.length).toBeLessThanOrEqual(24);
  });

  it("is pinned to its version: bump GENERATED_PATHS_VERSION and this digest together", () => {
    const digest = createHash("sha256").update(JSON.stringify(GENERATED_PATHS)).digest("hex");
    expect({ version: GENERATED_PATHS_VERSION, digest: digest.slice(0, 16) }).toEqual({
      version: 1,
      digest: "40922e8995fe6547",
    });
  });
});
