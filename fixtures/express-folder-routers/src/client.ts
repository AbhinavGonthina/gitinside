export async function loadUser(id: string) {
  return fetch(`/api/v1/users/${id}`).then((r) => r.json());
}

export async function placeOrder(items: { price: number }[]) {
  return fetch("/api/v1/orders", { method: "POST", body: JSON.stringify({ items }) });
}

export async function dailyReport() {
  return fetch("/legacy/reports/daily").then((r) => r.json());
}

export async function health() {
  return fetch("/health");
}
