export async function loadShelves() {
  return fetch("/api/shelves");
}

export async function addShelf(name: string) {
  return fetch("/api/shelves", { method: "POST", body: JSON.stringify({ name }) });
}

export async function renameShelf(id: string, name: string) {
  return fetch(`/api/shelves/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
}

export async function removeShelf(id: string) {
  return fetch(`/api/shelves/${id}`, { method: "DELETE" });
}

export async function archiveShelf(id: string) {
  return fetch(`/api/shelves/${id}`, { method: "PATCH" });
}

export async function countStock() {
  return fetch("/api/stock", { method: "PATCH" });
}

export async function signOut() {
  return fetch("/api/auth/signout", { method: "POST" });
}

export default function Pantry() {
  return null;
}
