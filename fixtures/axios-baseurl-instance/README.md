# axios-baseurl-instance

Tests: an `axios.create({ baseURL: "/api" })` instance exported from one file and imported in another. `api.get(`` `/orders/${id}` ``)` ⇒ `GET /api/orders/:id` and `api.post("/orders")` ⇒ `POST /api/orders`, both `exact`, against routes on a router mounted at `/api/orders`.
