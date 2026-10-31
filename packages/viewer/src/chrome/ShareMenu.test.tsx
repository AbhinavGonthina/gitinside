import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINK_COPIED_MESSAGE,
  LINK_COPIED_MS,
  LINK_COPY_FAILED_MESSAGE,
  ShareMenu,
} from "./ShareMenu.js";

const LINK = "https://example.test/acme/shop/abc?sel=route:api/GET%20/x";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function openMenu(link: () => string = () => LINK) {
  render(
    <div>
      <ShareMenu link={link} />
      <button type="button">Elsewhere</button>
    </div>,
  );
  const button = screen.getByRole("button", { name: "Share" });
  fireEvent.click(button);
  return button;
}

/** The open panel (a closing one is inert and leaves the accessibility tree). */
const panel = () => document.querySelector('.gi-share[data-state="open"]');
const field = () => screen.getByRole("textbox", { name: "Link to this view" }) as HTMLInputElement;
const status = () => document.querySelector(".gi-share__status")?.textContent;

describe("ShareMenu", () => {
  it("opens a panel with the link, focus on Copy link, reading the link only while open", () => {
    const link = vi.fn(() => LINK);
    render(<ShareMenu link={link} />);
    expect(link).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Share" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const region = screen.getByRole("region", { name: "Share" });
    expect(button.getAttribute("aria-controls")).toBe(region.id);
    expect(field().value).toBe(LINK);
    expect(field().readOnly).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy link" }));
  });

  it("copies the link, says so, and goes back to Copy link", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    openMenu();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy link" })));
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(LINK_COPIED_MESSAGE);
    await act(() => vi.advanceTimersByTimeAsync(LINK_COPIED_MS - 1));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("selects the link for the reader when the browser refuses to copy", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("no"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    openMenu();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy link" })));
    expect(status()).toBe(LINK_COPY_FAILED_MESSAGE);
    expect(document.activeElement).toBe(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, LINK.length]);
  });

  it("closes on Esc without letting it reach the page, focus back on Share", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <ShareMenu link={() => LINK} />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Share" });
    fireEvent.click(button);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(panel()).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(outer).not.toHaveBeenCalled();
    // Closed, Esc is the page's again.
    fireEvent.keyDown(button, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("closes on a press outside, leaving focus where the press put it, and on its button", () => {
    const button = openMenu();
    fireEvent.mouseDown(field());
    expect(panel()).not.toBeNull();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.mouseDown(elsewhere);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    fireEvent.click(button);
    expect(panel()).not.toBeNull();
    fireEvent.click(button);
    expect(panel()).toBeNull();
  });

  it("reads the link again when the view changes while it's open", () => {
    let link = LINK;
    const { rerender } = render(<ShareMenu link={() => link} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    link = `${LINK}&step=2`;
    rerender(<ShareMenu link={() => link} />);
    expect(field().value).toBe(`${LINK}&step=2`);
  });
});
