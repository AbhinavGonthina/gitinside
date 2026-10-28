import type { ReactNode } from "react";

/** The two color themes. Dark is the default (DESIGN_SYSTEM.md). */
export type Theme = "dark" | "light";

/** Props for {@link ViewerRoot}. */
export interface ViewerRootProps {
  /** Color theme for everything inside. Defaults to `"dark"`. */
  theme?: Theme;
  children?: ReactNode;
}

/**
 * The outermost element of every viewer surface (explorer, stories, embeds).
 * It carries `data-theme`, which the design tokens (M4a.2) key their CSS
 * variables on, so a theme switch is one attribute change with no re-render
 * of the graph below it.
 */
export function ViewerRoot({ theme = "dark", children }: ViewerRootProps) {
  return (
    <div className="gi-root" data-theme={theme}>
      {children}
    </div>
  );
}
