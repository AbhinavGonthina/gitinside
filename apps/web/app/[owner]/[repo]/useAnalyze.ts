"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startAnalysis } from "../../../lib/startAnalysis";

/**
 * The repo page's "Analyze" buttons: start an analysis of `owner/repo` through
 * `/api/analyze` (the visitor's own rate limit) and go where it says. If that's this very
 * page (someone else's analysis finished meanwhile), the page is fetched again instead.
 */
export function useAnalyze(owner: string, repo: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const analyze = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const answer = await startAnalysis(`${owner}/${repo}`);
    setBusy(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    if (answer.href === window.location.pathname) router.refresh();
    else router.push(answer.href);
  };

  return { analyze, busy, error };
}
