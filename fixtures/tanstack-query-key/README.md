# tanstack-query-key

Tests (M5C.3f, ADR-0196's amendment): TanStack Query `queryFn`s that read the URL from the key in their context, against an Express server in the same package.

- `src/queryClient.ts` sets TanStack's documented default query function, `({ queryKey }) => axios.get(`/api${queryKey[0]}`)`, as the `QueryClient`'s `defaultOptions.queries.queryFn`. Each `useQuery` (or `queryOptions`) in `src/queries.ts` with no `queryFn` of its own is read through it with its key, at `heuristic` (which client a hook runs under isn't known statically):
  - `usePosts`: `["/posts"]` ⇒ `GET /api/posts`.
  - `usePost`: `` [`/posts/${postId}`] `` ⇒ `GET /api/posts/:postId`.
  - `statsOptions`: `queryOptions({ queryKey: ["/stats"] })` ⇒ `GET /api/stats`, drawn from where the key is written.
  - `useDrafts`: `["/drafts"]` ⇒ `GET /api/drafts`, which no route serves, so it stays unresolved.
- `useTodos` writes its `queryFn` at the hook and destructures the key's elements (`({ queryKey: [base, id, kind] })`): `["/api/users", userId, "todos"]` ⇒ `GET /api/users/:userId/todos`, `exact`.
