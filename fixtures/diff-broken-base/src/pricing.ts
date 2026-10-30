export function withTax(total: number) {
  return Math.round(total * 1.2);
}

export function quote(total: number) {
  return withTax(total);
}
