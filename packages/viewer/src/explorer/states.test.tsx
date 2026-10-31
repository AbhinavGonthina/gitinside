import type { ArchitectureGraph } from "@gitinside/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { shopDemo } from "../shopDemo.testkit.js";
import { Explorer } from "./Explorer.js";

// Empty and error states in the explorer (M4b.12b): a repo with no app to
// draw, and the analysis's warnings on a diagram.

afterEach(cleanup);

const demo = shopDemo();

const WARNINGS = [
  { code: "SYNTAX_ERROR", message: "';' expected", file: "apps/web/lib/broken.ts" },
  { code: "SKIPPED_LARGE", message: "file is 3145728 bytes; skipped", file: "data/dump.json" },
];

/** The demo with warnings. */
const warned: ArchitectureGraph = { ...demo, warnings: WARNINGS };

/** What the analyzer gives a repo of only docs and a compose file: services, a datastore, no source files. */
const noApp: ArchitectureGraph = {
  ...demo,
  nodes: demo.nodes.filter((n) => ["system", "service", "datastore"].includes(n.kind)),
  edges: [],
  warnings: [{ code: "SKIPPED_SYMLINK", message: "symbolic link not followed", file: "docs/link" }],
};

async function settle() {
  await waitFor(
    () => expect(document.querySelector(".gi-drill")?.getAttribute("data-layout")).toBe("done"),
    { timeout: 10_000 },
  );
}

describe("Explorer states", { timeout: 30_000 }, () => {
  it("says there's no TypeScript or JavaScript app, with UX.md's words, instead of a diagram", () => {
    const { container } = render(<Explorer graph={noApp} />);
    const region = screen.getByRole("region", { name: "Diagram" });
    expect(
      within(region).getByRole("heading", {
        name: "We couldn't find a TypeScript or JavaScript app here",
      }),
    ).toBeTruthy();
    expect(
      within(region).getByText("GitInside supports React, Next.js, Express, and Prisma in v1."),
    ).toBeTruthy();
    // Nothing to draw, search, filter, share, or trace; the repo is still named.
    expect(container.querySelector(".gi-drill")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("button", { name: /Trace/ })).toBeNull();
    expect(container.querySelector(".gi-search-field")).toBeNull();
    expect(container.querySelector(".gi-repo__name")?.textContent).toContain("shop-demo");
  });

  it("lists what the analysis skipped on the no-app card", () => {
    render(<Explorer graph={noApp} />);
    const skipped = screen.getByRole("region", { name: "Warnings" });
    expect(within(skipped).getByText("Symbolic links, not followed")).toBeTruthy();
    expect(within(skipped).getByText("docs/link")).toBeTruthy();
    expect(within(skipped).getByText("symbolic link not followed")).toBeTruthy();
  });

  it("shows no warnings section when there are none", () => {
    render(<Explorer graph={{ ...noApp, warnings: [] }} topBar={false} />);
    expect(screen.queryByRole("region", { name: "Warnings" })).toBeNull();
    expect(screen.getByRole("heading", { name: /couldn't find/ })).toBeTruthy();
  });

  it("lists the warnings in the repo overview, grouped, with file and message", async () => {
    render(<Explorer graph={warned} />);
    await settle();
    const section = screen.getByRole("region", { name: /^Warnings/ });
    expect(within(section).getByText("Files that didn't parse")).toBeTruthy();
    expect(within(section).getByText("apps/web/lib/broken.ts")).toBeTruthy();
    expect(within(section).getByText("';' expected")).toBeTruthy();
    expect(within(section).getByText("Files over 2 MB, skipped")).toBeTruthy();
  });

  it("has no warnings chip or section on a graph without warnings", async () => {
    const { container } = render(<Explorer graph={demo} />);
    await settle();
    expect(container.querySelector(".gi-explorer__warnings")).toBeNull();
    expect(screen.queryByRole("region", { name: /^Warnings/ })).toBeNull();
  });

  it("goes to the warnings from the canvas's chip, clearing the selection, focus on them", async () => {
    const { container } = render(<Explorer graph={warned} initialSelected="service:api/" />);
    await settle();
    // A selection's inspector has no warnings section.
    expect(screen.queryByRole("region", { name: /^Warnings/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "2 warnings" }));
    const section = await screen.findByRole("region", { name: /^Warnings/ });
    expect(document.activeElement).toBe(section);
    // Clicked again with the overview already up, focus goes there too.
    (container.querySelector(".gi-explorer__warnings button") as HTMLElement).focus();
    fireEvent.click(screen.getByRole("button", { name: "2 warnings" }));
    expect(document.activeElement).toBe(section);
  });

  it("hides the chip while tracing, when the inspector shows the trace", async () => {
    render(<Explorer graph={warned} traceStart="page:web//checkout" initialStep={0} />);
    await settle();
    expect(screen.queryByRole("button", { name: "2 warnings" })).toBeNull();
  });

  it("shows a long group's first five, then all of them and fewer again", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      code: "SKIPPED_GENERATED",
      message: "generated file skipped (minified)",
      file: `vendor/lib${i}.min.js`,
    }));
    render(<Explorer graph={{ ...demo, warnings: many }} />);
    await settle();
    const section = screen.getByRole("region", { name: /^Warnings/ });
    expect(within(section).getAllByRole("listitem")).toHaveLength(5);
    const toggle = within(section).getByRole("button", { name: "Show all 7" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(within(section).getAllByRole("listitem")).toHaveLength(7);
    expect(toggle.textContent).toBe("Show fewer");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(within(section).getAllByRole("listitem")).toHaveLength(5);
  });
});
