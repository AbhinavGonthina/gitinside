import { apiGet, deletePost, postsApi } from "./posts-api";

export async function removePost(id: string) {
  if (await deletePost(id)) console.info(`removed ${id}`);
}

export async function openPost(id: string) {
  const [post, comments] = await Promise.all([postsApi.read(id), postsApi.comments(id, 2)]);
  return { post, comments };
}

export function loadAuthors() {
  return apiGet("/authors");
}
