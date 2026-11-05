import { getCached } from "./client";

/** A fourth wrapper: deeper than inlining follows, so its request is WRAPPER_DEPTH. */
export function getTracked(path: string) {
  return getCached(path);
}

export const loadFeed = () => getTracked("feed");
