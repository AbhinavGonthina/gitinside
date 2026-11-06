const API = "/api";

export function notesPanel(noteId: string) {
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${API}${path}`, init);
    return res.json();
  };
  // Its parameter fills a later segment, so the route is fixed here: not a wrapper over `call`.
  const pin = (id: string) => call(`/notes/${id}/pin`, { method: "PUT" });
  return {
    list: () => call("/notes"),
    add: () => call("/notes", { method: "POST" }),
    pinCurrent: () => pin(noteId),
    remove: () => call(`/notes/${noteId}`, { method: "DELETE" }),
  };
}
