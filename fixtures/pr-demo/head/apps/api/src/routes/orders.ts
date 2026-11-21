import { Router } from "express";
import { refundOrder } from "../billing/stripe";
import { createOrder, listOrders } from "../orders/handlers";

export const orders = Router();

orders.get("/", listOrders);
orders.post("/", createOrder);

orders.post("/:id/refund", async (req, res) => {
  await refundOrder(Number(req.params.id));
  res.status(204).end();
});
