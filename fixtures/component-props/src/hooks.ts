interface ChatQueryOptions {
  apiUrl: string;
  limit: number;
}

// A hook taking its options destructured: `apiUrl` leads the URL, `limit` only the query.
export function useChatQuery({ apiUrl, limit }: ChatQueryOptions) {
  const load = async () => {
    const res = await fetch(`${apiUrl}?limit=${limit}`);
    return res.json();
  };
  return load;
}
