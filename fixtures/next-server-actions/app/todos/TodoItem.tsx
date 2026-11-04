"use client";

import { useActionState } from "react";
import { deleteTodo, listTodos, toggleTodo } from "./actions";

export function TodoItem({ id }: { id: string }) {
  const [state, toggle] = useActionState(toggleTodo, { done: false });
  return (
    <form action={toggle}>
      <input type="hidden" name="id" value={id} />
      <button type="submit">{state.done ? "Undo" : "Done"}</button>
      <button formAction={deleteTodo.bind(null, id)}>Delete</button>
      <button type="button" onClick={() => void listTodos()}>
        Refresh
      </button>
    </form>
  );
}
