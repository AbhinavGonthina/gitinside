import { useEffect, useId, useRef, useState } from "react";
import { usePresence } from "../motion.js";
import { Button, type ButtonVariant } from "./controls.js";

/** How long "Copied" stays on the button. */
export const LINK_COPIED_MS = 2000;

/** What the live region says after a copy, or after one the browser refused. */
export const LINK_COPIED_MESSAGE = "Link copied. It opens this view at this commit.";
export const LINK_COPY_FAILED_MESSAGE = "Couldn't copy. Select the link and copy it yourself.";

/** Props for {@link ShareMenu}. */
export interface ShareMenuProps {
  /**
   * The link to this view, read each time the menu draws (so it follows the
   * view while open), e.g. `encodeState` on the page's URL.
   */
  link: () => string;
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
 * reader instead. Export (M4b.10) joins it later.
 */
export function ShareMenu({ link, variant = "quiet", size = "md", className }: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const state = usePresence(open);
  const [copy, setCopy] = useState<CopyState>("idle");
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  // Focus on every open, also when reopened mid-exit (the same element).
  useEffect(() => {
    if (state === "open") root.current?.querySelector<HTMLElement>(".gi-share__copy")?.focus();
  }, [state]);

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
    setOpen(false);
  }

  const href = state ? link() : "";

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
        </section>
      )}
    </div>
  );
}
