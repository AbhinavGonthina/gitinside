import { formatPrice } from "../shared/format";

export function renderTotal(cents: number): string {
  return `Total: ${formatPrice(cents)}`;
}
