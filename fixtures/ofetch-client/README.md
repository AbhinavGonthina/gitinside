# ofetch-client

Tests (M5C.3c, ADR-0205): requests made with [ofetch](https://github.com/unjs/ofetch) against an Express server in the same package.

- `api = ofetch.create({ baseURL: "/api" })`: `api("/users")` ⇒ `GET /api/users`, `` api(`/users/${id}`) `` ⇒ `GET /api/users/:id`, `api.raw("/users", { method: "POST" })` ⇒ `POST /api/users`.
- `$fetch` with its own `baseURL` and a lowercase method ⇒ `DELETE /api/users/:id`.
- `v2 = api.create({ baseURL: "/api/v2" })` replaces the parent's base ⇒ `GET /api/v2/stats`.
- `poster = api.create({ method: "POST" })` keeps `/api` and posts by default ⇒ `POST /api/auth/login`; `poster("/events")` matches no route and stays unresolved.
- `ofetch("/api/health", { baseURL: "/api" })` ⇒ `GET /api/health`: ofetch's `withBase` leaves a URL already under the base alone (axios's join would give `/api/api/health`).
- `src/local.ts` declares its own function `ofetch`, which isn't a request.

All matches are `exact` (one service).
