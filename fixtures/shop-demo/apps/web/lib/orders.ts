const API_URL = process.env.NEXT_PUBLIC_API_URL;

/** An API-named env base: `heuristic` against `POST /api/orders` in the api service. */
export async function placeOrder(items: string[]) {
  const res = await fetch(`${API_URL}/api/orders`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
  return res.json();
}

export async function listOrders() {
  const res = await fetch(`${API_URL}/api/orders`);
  return res.json();
}
