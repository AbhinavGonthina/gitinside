# env-base-heuristic

Tests: an env-var URL base across services. `@env/web` calls `${NEXT_PUBLIC_API_URL}/users/{}` (through a module const) and `${NEXT_PUBLIC_API_URL}/users/me`; both are `heuristic` edges into `@env/api`, and `/users/me` picks the literal route over `/users/:id`. `${ANALYTICS_HOST}/users/{}` isn't named like an API base, so it is an `unresolved` node instead of a guess.
