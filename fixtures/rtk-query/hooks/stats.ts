import { useQuery } from "@tanstack/react-query";

export function useStats(range: string) {
  const totals = useQuery({
    queryKey: ["stats", range],
    queryFn: () => fetch(`/api/stats?range=${range}`).then((r) => r.json()),
  });
  const trend = useQuery({
    queryKey: ["/api/stats/trend", range],
    queryFn: ({ queryKey }) => fetch(String(queryKey[0])).then((r) => r.json()),
  });
  return { totals, trend };
}
