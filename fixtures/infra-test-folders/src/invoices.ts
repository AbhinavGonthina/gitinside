import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function invoiceTotal(customer: string): Promise<number> {
  const rows = await prisma.invoice.findMany({ where: { customer } });
  return rows.reduce((sum, row) => sum + row.cents, 0);
}
