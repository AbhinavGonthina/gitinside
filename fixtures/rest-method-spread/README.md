# rest-method-spread

Tests (M5C.7a, ADR-0033 and ADR-0032 amendments): a wrapper that forwards the caller's init through a rest element, against an Express server in the same package.

- `sendJson(path, init = {})` destructures `const { payload, headers, ...options } = init` and sends `fetch(path, { ...options, … })`, so `options` carries the caller's `method`: `readToken` ⇒ `GET /api/tokens` (no init: the default `{}`), `storeToken` ⇒ `PUT /api/tokens`, `dropToken` ⇒ `DELETE /api/tokens`.
- `postForm(path, { method, ...rest })` takes `method` out of `rest` in its parameter, so `{ method: "POST", ...rest }` always posts: `uploadAvatar` passes `PUT` and still ⇒ `POST /api/avatar`.
- `readProfile(init)` passes its own parameter on, so the method isn't read, but only `GET /api/profile` exists at that path: one `heuristic` edge.
- `tokenRequest(init)` does the same at `/api/tokens`, where `GET`, `PUT`, and `DELETE` routes all match: only the method would pick one, so it's an unresolved node (`AMBIGUOUS`) instead of three edges.

All matches with a read method are `exact` (one service).
