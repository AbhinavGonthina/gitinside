/** The route is fixed here; `postId` only fills a hole, so the request stays at this call. */
export async function deletePost(postId: string) {
  const res = await fetch(`/api/posts/${postId}`, { method: "DELETE" });
  return res.ok;
}

export const postsApi = {
  read: (postId: string) => fetch(`/api/posts/${postId}`).then((r) => r.json()),
  // `page` only reaches the query string.
  comments: (postId: string, page = 1) =>
    fetch(`/api/posts/${postId}/comments?page=${page}`).then((r) => r.json()),
};

/** Takes the path, so each call is inlined where the path is supplied. */
export function apiGet(path: string) {
  return fetch(`/api${path}`).then((r) => r.json());
}
