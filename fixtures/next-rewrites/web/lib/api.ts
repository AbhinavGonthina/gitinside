/** Under `basePath`: the app's own `GET /api/items`. */
export async function listItems() {
  const res = await fetch("/shop/api/items");
  return res.json();
}

/** A dynamic route serves it before the `fallback` rewrite is tried. */
export async function getItem(id: string) {
  const res = await fetch(`/shop/api/items/${id}`);
  return res.json();
}

/** Without `basePath`, nothing in the app serves it: unresolved, with a hint. */
export async function listItemsUnprefixed() {
  const res = await fetch("/api/items");
  return res.json();
}

/** `beforeFiles`: rewritten to the app's own `/shop/api/items`. */
export async function listLegacyItems() {
  const res = await fetch("/shop/legacy/items");
  return res.json();
}

/** `afterFiles` to the Express server: `GET /users/:id`, not its `/backend/…` decoy. */
export async function getUser(id: string) {
  const res = await fetch(`/shop/backend/users/${id}`);
  return res.json();
}

/** `afterFiles` to an outside API. */
export async function forecast(city: string) {
  const res = await fetch(`/shop/weather/${city}`);
  return res.json();
}

/** `basePath: false`: the source isn't under `/shop`. */
export async function status() {
  const res = await fetch("/status");
  return res.json();
}

/** Nothing in the app serves it, so the `fallback` rewrite sends it to the Express server. */
export async function listOrders() {
  const res = await fetch("/shop/orders");
  return res.json();
}
