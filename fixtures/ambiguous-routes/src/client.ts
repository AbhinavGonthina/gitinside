/** Both routes can serve this literal path equally well: AMBIGUOUS, linked to both. */
export async function acmeItems() {
  const res = await fetch("/v1/acme/items");
  return res.json();
}

/** A hole can't be the literal `acme`, so only `/v1/:org/items` matches. */
export async function orgItems(org: string) {
  const res = await fetch(`/v1/${org}/items`);
  return res.json();
}
