# axios-baseurl-instance

Tests: an `axios.create({ baseURL: "/api" })` instance exported from one file and imported in another. `api.get(`` `/orders/${id}` ``)` ⇒ `GET /api/orders/:id` and `api.post("/orders")` ⇒ `POST /api/orders`, both `exact`, against routes on a router mounted at `/api/orders`.

A second instance's base is an env var with a fallback, trimmed of trailing slashes (`(process.env.API_URL || "/api/").replace(/\/+$/, "")`, M12.1a): the trim can't change a segment, so `trimmed.get(`` `/orders/${id}` ``)` ⇒ `GET /api/orders/:id` at `heuristic`, as the env base without the trim would be.
