/** Listed by `createRouter`'s glob too, but exports no router, so nothing is mounted from it. */
export function total(items: { price: number }[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
