import { listOrders } from "../../lib/orders";

export default async function Orders() {
  const orders = await listOrders();
  return <ul>{orders.length} orders</ul>;
}
