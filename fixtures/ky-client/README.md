# ky-client

Tests (M5C.3e, ADR-0207): requests made with [ky](https://github.com/sindresorhus/ky) against an Express server in the same package.

- `api = ky.create({ prefixUrl: "/api" })` (ky 1): `api.get("notes")` ⇒ `GET /api/notes`, `` api(`notes/${id}`) `` ⇒ `GET /api/notes/:noteId`, `` api.put(`notes/${id}`) `` ⇒ `PUT /api/notes/:noteId`.
- `writer = api.extend({ method: "post" })` keeps `/api` and posts by default ⇒ `POST /api/notes`; `` writer(`notes/${id}/archive`) `` matches no route and stays unresolved.
- `ky.post("session", { prefix: "/api" })` (ky 2's `prefix` on the call) ⇒ `POST /api/session`.
- `v1 = ky.create({ baseUrl: "/api/v1/" })` (ky 2): `v1.get("tags")` ⇒ `GET /api/v1/tags`, and `v1("/status")` ⇒ `GET /status`, since a root-relative URL keeps only the base's origin.
- `api.get("/notes")`: ky 1 throws on a URL starting with `/` under a `prefixUrl`, so it's unresolved with that reason.

All matches are `exact` (one service).
