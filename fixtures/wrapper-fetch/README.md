# wrapper-fetch

Tests: wrapper inlining. `request(path, init)` calls `fetch(BASE + path, { method: "GET", ...init })`; `listProjects` ⇒ `GET /api/projects` and `createProject` ⇒ `POST /api/projects` (the spread's `method` wins), both `exact` and owned by the callers. `requestVia(url)` passes its parameter on to the wrapper `requestRaw`, so it's a wrapper over a wrapper (M5C.7f): `legacyProjects` ⇒ `GET /api/projects` at its call to `requestVia`. Until M5C.7f that request was `unresolved` with `WRAPPER_DEPTH`; `wrapper-chain` covers the deeper levels.
