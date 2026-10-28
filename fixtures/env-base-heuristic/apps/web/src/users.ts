const API_URL = process.env.NEXT_PUBLIC_API_URL;

/** An API-named env base: `heuristic` against `GET /users/:id` in the other service. */
export async function loadUser(id: string) {
  const res = await fetch(`${API_URL}/users/${id}`);
  return res.json();
}

/** Still `heuristic`, but the literal route beats `/users/:id` on path alignment. */
export async function loadMe() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/users/me`);
  return res.json();
}

/** An env var not named like an API base matches no route. */
export async function track(event: string) {
  await fetch(`${process.env.ANALYTICS_HOST}/users/${event}`, { method: "POST" });
}
