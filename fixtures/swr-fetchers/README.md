# swr-fetchers

Tests: SWR calling the repo's fetcher with a hook's key (ADR-0193). `useBook` passes a conditional key (`id ? … : null`: the `null` side makes no request), `useBookPages` a `useSWRInfinite` key function whose query is dropped, and `useAddBook` a `useSWRMutation` fetcher that posts. The home page's `useSWR("/api/shelves")` gives no fetcher, so `_app.tsx`'s `SWRConfig` default applies (`heuristic`); its array key (`["/api/session", "token"]`) stays unresolved at the hook. Each request is drawn from the hook's caller, not from `lib/fetcher.ts`.
