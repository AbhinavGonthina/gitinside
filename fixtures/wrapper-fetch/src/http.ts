const BASE = "/api";

/** One-level wrapper: each call is inlined with `path` bound to the caller's argument. */
export async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, { method: "GET", ...init });
  return res.json();
}

/** A wrapper around a wrapper: its URL is the caller's parameter, so WRAPPER_DEPTH. */
export function requestRaw(url: string) {
  return fetch(url);
}

export function requestVia(url: string) {
  return requestRaw(url);
}
