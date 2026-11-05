"use client";

import { useRouter } from "next/navigation";
import { useStartAnalysis } from "../../useStartAnalysis";

/**
 * The repo page's "Analyze" buttons: start an analysis of `owner/repo` through
 * `/api/analyze` (the visitor's own rate limit) and go where it says. If that's this very
 * page (someone else's analysis finished meanwhile), the page is fetched again instead.
 * The bot check runs when the server asks for it, like on the landing form: draw `check`
 * and say `asked` next to the button.
 */
export function useAnalyze(owner: string, repo: string) {
  const router = useRouter();
  const { start, pending, error, asked, check } = useStartAnalysis({
    onStarted: (href) => {
      if (href === window.location.pathname) router.refresh();
      else router.push(href);
    },
  });
  const analyze = () => start(`${owner}/${repo}`);
  return { analyze, busy: pending, error, asked, check };
}
