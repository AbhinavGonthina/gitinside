import { forcePost, remove, serverApi, withExtra } from "./api";

export function listHistory() {
  return serverApi("/history");
}

export function addToHistory(videoId: string) {
  return serverApi("/history", { method: "POST", body: JSON.stringify({ videoId }) });
}

export function replaceHistory() {
  return forcePost("/history", { method: "DELETE" });
}

export function clearHistory() {
  return remove("/history");
}

export function readHistory() {
  return remove("/history", { method: "GET" });
}

// Control: options the analyzer can't see, so the method stays unknown.
export function syncHistory(init: RequestInit) {
  return serverApi("/history", init);
}

// Control: the helper spreads a call's result after the caller's options.
export function touchHistory() {
  return withExtra("/history", { method: "POST" });
}
