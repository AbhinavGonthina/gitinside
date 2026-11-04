import { queryOptions, useQuery } from "@tanstack/react-query";

// The client's default queryFn reads the path from each key.
export function usePosts() {
  return useQuery({ queryKey: ["/posts"] });
}

export function usePost(postId: string) {
  return useQuery({ queryKey: [`/posts/${postId}`], enabled: !!postId });
}

export const statsOptions = queryOptions({ queryKey: ["/stats"] });

// No route serves this one.
export function useDrafts() {
  return useQuery({ queryKey: ["/drafts"] });
}

// A queryFn written at the hook, destructuring the key's elements.
export function useTodos(userId: string) {
  return useQuery({
    queryKey: ["/api/users", userId, "todos"],
    queryFn: ({ queryKey: [base, id, kind] }) =>
      fetch(`${base}/${id}/${kind}`).then((res) => res.json()),
  });
}
