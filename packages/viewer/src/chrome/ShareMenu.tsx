import { useEffect, useId, useRef, useState } from "react";
import { PNG_SCALE, saveFile, svgToPng, type ViewExport } from "../export/files.js";
import { usePresence } from "../motion.js";
import type { Theme } from "../ViewerRoot.js";
import { Button, SegmentedControl, type ButtonVariant } from "./controls.js";

/** How long "Copied" stays on the button. */
export const LINK_COPIED_MS = 2000;

/** What the live region says after a copy, or after one the browser refused. */
export const LINK_COPIED_MESSAGE = "Link copied. It opens this view at this commit.";
export const LINK_COPY_FAILED_MESSAGE = "Couldn't copy. Select the link and copy it yourself.";

/** What the export's live region says. */
export const EXPORT_MESSAGES = {
  saved: (file: string) => `Saved ${file}.`,
  savedSmaller: (file: string, scale: number) =>
    `Saved ${file} at ${Math.round(scale * 100)}% (the view is too large for ${PNG_SCALE}×).`,
  pngFailed: "Couldn't make the PNG in this browser. Save the SVG instead.",
  mermaidCopied: "Mermaid copied. Paste it into a mermaid code block in Markdown.",
  mermaidCopyFailed: "Couldn't copy. Save the Mermaid file instead.",
  notReady: "The diagram is still being laid out.",
} as const;

const THEMES = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
] as const;

type ExportKind = "svg" | "png" | "mermaid";

