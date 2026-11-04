"use server";

import { db } from "../../lib/db";

export async function listTodos() {
  return db.todo.findMany({ where: { done: false } });
}

export async function createTodo(data: FormData) {
  await db.todo.create({ data: { id: String(data.get("id")), title: String(data.get("title")) } });
}

export async function toggleTodo(state: { done: boolean }, data: FormData) {
  await db.todo.update({ where: { id: String(data.get("id")) }, data: { done: !state.done } });
  return { done: !state.done };
}

export async function deleteTodo(id: string) {
  await db.todo.delete({ where: { id } });
}
