import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import useSWRMutation from "swr/mutation";
import { addToShelf, fetcher } from "../lib/fetcher";

interface Book {
  id: string;
  title: string;
}

export function useBook(id: string | undefined) {
  return useSWR<Book>(id ? `/api/books/${id}` : null, fetcher);
}

const PAGE_SIZE = 20;

function pageKey(index: number, previous: Book[] | null) {
  if (previous && previous.length === 0) return null;
  return `/api/books?page=${index}&limit=${PAGE_SIZE}`;
}

export function useBookPages() {
  return useSWRInfinite<Book[]>(pageKey, fetcher);
}

export function useAddBook() {
  return useSWRMutation("/api/books", addToShelf);
}
