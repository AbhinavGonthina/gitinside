// RentTools.io's admin panel and comments widget pick the method with a condition.

export async function toggleSuspend(user: { id: string }, isSuspended: boolean) {
  return fetch(`/api/admin/users/${user.id}/suspend`, {
    method: isSuspended ? "DELETE" : "POST",
  });
}

export async function moderate(id: string, action: "delete" | "hide") {
  const init =
    action === "delete"
      ? { method: "DELETE" }
      : { method: "PATCH", body: JSON.stringify({ hidden: true }) };
  return fetch(`/api/blog-comments/${id}`, init);
}

// Only `PUT` has a route: the `DELETE` request is shown unresolved beside the edge.
export async function archive(id: string, undo: boolean) {
  return fetch(`/api/posts/${id}/archive`, { method: undo ? "DELETE" : "PUT" });
}

export function vote(path: string, up: boolean) {
  return fetch(path, { method: up ? "POST" : "DELETE" });
}

export const upvote = (id: string, up: boolean) => vote(`/api/posts/${id}/vote`, up);

// Control: one branch is a value the analyzer can't read, so the method stays unknown.
export async function edit(id: string, verb: string, hide: boolean) {
  return fetch(`/api/blog-comments/${id}`, { method: hide ? verb : "PATCH" });
}

// The URL and the method come from one condition. Which URL goes with which method isn't
// read, so the method isn't split: `POST /api/drafts/:id` and `PUT /api/drafts` aren't sent.
export async function saveDraft(id: string | undefined) {
  const url = id ? `/api/drafts/${id}` : "/api/drafts";
  return fetch(url, { method: id ? "PUT" : "POST" });
}

// A URL only known at runtime stays one request, whatever the method.
export async function report(urgent: boolean) {
  return fetch(window.location.href, { method: urgent ? "POST" : "PUT" });
}
