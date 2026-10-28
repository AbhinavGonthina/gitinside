import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ViewerRoot } from "./index.js";

afterEach(cleanup);

describe("ViewerRoot", () => {
  it("defaults to the dark theme", () => {
    const { container } = render(<ViewerRoot />);
    const root = container.firstElementChild!;
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.classList.contains("gi-root")).toBe(true);
  });

  it("applies the light theme when asked", () => {
    const { container } = render(<ViewerRoot theme="light" />);
    expect(container.firstElementChild!.getAttribute("data-theme")).toBe("light");
  });

  it("renders its children inside the themed element", () => {
    render(
      <ViewerRoot theme="light">
        <span>canvas</span>
      </ViewerRoot>,
    );
    const child = screen.getByText("canvas");
    expect(child.closest("[data-theme]")?.getAttribute("data-theme")).toBe("light");
  });
});
