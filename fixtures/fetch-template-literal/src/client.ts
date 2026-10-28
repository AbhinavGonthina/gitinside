/** A template literal with a hole: matches `/api/users/:id` exactly. */
export async function loadUser(id: string) {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
}

/** The query string is dropped before matching. */
export async function listUsers(limit: number) {
  const res = await fetch(`/api/users?limit=${limit}`);
  return res.json();
}

/** No route serves this path: an unresolved edge with NO_MATCHING_ROUTE, never dropped. */
export async function loadTeams() {
  const res = await fetch("/api/teams");
  return res.json();
}

// Top-level code has no symbol, so the file node makes the request.
void fetch("/api/users");
