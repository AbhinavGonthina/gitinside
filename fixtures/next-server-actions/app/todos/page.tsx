import { createTodo, listTodos } from "./actions";
import { TodoItem } from "./TodoItem";

export default async function TodosPage() {
  // A server component calling an action runs it on the server: a plain call.
  const todos = await listTodos();
  return (
    <main>
      <form action={createTodo}>
        <input name="title" />
        <button type="submit">Add</button>
      </form>
      {todos.map((todo) => (
        <TodoItem key={todo.id} id={todo.id} />
      ))}
    </main>
  );
}
