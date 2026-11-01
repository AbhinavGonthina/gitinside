# fixed-url-helpers

Tests (M5A.3j): only a parameter that reaches the URL's leading part makes a function a wrapper. `deletePost(postId)` and `postsApi.read` / `postsApi.comments` fix their routes themselves (`postId` fills a later hole, `page` the query), so each request stays at its own `fetch`, owned by the helper: `DELETE /api/posts/:postId`, `GET /api/posts/:postId`, `GET /api/posts/:postId/comments`, all `exact`. `apiGet(path)` takes the path (`/api${path}`), so its call in `loadAuthors` is inlined there: `GET /api/authors`.
