// Controls: the two conditions may not take the same branch, so the method isn't paired and
// each URL is ambiguous between its path's two routes.

// A `let` may change between the two reads.
export async function draftLet(id?: string) {
  let editing = !!id;
  const url = editing ? `/api/drafts/${id}` : "/api/drafts";
  editing = false;
  return fetch(url, { method: editing ? "PUT" : "POST" });
}

// So may a parameter something assigns.
export async function draftAssigned(id?: string) {
  const url = id ? `/api/drafts/${id}` : "/api/drafts";
  if (id === "") id = undefined;
  return fetch(url, { method: id ? "PUT" : "POST" });
}

// A property read may be a getter, or be written in between.
export async function draftProperty(draft: { id?: string }) {
  const url = draft.id ? `/api/drafts/${draft.id}` : "/api/drafts";
  return fetch(url, { method: draft.id ? "PUT" : "POST" });
}

// Two different conditions.
export async function draftOther(id: string | undefined, exists: boolean) {
  const url = id ? `/api/drafts/${id}` : "/api/drafts";
  return fetch(url, { method: exists ? "PUT" : "POST" });
}

// A second condition in the URL, so one branch still has two URLs.
export async function draftNested(id: string | undefined, mine: boolean) {
  const url = id ? (mine ? `/api/drafts/${id}` : "/api/drafts/shared") : "/api/drafts";
  return fetch(url, { method: id ? "PUT" : "POST" });
}

// A call can answer differently each time.
export async function draftCall(id: string, isSaved: () => boolean) {
  const url = isSaved() ? `/api/drafts/${id}` : "/api/drafts";
  return fetch(url, { method: isSaved() ? "PUT" : "POST" });
}

// A branch choosing between two methods: three methods for two URLs.
export async function draftNestedMethod(id: string | undefined, force: boolean) {
  const url = id ? `/api/drafts/${id}` : "/api/drafts";
  return fetch(url, { method: id ? (force ? "PUT" : "DELETE") : "POST" });
}
