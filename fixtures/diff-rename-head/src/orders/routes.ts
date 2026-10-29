import { Router } from "express";
import { formatAmount } from "../util/format.js";

/** Order routes, mounted at /api/orders. */
export const orders = Router();

export function listOrders(_req: unknown, res: { json(body: unknown): void }) {
  const rows = [
    { id: "a1", total: 1250 },
    { id: "b2", total: 990 },
  ];
  res.json(rows.map((row) => ({ id: row.id, total: formatAmount(row.total) })));
}

export async function createOrder(req: { body: { sku: string } }, res: { status(code: number): { end(): void } }) {
  await fetch(process.env.WAREHOUSE + "/reserve/" + req.body.sku, { method: "POST" });
  res.status(201).end();
}

orders.get("/", listOrders);
orders.post("/", createOrder);
