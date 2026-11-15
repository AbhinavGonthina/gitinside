// DreamingEnglish's two helpers: `serverApi` adds a cookie to the caller's options and hands
// them to `api`, which sends them.

export async function api(path: string, options?: RequestInit) {
  const response = await fetch(`/api${path}`, options);
  return response.json();
}

export async function serverApi(path: string, options?: RequestInit) {
  const cookie = "session=1";
  return api(path, { ...options, headers: { ...options?.headers, cookie } });
}

// A method written after the spread wins over the caller's.
export function forcePost(path: string, options?: RequestInit) {
  return api(path, { ...options, method: "POST" });
}

// A method written before the spread is the default the caller's may replace.
export function remove(path: string, options?: RequestInit) {
  return api(path, { method: "DELETE", ...options });
}

function extra(): RequestInit {
  return {};
}

// Control: a spread of a call's result could set any method.
export function withExtra(path: string, options?: RequestInit) {
  return api(path, { ...options, ...extra() });
}
