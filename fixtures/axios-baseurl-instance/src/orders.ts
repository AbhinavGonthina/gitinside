import { api } from "./api";

export async function getOrder(id: string) {
  const { data } = await api.get(`/orders/${id}`);
  return data;
}

export async function createOrder(order: { sku: string }) {
  await api.post("/orders", order);
}
