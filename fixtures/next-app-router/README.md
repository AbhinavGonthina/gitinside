# next-app-router

Tests: app router pages, a route group `(shop)`, a dynamic segment `[id]`, and a `route.ts` exporting GET and POST. The route's font, `fetch(new URL("../../../assets/Inter-Regular.ttf", import.meta.url))`, is a file bundled with the module, so it is unresolved as `NO_MATCHING_ROUTE` saying so, not `DYNAMIC_URL` (M9.1a4).
