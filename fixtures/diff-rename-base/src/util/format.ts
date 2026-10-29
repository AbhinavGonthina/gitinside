export function formatTotal(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `$${whole}.${rest}`;
}

export function formatCount(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}
