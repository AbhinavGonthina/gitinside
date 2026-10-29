import { formatCents } from "./legacy.js";

export async function loadOrders() {
  return (await fetch("/api/orders")).json();
}

export async function placeOrder(total: number) {
  return fetch("/api/orders", { method: "POST", body: JSON.stringify({ total }) });
}

export async function cancelOrder(id: number) {
  return fetch(`/api/orders/${id}`, { method: "DELETE" });
}

export async function ping() {
  return fetch("/api/health");
}

export function label(cents: number): string {
  return formatCents(cents);
}
