import { API_URL, SERVER, STATS, VERSION } from "./config";

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
