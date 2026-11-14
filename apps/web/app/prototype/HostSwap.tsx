"use client";

import { useEffect, useRef, useState } from "react";

/** Props for {@link HostSwap}. */
export interface HostSwapProps {
  /** The repo's path on both hosts: `/<owner>/<repo>`. */
  path: string;
  /** GitInside's host, as the line spells it. */
  host: string;
  /** Where clicking the line goes. */
  href: string;
}

/**
 * The landing's URL swap line (M10-design §3.5, M14.1's trick): a GitHub URL whose host
 * crossfades to GitInside's once, when the line first scrolls into view (opacity only; the hosts
 * share one right-aligned slot, so the path never moves). Under reduced motion the fade's
 * duration token is 0, so it's GitInside's host at once. Screen readers read the line's outcome:
 * the GitHub host is hidden from them, and the link names where it goes.
 */
export function HostSwap({ path, host, href }: HostSwapProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [swapped, setSwapped] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setSwapped(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setSwapped(true);
        observer.disconnect();
      },
      // Most of the line on screen, so the reader sees the swap happen.
      { threshold: 0.75 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <p className="swap">
      <span className="swap__lead">Or swap the host:</span>
      <a ref={ref} className="swap__url" href={href} data-swapped={swapped ? "" : undefined}>
        <span className="swap__hosts">
          <span className="swap__host" data-host="github" aria-hidden>
            github.com
          </span>
          <span className="swap__host" data-host="gitinside">
            {host}
          </span>
        </span>
        <span className="swap__path">{path}</span>
      </a>
    </p>
  );
}
