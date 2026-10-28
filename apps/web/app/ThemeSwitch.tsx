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
 * choice in a cookie for the server's next render.
 */
export function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const choose = (next: Theme) => {
    setTheme(next);
    document.documentElement.dataset["theme"] = next;
    document.cookie = themeCookie(next, location.protocol === "https:");
  };
  return <SegmentedControl label="Theme" options={OPTIONS} value={theme} onChange={choose} />;
}
