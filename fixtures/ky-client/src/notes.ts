import ky from "ky";
import { api, v1, writer } from "./http";

export function listNotes() {
  return api.get("notes").json();
}

export function getNote(id: string) {
  return api(`notes/${id}`).json();
}

export function saveNote(id: string, text: string) {
  return api.put(`notes/${id}`, { json: { text } });
}

export function addNote(text: string) {
  return writer("notes", { json: { text } });
}

// ky 2's `prefix` on the call itself.
export function signIn(email: string) {
  return ky.post("session", { prefix: "/api", json: { email } });
}

export function listTags() {
  return v1.get("tags").json();
}

// A root-relative URL keeps only the base's origin: `/status`, not `/api/v1/status`.
export function status() {
  return v1("/status").text();
}

// ky 1 throws on a leading slash under `prefixUrl`: unresolved, with that reason.
export function brokenList() {
  return api.get("/notes");
}

// No such route: shown as unresolved, never dropped.
export function archive(id: string) {
  return writer(`notes/${id}/archive`);
}
