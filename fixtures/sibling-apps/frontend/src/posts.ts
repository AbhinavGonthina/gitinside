import api from "@/lib/api";

export function loadPost(id: string) {
  return api.get(`/posts/${id}`);
}

export function createPost(title: string) {
  return api.post("/posts", { title });
}
