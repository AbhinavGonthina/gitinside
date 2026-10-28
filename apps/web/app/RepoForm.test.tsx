import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoForm } from "./RepoForm";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => push.mockReset());
afterEach(cleanup);

function field() {
  return screen.getByRole("textbox", { name: "GitHub repo URL" });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
}

describe("RepoForm", () => {
  it("has a labeled field, the paste prompt, and the support hint", () => {
    render(<RepoForm />);
    expect(field()).toHaveProperty("placeholder", "Paste a GitHub repo URL");
    expect(field().getAttribute("aria-describedby")).toBeTruthy();
    const hint = document.getElementById(field().getAttribute("aria-describedby")!);
    expect(hint?.textContent).toMatch(/^Public repos, no sign-in\./);
    expect(hint?.getAttribute("aria-live")).toBe("polite");
  });

  it("opens the repo's page for a valid URL", () => {
    render(<RepoForm />);
    fireEvent.change(field(), { target: { value: " https://github.com/acme/shop.git " } });
    submit();
    expect(push.mock.calls).toEqual([["/acme/shop"]]);
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("submits on Enter too", () => {
    render(<RepoForm />);
    fireEvent.change(field(), { target: { value: "acme/shop" } });
    fireEvent.submit(field().closest("form")!);
    expect(push).toHaveBeenCalledWith("/acme/shop");
  });

  it("says what's wrong, marks the field, and keeps focus there", () => {
    render(<RepoForm />);
    fireEvent.change(field(), { target: { value: "https://gitlab.com/acme/shop" } });
    submit();
    expect(push).not.toHaveBeenCalled();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
    const hint = document.getElementById(field().getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(
      "That isn't a GitHub repo URL. Try https://github.com/owner/repo.",
    );
    expect(hint.hasAttribute("data-error")).toBe(true);
  });

  it("asks for a URL when submitted empty", () => {
    render(<RepoForm />);
    submit();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("Paste a GitHub repo URL first.")).toBeTruthy();
  });

  it("clears the error as soon as the visitor edits the field", () => {
    render(<RepoForm />);
    submit();
    fireEvent.change(field(), { target: { value: "a" } });
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText(/^Public repos, no sign-in\./)).toBeTruthy();
  });
});
