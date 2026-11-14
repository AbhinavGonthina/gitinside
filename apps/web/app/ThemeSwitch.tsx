"use client";

import { SegmentedControl, type Theme } from "@gitinside/viewer";
import { useState } from "react";
import { themeCookie } from "../lib/theme";

const OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
] as const;

/**
 * Dark / Light, as the viewer's radio group. Switching changes one attribute
 * on `<html>` (the tokens follow it, nothing re-renders) and remembers the
 * choice in a cookie for the server's next render. `compact` (the prototype's
 * one bar, M10-design A7) is one icon button that switches to the other theme,
 * named for what it does.
 */
export function ThemeSwitch({ initial, compact = false }: { initial: Theme; compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const choose = (next: Theme) => {
    setTheme(next);
    document.documentElement.dataset["theme"] = next;
    document.cookie = themeCookie(next, location.protocol === "https:");
  };
  if (compact) {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const name = `Switch to the ${next} theme`;
    return (
      <button
        type="button"
        className="gi-button"
        data-variant="quiet"
        data-size="md"
        data-icon-only=""
        aria-label={name}
        title={name}
        onClick={() => choose(next)}
      >
        <svg
          className="gi-ui-icon"
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth={2} />
          <path d="M12 4.5a7.5 7.5 0 0 1 0 15Z" fill="currentColor" />
        </svg>
      </button>
    );
  }
  return <SegmentedControl label="Theme" options={OPTIONS} value={theme} onChange={choose} />;
}
