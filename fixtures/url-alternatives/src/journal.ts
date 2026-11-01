import axios from "axios";

const API = import.meta.env.VITE_API_PATH;

/** A ternary held in a `const`: both routes are requested from this one call. */
export async function loadEntries(topic: string, featuredOnly: boolean) {
  const endpoint = featuredOnly ? "/api/entries/featured" : `/api/entries/topics/${topic}`;
  const { data } = await axios.get(API + endpoint);
  return data;
}

/** A `let` reassigned in a branch: either route, depending on who asks. */
export async function removeEntry(entryId: string, moderator: boolean) {
  let url = `/api/entries/${entryId}`;
  if (moderator) {
    url = `/api/entries/moderation/${entryId}`;
  }
  await axios.delete(API + url);
}

/** A ternary that only adds a query: one route. */
export async function loadArchive(page?: number) {
  const { data } = await axios.get(`${API}/api/archive${page ? "?page=" + page : ""}`);
  return data;
}

/** A wrapper whose caller passes a ternary: one request per branch, at the caller. */
export function getJson(path: string) {
  return fetch(`${API}${path}`).then((response) => response.json());
}

export function loadMine(drafts: boolean, entryId: string) {
  return getJson(drafts ? "/api/drafts" : `/api/entries/${entryId}`);
}
