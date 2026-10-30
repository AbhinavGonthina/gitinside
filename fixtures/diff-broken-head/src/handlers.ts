import type { Request, Response } from "express";
import { prisma } from "./db.js";

export async function listOrders(_req: Request, res: Response) {
  res.json(await prisma.order.findMany());
}

export async function createOrder(req: Request, res: Response) {
  res.json(await prisma.order.create({ data: { total: Number(req.body.total) } }));
}

export async function invoiceTotal(orderId: number) {
  const invoices = await prisma.invoice.findMany({ where: { orderId } });
  return invoices.reduce((sum, invoice) => sum + invoice.amount, 0);
}

export async function openOrders() {
  return prisma.order.findMany({ where: { status: "open" } });
}
