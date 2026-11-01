export async function loadUser(id: string) {
  return fetch(`/api/users/${id}`).then((r) => r.json());
}

export async function flushCache() {
  return fetch("/admin/cache/flush", { method: "POST" });
}
