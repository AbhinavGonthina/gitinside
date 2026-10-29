# diff-rename-base / diff-rename-head

A pair for `packages/diff` (M6.3): `diff-rename-head` is this repo one commit later.

- `src/routes/orders.ts` moved to `src/orders/routes.ts` (its folder's only file, so the module moves too), with a doc comment added and `formatTotal` renamed at its call site.
- `formatTotal` in `src/util/format.ts` renamed in place to `formatAmount`; its body is unchanged.
- `src/app.ts` imports the moved file from its new path.

The expected diff: the file, its module, its symbols, and its unresolved `fetch` renamed; `formatTotal` renamed by body; the routes and the edges on renamed nodes following them, not removed + added.
