# fetch-event-source

Tests: `fetchEventSource(url, init)` from `@microsoft/fetch-event-source` (anything-llm's chat streams, M9.1a6) read as a `fetch` in the same service as an Express app. `streamChat`'s `` `${API_BASE}/workspace/${slug}/stream-chat` `` with `method: "POST"` ⇒ `POST /api/workspace/:slug/stream-chat` (`exact`); `watchEmbedding`'s init sets no `method`, so it's `GET /api/workspace/:slug/embed-progress` (`exact`), the library's default. The `onmessage` callbacks aren't requests.
