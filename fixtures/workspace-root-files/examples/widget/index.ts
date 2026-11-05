export function showOrderCount(target: HTMLElement): void {
  void fetch("/api/orders/count")
    .then((res) => res.json())
    .then((body: { count: number }) => {
      target.textContent = String(body.count);
    });
}
