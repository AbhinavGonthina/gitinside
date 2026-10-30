# diff-broken-base / diff-broken-head

A pair for `packages/diff` (M6.4): `diff-broken-head` is this repo one commit later, with connections broken on purpose.

- `POST /api/orders` became `PUT /api/orders` (same handler), but `placeOrder` in `src/client.ts` still POSTs: broken, `ROUTE_CHANGED`.
- `DELETE /api/orders/:id` and its handler were removed, but `cancelOrder` still calls it: broken, `TARGET_REMOVED`.
- `src/legacy.ts` was deleted, but `src/client.ts` still imports it: broken, `TARGET_REMOVED`.
- The `Invoice` model was removed from `schema.prisma`, but `invoiceTotal` still reads it: broken, `TARGET_REMOVED`.
- `withTax` in `src/pricing.ts` gained a required `rate` parameter, but `quote` still passes one argument: broken, `PARAMETERS_ADDED` (M6.4b).
- `Order.status` was removed from `schema.prisma`, but `openOrders` still filters on it: broken, `FIELD_REMOVED` (M6.4b). `listOrders` and `createOrder` read and write `Order` without naming `status`: not broken.
- `GET /api/health` was removed together with its only caller, `ping`: removed, not broken.

The expected diff lists exactly those six broken connections, each with its head call site.
