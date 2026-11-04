import { $fetch, ofetch } from "ofetch";
import { api, poster, v2 } from "./http";

export function listUsers() {
  return api("/users");
}

export function getUser(id: string) {
  return api(`/users/${id}`);
}

export function createUser(name: string) {
  return api.raw("/users", { method: "POST", body: { name } });
}

export function removeUser(id: string) {
  return $fetch(`/users/${id}`, { method: "delete", baseURL: "/api" });
}

export function signIn(email: string) {
  return poster("/auth/login", { body: { email } });
}

export function loadStats() {
  return v2("/stats");
}

// ofetch leaves a URL that already starts with the base alone: `/api/health`, not `/api/api/health`.
export function health() {
  return ofetch("/api/health", { baseURL: "/api" });
}

// No such route: shown as unresolved, never dropped.
export function track(event: string) {
  return poster("/events", { body: { event } });
}
