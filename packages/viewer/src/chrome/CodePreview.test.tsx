import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePreview } from "./Inspector.js";

// Shiki's chunks can fail to download (offline, a deploy swapping chunks).
vi.mock("./syntax.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syntax.js")>()),
  loadSyntax: vi.fn(() => Promise.resolve(false)),
}));

afterEach(cleanup);

describe("CodePreview when Shiki can't load", () => {
  it("settles on plain text instead of waiting forever", async () => {
    const { container } = render(
      <CodePreview path="src/a.ts" startLine={1} lines={["const a = 1;"]} />,
    );
    const figure = screen.getByRole("figure");
    expect(figure.getAttribute("data-syntax")).toBe("pending");
    await waitFor(() => expect(figure.getAttribute("data-syntax")).toBe("plain"));
    expect(container.querySelector("[data-token]")).toBeNull();
    expect(container.querySelector(".gi-code__line code")?.textContent).toBe("const a = 1;");
  });
});
