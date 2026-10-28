# fetch-template-literal

Tests: `fetch` with template literals in the same service as an Express app. `` `/api/users/${id}` `` ⇒ `GET /api/users/:id` (`exact`); `` `/api/users?limit=${limit}` `` ⇒ `GET /api/users` (`exact`, query dropped); `"/api/teams"` matches no route ⇒ an `unresolved` node with `NO_MATCHING_ROUTE` (the head side of "removed route still called"). A top-level `fetch` is drawn from the file node.
