const orders = [{ item: "tea" }, { item: "bread" }];

export async function seedOrders(): Promise<void> {
  for (const order of orders) {
    await fetch("http://localhost:4000/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(order),
    });
  }
}

await seedOrders();
