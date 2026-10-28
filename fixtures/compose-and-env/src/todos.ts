import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export function listTodos() {
  return prisma.todo.findMany();
}
