import axios from "axios";
import { QueryClient } from "@tanstack/react-query";

/** TanStack Query's documented default query function: the key's first element is the path. */
const defaultQueryFn = async ({ queryKey }: { queryKey: readonly unknown[] }) => {
  const { data } = await axios.get(`/api${queryKey[0]}`);
  return data;
};

export const queryClient = new QueryClient({
  defaultOptions: { queries: { queryFn: defaultQueryFn } },
});
