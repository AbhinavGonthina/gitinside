# wrapper-fetch

Tests: one-level wrapper inlining. `request(path, init)` calls `fetch(BASE + path, { method: "GET", ...init })`; `listProjects` ⇒ `GET /api/projects` and `createProject` ⇒ `POST /api/projects` (the spread's `method` wins), both `exact` and owned by the callers. `requestVia(url)` forwards its parameter to the wrapper `requestRaw`, so that request is `unresolved` with `WRAPPER_DEPTH` instead of following a second level.
