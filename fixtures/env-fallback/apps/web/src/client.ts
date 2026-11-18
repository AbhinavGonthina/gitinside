import { API_URL, AUTH_BASE, PAGES, SERVER, STATS, TENANT, VERSION } from "./config";

/** `{env:NEXT_PUBLIC_API_URL}/api/v1/auth/login`: the fallback's `/api/v1` is kept. */
export async function login(email: string) {
  const res = await fetch(`${API_URL}/auth/login`, { method: "POST", body: email });
  return res.json();
}

/** Same base, with a hole matching `:id`. */
export async function loadUser(id: string) {
  const res = await fetch(`${API_URL}/users/${id}`);
  return res.json();
}

/** `{env:REACT_APP_SERVER}/api/v2/authenticate`: loopback fallback, `v2` from the inner one. */
export async function authenticate() {
  await fetch(`${SERVER}/api/${VERSION}/authenticate`, { method: "POST" });
}

/** A remote fallback host and a name that isn't API-like: unresolved, never guessed. */
export async function track(event: string) {
  await fetch(`${STATS}/users/${event}`);
}

/** `{env:VITE_AUTH_BASE}/auth/refresh`: unset, it's `/auth/refresh` on this origin (ADR-0310). */
export async function refresh() {
  await fetch(`${AUTH_BASE}/refresh`, { method: "POST" });
}

/** A page-relative fallback (`auth/refresh` from the page's folder): unresolved. */
export async function refreshPage() {
  await fetch(`${PAGES}/refresh`, { method: "POST" });
}

/** A fallback path with a runtime value in it: unresolved. */
export async function refreshTenant() {
  await fetch(`${TENANT}/auth/refresh`, { method: "POST" });
}
