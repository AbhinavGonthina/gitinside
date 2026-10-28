"use client";

import { placeOrder } from "../../lib/orders";

export default function Checkout() {
  return <button onClick={() => placeOrder(["sku-1"])}>Place order</button>;
}
