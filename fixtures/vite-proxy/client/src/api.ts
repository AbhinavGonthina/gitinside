/** Through the `/api` entry: the server gets `/users`, not the `/api/users` decoy. */
export async function listUsers() {
  const res = await fetch("/api/users");
  return res.json();
}

/** Same entry, a hole matching `:id`. */
export async function getUser(id: string) {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
}

/** The `/auth` entry has no rewrite. */
export async function signIn(email: string) {
  await fetch("/auth/login", { method: "POST", body: JSON.stringify({ email }) });
}

/** The `/weather` entry's target is outside the repo. */
export async function forecast(city: string) {
  const res = await fetch(`/weather/${city}`);
  return res.json();
}

/** Sent as `/orders`, which no route serves: unresolved, not matched to `/api/orders`. */
export async function listOrders() {
  const res = await fetch("/api/orders");
  return res.json();
}
