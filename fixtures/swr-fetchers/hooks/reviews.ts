import useSWR from "swr";

interface Review {
  stars: number;
  text: string;
}

/** SWR's documented fetcher: the hook's key reaches `fetch` through the rest parameter. */
export const fetchJson = (...args: Parameters<typeof fetch>) =>
  fetch(...args).then((res) => res.json());

export function useReviews(bookId: string) {
  return useSWR<Review[]>(`/api/books/${bookId}/reviews`, fetchJson);
}

export function useAuthor(name: string | null) {
  return useSWR<{ name: string; born: number }>(name && `/api/authors/${name}`, (url: string) =>
    fetch(url).then((res) => res.json()),
  );
}
