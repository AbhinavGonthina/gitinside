export type JsonInit = Omit<RequestInit, "body"> & { payload?: unknown };

/** Sends JSON; the caller's `method` (and the rest of its init) passes through `...options`. */
export async function sendJson(path: string, init: JsonInit = {}) {
  const { payload, headers, ...options } = init;
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return response.json();
}

/** Always posts unless told otherwise: `method` is taken out of `rest`, so it never overrides. */
export function postForm(path: string, { method, ...rest }: RequestInit = {}) {
  return fetch(path, { method: "POST", ...rest });
}
