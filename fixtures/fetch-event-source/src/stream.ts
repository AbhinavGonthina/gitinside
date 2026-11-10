import { fetchEventSource } from "@microsoft/fetch-event-source";

const API_BASE = "/api";

export async function streamChat(slug: string, message: string, onChunk: (data: string) => void) {
  const ctrl = new AbortController();
  await fetchEventSource(`${API_BASE}/workspace/${slug}/stream-chat`, {
    method: "POST",
    body: JSON.stringify({ message }),
    signal: ctrl.signal,
    onmessage(event) {
      onChunk(event.data);
    },
  });
}

export function watchEmbedding(slug: string) {
  return fetchEventSource(`${API_BASE}/workspace/${slug}/embed-progress`, {
    openWhenHidden: true,
    onmessage() {},
  });
}
