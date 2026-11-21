# rules-pr

A pull request for the PR bot's architecture rules (M15.1c): `head/` is `base/` one commit later. No `expected.json` here: the worker's diff job test (`apps/worker/src/diffJob.test.ts`) analyzes both sides with the real analyzer.

- Both sides keep the same `.gitinside.yml`: code in `src/ui/` must not depend on `src/db/` (an `error` rule), and `src/ui/` may use `src/shared/`.
- `base/` keeps the rule: `src/ui/page.ts` uses only `src/shared/format.ts`.
- `head/` adds `src/ui/checkout.ts`, which imports and calls `src/db/orders.ts`.

The expected check: one new `ui-not-db` violation (the import and the call from `checkout.ts`), so the Check Run fails; nothing about `page.ts`, which the base already had.
