import { loadOrderTotals } from "../db/orders";

export function checkoutTotal(): number {
  return loadOrderTotals().reduce((sum, cents) => sum + cents, 0);
}
