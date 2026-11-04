# next-server-actions

Tests: Next.js server actions (ADR-0203). `app/todos/actions.ts` is a `"use server"` file whose actions read and write the Prisma `Todo` model. They're called four ways:

- `TodosPage` (a server component) calls `listTodos()` directly: a plain `calls` edge, no label.
- `TodosPage` passes `createTodo` to `<form action>`: React submits it from the browser, so the edge is labeled `server action`.
- `TodoItem` (`"use client"`) passes `toggleTodo` to `useActionState` and `deleteTodo.bind(null, id)` to `<button formAction>`, and calls `listTodos()` in a click handler: all three labeled `server action`.

There are no routes: Next gives an action no URL of its own, so nothing here is an `http` edge.
