import client from "@/lib/client";

export function listNotes() {
  return client.get("/notes");
}

export function addNote(note) {
  return client.post("/notes", note);
}

export function removeNote(id) {
  return client.delete(`/notes/${id}`);
}
