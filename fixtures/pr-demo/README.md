# pr-demo

The demo pull request for the PR bot (M16.1): a small shop (`@acme/web` on Next.js, `@acme/api` on Express with Prisma and Stripe, Postgres in `docker-compose.yml`), built from `shop-demo`. `head/` is `base/` one commit later. It becomes a public demo repo whose `main` is `base/` and whose one open pull request is `head/`, left open with no further pushes (each push is a diff job, ADR-0295; ADR-0323), so anyone can see what the bot posts without installing it.

Both sides keep the same `.gitinside.yml` (docs/RULES.md): routes don't depend on billing, only the api touches Postgres, and outside calls go only to `api.stripe.com` (a warning).

The pull request ("Version the orders API") does three ordinary things that CI wouldn't catch:

- mounts the orders router at `/api/v2/orders` instead of `/api/orders`, while the web's `placeOrder` and `listOrders` still request `/api/orders`: **2 broken connections** (route changed);
- adds `POST /:id/refund` straight in `routes/orders.ts`, which imports and calls `refundOrder` from `billing/stripe.ts`: **2 `routes-skip-billing` errors** (the import and the call), so the Check Run fails;
- posts each new order to `hooks.slack.com` from `createOrder`: **1 `known-hosts` warning**.

No `expected.json` here (no golden, digest, or analyzer version change). The worker's diff job test (`apps/worker/src/diffJob.test.ts`, "posts the demo PR's …") runs the real analyzer on both sides and checks the comment and Check Run. Diff's fixture rename check skips this folder, like the `diff-*` pairs.
