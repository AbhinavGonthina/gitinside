import type { Request, Response } from "express";
import { chargeOrder } from "../billing/stripe";
import { prisma } from "../db";

export async function listOrders(_req: Request, res: Response) {
  const orders = await prisma.order.findMany({ select: { id: true, total: true } });
  res.json(orders);
}

export async function createOrder(req: Request, res: Response) {
  const order = await prisma.order.create({
    data: { total: req.body.total, status: "pending" },
  });
  await chargeOrder(order.id, order.total);
  res.status(201).json(order);
}
