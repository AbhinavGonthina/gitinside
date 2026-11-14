"use client";

import { useEffect } from "react";
import { countVisit } from "../lib/visit";

/** Pings the visit counter once on mount (lib/visit.ts decides whether it fires). Renders nothing. */
export function VisitBeacon() {
  useEffect(() => {
    countVisit();
  }, []);
  return null;
}
