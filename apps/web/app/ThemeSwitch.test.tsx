import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeSwitch } from "./ThemeSwitch";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset["theme"];
  document.cookie = "gi-theme=; Path=/; Max-Age=0";
});

describe("ThemeSwitch", () => {
  it("is a radio group showing the server's theme", () => {
    render(<ThemeSwitch initial="light" />);
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("false");
  });

  it("switches <html>'s theme and remembers it in the cookie", () => {
    document.documentElement.dataset["theme"] = "dark";
    render(<ThemeSwitch initial="dark" />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(document.cookie).toContain("gi-theme=light");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(screen.getByRole("radio", { name: "Light" }), { key: "ArrowLeft" });
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(document.cookie).toContain("gi-theme=dark");
  });
});
