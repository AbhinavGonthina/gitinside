# next-connect

Tests: `pages/api` files whose default export is a next-connect router (ADR-0191). `notes/index.ts` uses a repo factory (`apiHandler = () => nc(options).use(mw)`, v0) and a chained `.get(list).post(create)`; `notes/[id].ts` uses v1's `createRouter()` with inline handlers and `export default router.handler(options)`. Each registered method is one route; the page's `PUT` request has no route to match, since the router doesn't register `PUT`. The inline `GET` handler's external fetch is drawn from its route.
