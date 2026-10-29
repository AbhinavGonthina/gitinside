"use client";

import { Button, SegmentedControl } from "@gitinside/viewer";
import { useEffect, useId, useRef, useState } from "react";
import { readmeAlt, readmeMarkdown, readmeUrls, type ReadmeKind } from "../../../lib/readme";
import { parseTheme } from "../../../lib/theme";

const KINDS = [
  { value: "badge", label: "Badge" },
  { value: "image", label: "Live image" },
] as const;

/** How long "Copied" stays on the button. */
export const COPIED_MS = 2000;

/** What the live region says after a copy, or after one the browser refused. */
export const COPIED_MESSAGE = "Copied. Paste it into your README.";
export const COPY_FAILED_MESSAGE = "Couldn't copy. Select the text and copy it yourself.";

type CopyState = "idle" | "copied" | "failed";

/**
 * "Add to README" on the repo bar (UX.md "README badge", ADR-0073): a button that opens a
 * panel with the Markdown for the badge or the live image, a preview of it, and a copy
 * button. It is a disclosure, not a dialog: the page stays usable, Tab walks from the button
 * into the panel, and Esc (or a click outside) closes it, returning focus to the button if
 * it was inside. The snippet uses this site's own origin, read when the panel opens.
 */
export function AddToReadme({ owner, repo }: { owner: string; repo: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ReadmeKind>("badge");
  const [copy, setCopy] = useState<CopyState>("idle");
  const root = useRef<HTMLDivElement>(null);
  const code = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = () => {
    const hadFocus = root.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (hadFocus) root.current?.querySelector<HTMLButtonElement>(".readme-menu__trigger")?.focus();
  };

  const choose = (next: ReadmeKind) => {
    setKind(next);
    setCopy("idle");
  };

  const origin = open ? window.location.origin : "";
  const markdown = open ? readmeMarkdown(kind, origin, owner, repo) : "";

  const copyMarkdown = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopy("copied");
      timer.current = setTimeout(() => setCopy("idle"), COPIED_MS);
    } catch {
      // No clipboard (an insecure origin) or permission refused: select it for the reader.
      setCopy("failed");
      const selection = window.getSelection();
      if (code.current && selection) selection.selectAllChildren(code.current);
    }
  };

  return (
    <div
      className="readme-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <Button
        className="readme-menu__trigger"
        variant="secondary"
        size="sm"
        icon="share"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Add to README
      </Button>
      {open && (
        <section className="readme-panel" id={panelId} aria-labelledby={titleId}>
          <div className="readme-panel__head">
            <h2 className="readme-panel__title" id={titleId}>
              Add to README
            </h2>
            <SegmentedControl label="What to add" options={KINDS} value={kind} onChange={choose} />
          </div>
          <p className="readme-panel__text">
            {kind === "badge"
              ? "A small badge that counts the repo's services and datastores."
              : "The top level as a picture, in the reader's GitHub theme."}{" "}
            It links to this page and checks for a newer commit each time it&apos;s viewed.
          </p>
          <div className="readme-panel__preview" data-kind={kind}>
            <img
              src={
                kind === "badge"
                  ? readmeUrls(origin, owner, repo).badge
                  : readmeUrls(origin, owner, repo).diagram(
                      parseTheme(document.documentElement.dataset["theme"]),
                    )
              }
              alt={readmeAlt(owner, repo)}
            />
          </div>
          <pre className="readme-panel__code" ref={code} tabIndex={0} aria-label="Markdown">
            <code>{markdown}</code>
          </pre>
          <div className="readme-panel__actions">
            <p className="readme-panel__status" role="status">
              {copy === "copied" ? COPIED_MESSAGE : copy === "failed" ? COPY_FAILED_MESSAGE : ""}
            </p>
            <Button variant="primary" size="sm" onClick={copyMarkdown}>
              {copy === "copied" ? "Copied" : "Copy"}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
