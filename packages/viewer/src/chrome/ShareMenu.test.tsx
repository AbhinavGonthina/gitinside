import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveFile, svgToPng, type ViewExport } from "../export/files.js";
import {
  EXPORT_MESSAGES,
  LINK_COPIED_MESSAGE,
  LINK_COPIED_MS,
  LINK_COPY_FAILED_MESSAGE,
  ShareMenu,
} from "./ShareMenu.js";

// The browser parts of exporting (downloads, rasterizing) are tested in files.test.ts.
vi.mock("../export/files.js", async (actual) => ({
  ...(await actual<typeof import("../export/files.js")>()),
  saveFile: vi.fn(),
  svgToPng: vi.fn(),
}));

const LINK = "https://example.test/acme/shop/abc?sel=route:api/GET%20/x";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(saveFile).mockReset();
  vi.mocked(svgToPng).mockReset();
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
const exportStatus = () => document.querySelector(".gi-share__export-status")?.textContent;

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

/** A view to export, recording what it was asked for. */
function fakeView(): ViewExport & { themes: string[] } {
  const themes: string[] = [];
  return {
    name: "acme-shop-a1b2c3d",
    themes,
    svg: (theme) => {
      themes.push(theme);
      return `<svg class="${theme}"/>`;
    },
    mermaid: () => "flowchart LR\n",
  };
}

/** Opens a menu that exports `view`, inside a `data-theme` like the explorer's root. */
function openExport(view: ViewExport | undefined, theme = "dark") {
  render(
    <div data-theme={theme}>
      <ShareMenu link={() => LINK} exports={() => view} />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  const group = screen.getByRole("group", { name: "Export this view" });
  const button = (name: string) => within(group).getByRole("button", { name });
  const themeChoice = (name: string) => within(group).getByRole("radio", { name });
  return { group, button, themeChoice };
}

/** The file `saveFile` was given last, and its text. */
async function saved(): Promise<[string, string, string]> {
  const call = vi.mocked(saveFile).mock.lastCall;
  if (!call) throw new Error("nothing saved");
  const [name, blob] = call;
  // jsdom's Blob has no `text()`.
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
  return [name, blob.type, text];
}

describe("ShareMenu export", () => {
  it("has no Export section without `exports`", () => {
    openMenu();
    expect(screen.queryByRole("group", { name: "Export this view" })).toBeNull();
  });

  it("saves the view as SVG in the screen's theme, or the one chosen", async () => {
    const view = fakeView();
    const { button, themeChoice } = openExport(view, "light");
    expect(themeChoice("Light").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(button("SVG"));
    expect(await saved()).toEqual([
      "acme-shop-a1b2c3d-light.svg",
      "image/svg+xml",
      '<svg class="light"/>',
    ]);
    expect(exportStatus()).toBe(EXPORT_MESSAGES.saved("acme-shop-a1b2c3d-light.svg"));
    fireEvent.click(themeChoice("Dark"));
    fireEvent.click(button("SVG"));
    expect((await saved())[0]).toBe("acme-shop-a1b2c3d-dark.svg");
    expect(view.themes).toEqual(["light", "dark"]);
  });

  it("saves a PNG of the SVG in the chosen theme, saying when it had to draw it smaller", async () => {
    const view = fakeView();
    const png = new Blob(["png"], { type: "image/png" });
    vi.mocked(svgToPng).mockResolvedValue({ blob: png, scale: 2 });
    const { button } = openExport(view);
    await act(async () => fireEvent.click(button("PNG")));
    expect(svgToPng).toHaveBeenCalledWith('<svg class="dark"/>');
    expect(saveFile).toHaveBeenCalledWith("acme-shop-a1b2c3d-dark.png", png);
    expect(exportStatus()).toBe(EXPORT_MESSAGES.saved("acme-shop-a1b2c3d-dark.png"));

    vi.mocked(svgToPng).mockResolvedValue({ blob: png, scale: 1.25 });
    await act(async () => fireEvent.click(button("PNG")));
    expect(exportStatus()).toBe(EXPORT_MESSAGES.savedSmaller("acme-shop-a1b2c3d-dark.png", 1.25));
    expect(exportStatus()).toContain("at 125%");
  });

  it("says so when the browser can't make the PNG, saving nothing", async () => {
    vi.mocked(svgToPng).mockRejectedValue(new Error("tainted"));
    const { button } = openExport(fakeView());
    await act(async () => fireEvent.click(button("PNG")));
    expect(saveFile).not.toHaveBeenCalled();
    expect(exportStatus()).toBe(EXPORT_MESSAGES.pngFailed);
    expect(button("PNG").hasAttribute("aria-busy")).toBe(false);
  });

  it("marks PNG busy while it's made, and ignores presses meanwhile", async () => {
    let finish: (png: { blob: Blob; scale: number }) => void = () => undefined;
    vi.mocked(svgToPng).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { button } = openExport(fakeView());
    fireEvent.click(button("PNG"));
    expect(button("PNG").getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button("PNG"));
    expect(svgToPng).toHaveBeenCalledTimes(1);
    await act(async () => finish({ blob: new Blob(["png"]), scale: 2 }));
    expect(button("PNG").hasAttribute("aria-busy")).toBe(false);
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("saves the Mermaid as a .mmd file, or copies it", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const view = fakeView();
    const { button } = openExport(view);
    fireEvent.click(button("Mermaid"));
    expect(await saved()).toEqual([
      "acme-shop-a1b2c3d.mmd",
      "text/plain;charset=utf-8",
      "flowchart LR\n",
    ]);
    await act(async () => fireEvent.click(button("Copy Mermaid")));
    expect(writeText).toHaveBeenCalledWith("flowchart LR\n");
    expect(exportStatus()).toBe(EXPORT_MESSAGES.mermaidCopied);
    // Mermaid has no theme.
    expect(view.themes).toEqual([]);
  });

  it("says so when the Mermaid can't be copied", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("no"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { button } = openExport(fakeView());
    await act(async () => fireEvent.click(button("Copy Mermaid")));
    expect(exportStatus()).toBe(EXPORT_MESSAGES.mermaidCopyFailed);
  });

  it("waits for a layout before exporting anything", async () => {
    const { button } = openExport(undefined);
    for (const name of ["SVG", "PNG", "Mermaid", "Copy Mermaid"]) {
      await act(async () => fireEvent.click(button(name)));
      expect(exportStatus()).toBe(EXPORT_MESSAGES.notReady);
    }
    expect(saveFile).not.toHaveBeenCalled();
    expect(svgToPng).not.toHaveBeenCalled();
  });

  it("starts each open on the screen's theme and clears what it last said", () => {
    const { button, themeChoice } = openExport(fakeView(), "dark");
    fireEvent.click(themeChoice("Light"));
    fireEvent.click(button("SVG"));
    expect(exportStatus()).not.toBe("");
    const share = screen.getByRole("button", { name: "Share" });
    fireEvent.click(share);
    fireEvent.click(share);
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(exportStatus()).toBe("");
  });
});
