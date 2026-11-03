export async function loadNotes() {
  return fetch("/api/notes");
}

export async function addNote(text: string) {
  return fetch("/api/notes", { method: "POST", body: JSON.stringify({ text }) });
}

export async function removeNote(id: string) {
  return fetch(`/api/notes/${id}`, { method: "DELETE" });
}

export async function replaceNote(id: string) {
  return fetch(`/api/notes/${id}`, { method: "PUT" });
}

export default function Home() {
  return null;
}
