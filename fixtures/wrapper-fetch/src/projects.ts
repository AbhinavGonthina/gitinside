import { request, requestVia } from "./http";

export function listProjects() {
  return request("/projects");
}

export function createProject(name: string) {
  return request("/projects", { method: "POST", body: JSON.stringify({ name }) });
}

export function legacyProjects() {
  return requestVia("/api/projects");
}
