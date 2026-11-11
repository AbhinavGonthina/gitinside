// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_HREF } from "./docs";

/**
 * The root `SECURITY.md` (M9.4b), the file GitHub shows on the repo's Security tab: it must
 * send reports through GitHub's private vulnerability reporting (never a public issue), say
 * what's in scope and what happens next, and be the file docs/SECURITY.md §5 points to.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** GitHub's form for a new private report on this repo. */
const REPORT_FORM = `${REPO_HREF}/security/advisories/new`;

describe("the root SECURITY.md", () => {
  const policy = text("SECURITY.md");

  it("sends reports to GitHub's private vulnerability reporting form", () => {
    expect(policy).toContain(REPORT_FORM);
  });

  it("asks for no public issue with the details", () => {
    expect(policy).toMatch(/don't open a public issue/i);
  });

  it.each(["## In scope", "## Out of scope", "## How to report", "## What happens next"])(
    "has a %s section",
    (heading) => {
      expect(policy.split(/\r?\n/)).toContain(heading);
    },
  );

  it("names no email address", () => {
    expect(policy).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});

describe("docs/SECURITY.md §5", () => {
  it("links the root SECURITY.md and no longer says it's still to come", () => {
    const section = text("docs/SECURITY.md").split("## 5. Reporting")[1] ?? "";
    expect(section).toContain("(../SECURITY.md)");
    expect(section).not.toMatch(/Until then|added in M9/);
  });
});
