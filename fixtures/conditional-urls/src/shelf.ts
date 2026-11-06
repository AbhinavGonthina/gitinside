/** One shelf, or what the reader has open now: `shelfId` only picks between fixed routes. */
export function openShelf(shelfId?: string) {
  const url = shelfId ? `/api/shelves/${shelfId}` : "/api/reading-now";
  return fetch(url).then((r) => r.json());
}

/** A catalog listing: callers give the path, and `version` picks the API version. */
export function catalog(path: string, version?: string) {
  return fetch(version ? `/api/${version}${path}` : `/api${path}`);
}
