export function withTax(total: number, rate: number) {
  return Math.round(total * (1 + rate));
}

export function quote(total: number) {
  return withTax(total);
}