/** The theme the menu sits in (its closest `data-theme`), so an export starts out looking like the screen. */
function themeAround(el: Element | null): Theme {
  return el?.closest("[data-theme]")?.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** Props for {@link ShareMenu}. */
export interface ShareMenuProps {
  /**
   * The link to this view, read each time the menu draws (so it follows the
   * view while open), e.g. `encodeState` on the page's URL.
   */
  link: () => string;
  /**
   * The view on screen to export, read each time the menu draws (e.g. the
   * explorer's `exportRef`). Without it, the menu has no Export section;
   * while it returns `undefined` (no layout yet), the export buttons wait.
   */
  exports?: (() => ViewExport | undefined) | undefined;
  /** The trigger's look: `quiet` in the explorer's top bar (default), `secondary` on a page's bar. */
  variant?: ButtonVariant;
  size?: "sm" | "md";
  className?: string | undefined;
}

type CopyState = "idle" | "copied" | "failed";

/**
 * The share menu (UX.md "Deep links"): a Share button that opens a small
 * panel with the link to the current view and **Copy link**. It's a
 * disclosure, not a dialog: the page stays usable, focus moves to Copy link
 * when it opens, and Esc, the button, or a press outside closes it (focus
 * inside goes back to the button). A refused copy selects the link for the
 * reader instead.
 *
 * With `exports`, an **Export** section (M4b.10b, UX.md "Export") saves the
 * view on screen as an SVG or a PNG (the SVG at {@link PNG_SCALE}×) in the
 * chosen theme (the screen's, to start with), or as Mermaid, saved or
 * copied. Every file is made in the browser; nothing is uploaded.
 */
export function ShareMenu({
  link,
  exports,
  variant = "quiet",
  size = "md",
  className,
}: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const state = usePresence(open);
  const [copy, setCopy] = useState<CopyState>("idle");
  const [theme, setTheme] = useState<Theme>("dark");
  const [exportStatus, setExportStatus] = useState("");
  const [making, setMaking] = useState<ExportKind>();
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panelId = useId();
  const titleId = useId();
  const exportTitleId = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  // Focus on every open, also when reopened mid-exit (the same element).
  useEffect(() => {
    if (state === "open") root.current?.querySelector<HTMLElement>(".gi-share__copy")?.focus();
  }, [state]);

  // Each open starts on the screen's theme.
  useEffect(() => {
    if (open) setTheme(themeAround(root.current));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close(true);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  /** Closes the panel; focus inside it goes back to the button, unless `stay` (a press elsewhere took it). */
  function close(stay = false) {
    const inside = root.current?.querySelector(".gi-share")?.contains(document.activeElement);
    if (inside && !stay)
      root.current?.querySelector<HTMLButtonElement>(".gi-share-menu__trigger")?.focus();
    else if (inside && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    clearTimeout(timer.current);
    setCopy("idle");
    setExportStatus("");
    setOpen(false);
  }

  const href = state ? link() : "";
  const view = state && exports ? exports() : undefined;

  /** Saves the view as a file in the chosen theme (Mermaid has none). */
  async function save(kind: ExportKind) {
    if (!view) {
      setExportStatus(EXPORT_MESSAGES.notReady);
      return;
    }
    if (kind === "mermaid") {
      const file = `${view.name}.mmd`;
      saveFile(file, new Blob([view.mermaid()], { type: "text/plain;charset=utf-8" }));
      setExportStatus(EXPORT_MESSAGES.saved(file));
      return;
    }
    const svg = view.svg(theme);
    if (kind === "svg") {
      const file = `${view.name}-${theme}.svg`;
      saveFile(file, new Blob([svg], { type: "image/svg+xml" }));
      setExportStatus(EXPORT_MESSAGES.saved(file));
      return;
    }
    const file = `${view.name}-${theme}.png`;
    setMaking("png");
    try {
      const png = await svgToPng(svg);
      saveFile(file, png.blob);
      setExportStatus(
        png.scale < PNG_SCALE
          ? EXPORT_MESSAGES.savedSmaller(file, png.scale)
          : EXPORT_MESSAGES.saved(file),
      );
    } catch {
      setExportStatus(EXPORT_MESSAGES.pngFailed);
    } finally {
      setMaking(undefined);
    }
  }

  async function copyMermaid() {
    if (!view) {
      setExportStatus(EXPORT_MESSAGES.notReady);
      return;
    }
    try {
      await navigator.clipboard.writeText(view.mermaid());
      setExportStatus(EXPORT_MESSAGES.mermaidCopied);
    } catch {
      setExportStatus(EXPORT_MESSAGES.mermaidCopyFailed);
    }
  }

  async function copyLink() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(href);
      setCopy("copied");
      timer.current = setTimeout(() => setCopy("idle"), LINK_COPIED_MS);
    } catch {
      // No clipboard (an insecure origin) or permission refused: select it for the reader.
      setCopy("failed");
      field.current?.focus();
      field.current?.select();
    }
  }

  return (
    <div
      ref={root}
      className={className ? `gi-share-menu ${className}` : "gi-share-menu"}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open || event.defaultPrevented) return;
        // Only the menu closes: the explorer's Esc (exit trace, go up) waits for the next press.
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <Button
        className="gi-share-menu__trigger"
        variant={variant}
        size={size}
        icon="share"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Share
      </Button>
      {state && (
        <section
          className="gi-popover gi-share"
          id={panelId}
          aria-labelledby={titleId}
          data-state={state}
          inert={state === "closing" || undefined}
          aria-hidden={state === "closing" || undefined}
        >
          <header className="gi-popover__header">
            <h2 id={titleId}>Share</h2>
          </header>
          <p className="gi-share__text">
            Opens this commit with what&apos;s broken down, selected, traced, and filtered.
          </p>
          <input
            ref={field}
            className="gi-share__link"
            type="text"
            readOnly
            value={href}
            aria-label="Link to this view"
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="gi-share__actions">
            <p className="gi-share__status" role="status">
              {copy === "copied"
                ? LINK_COPIED_MESSAGE
                : copy === "failed"
                  ? LINK_COPY_FAILED_MESSAGE
                  : ""}
            </p>
            <Button className="gi-share__copy" variant="primary" size="sm" onClick={copyLink}>
              {copy === "copied" ? "Copied" : "Copy link"}
            </Button>
          </div>
          {exports && (
            <div className="gi-share__export" role="group" aria-labelledby={exportTitleId}>
              <h3 id={exportTitleId}>Export this view</h3>
              {/* Images in a theme; Mermaid has none, so it gets its own row. */}
              <div className="gi-share__export-row">
                <Button variant="secondary" size="sm" onClick={() => save("svg")}>
                  SVG
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-busy={making === "png" || undefined}
                  onClick={() => (making ? undefined : save("png"))}
                >
                  PNG
                </Button>
                <SegmentedControl
                  label="Export theme"
                  options={THEMES}
                  value={theme}
                  onChange={setTheme}
                />
              </div>
              <div className="gi-share__export-row">
                <Button variant="secondary" size="sm" onClick={() => save("mermaid")}>
                  Mermaid
                </Button>
                <Button variant="quiet" size="sm" onClick={copyMermaid}>
                  Copy Mermaid
                </Button>
              </div>
              <p className="gi-share__status gi-share__export-status" role="status">
                {exportStatus}
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
