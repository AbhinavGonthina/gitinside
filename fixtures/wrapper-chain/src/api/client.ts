/** Every request goes under `/api/`, with the caller's init and a timeout. */
async function send(path: string, init: RequestInit, timeout: number) {
  const res = await fetch("/api/" + path, { ...init, signal: AbortSignal.timeout(timeout) });
  return res.ok ? res.json() : null;
}

/** A wrapper over `send`: it passes its path on, with a query string when given one. */
export function getJson(path: string, query?: string) {
  return send(query ? `${path}?${query}` : path, { method: "GET" }, 10_000);
}

export function postJson(path: string, body: unknown) {
  return send(path, { method: "POST", body: JSON.stringify(body) }, 5_000);
}

/** Three wrappers deep: `getCached` → `getJson` → `send`. */
export function getCached(path: string) {
  return getJson(path, "cache=1");
}
