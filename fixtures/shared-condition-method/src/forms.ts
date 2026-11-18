// agentboard-ce's and relay-status-monitor's forms pick the URL and the method with the same
// condition, so each URL goes with its own method.

export function agentForm(agentId?: string) {
  const isEditing = !!agentId;
  const onSubmit = async (data: object) => {
    const url = isEditing ? `/api/agents/${agentId}` : "/api/agents";
    const method = isEditing ? "PUT" : "POST";
    return fetch(url, { method, body: JSON.stringify(data) });
  };
  return onSubmit;
}

export async function saveKey({
  upstreamId,
  keyData,
}: {
  upstreamId: string;
  keyData?: { id: string };
}) {
  const url = keyData
    ? `/api/upstreams/${upstreamId}/keys/${keyData.id}`
    : `/api/upstreams/${upstreamId}/keys`;
  return fetch(url, { method: keyData ? "PUT" : "POST" });
}

// A `!` flips the pairing: a new note is the collection's `POST`.
export async function saveNote(id: string | undefined, body: string) {
  const isNew = !id;
  const url = isNew ? "/api/notes" : `/api/notes/${id}`;
  return fetch(url, { method: !isNew ? "PUT" : "POST", body });
}

// The whole init chosen by the same condition.
export async function saveProject(id: string | null) {
  const url = !id ? "/api/projects" : `/api/projects/${id}`;
  const init = id ? { method: "PUT" } : { method: "POST" };
  return fetch(url, init);
}

// A helper's own parameter chooses both, and its caller passes a value it can't read: the
// requests are placed at the caller, still paired.
export function save(base: string, id?: string) {
  const url = id ? `${base}/${id}` : base;
  return fetch(url, { method: id ? "PUT" : "POST" });
}

export const saveDraft = (id?: string) => save("/api/drafts", id);
