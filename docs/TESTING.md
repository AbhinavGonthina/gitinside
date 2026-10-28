# Testing strategy

These are mandatory standards. Nobody reviews each autopilot step, so the tests are the review. Decisions: D10.1–D10.4.

## Rules

1. **Tests first where practical:** write the failing test or fixture, then the implementation.
2. **Never commit red:** full relevant suite + lint + typecheck must be green before every commit.
3. **Never weaken a test to make it pass.** No deleting, skipping (`.skip`, `.only`), loosening assertions, or regenerating golden files to hide a regression. If a test is genuinely wrong, fix it in its own commit and explain why in the body.
4. **Golden files change only on purpose.** Regenerate with `UPDATE_GOLDEN=1` and explain the diff in the commit body ("route IDs now include method").
5. **Three strikes:** if a task stays red after 3 real fix attempts, revert to the last green commit, log it under Blockers in `PROGRESS.md`, and move on.

## Layers

| Layer | Tool | Where | Runs |
|---|---|---|---|
| Unit | Vitest | `packages/*/src/**/*.test.ts` | every push |
| Golden snapshots | Vitest + fixture repos | `fixtures/<name>/` + `fixtures/<name>/expected.json` | every push |
| Property | fast-check | `packages/diff`, URL normalizer | every push |
| Determinism | Vitest | analyzer: each fixture analyzed twice, `stringifyGraph` bytes compared | every push |
| Integration | Vitest + Supertest, real Redis/Postgres via Docker in CI | `apps/web`, `apps/worker` | every push |
| Component | Storybook stories (every state, light/dark) | `packages/viewer` | every push (build) |
| Visual regression | Playwright screenshots | stories + key screens | every push, Linux CI only |
| E2E | Playwright | `apps/web/e2e` | push to main |
| Security | Vitest + malicious fixtures | `fixtures/malicious/*`, worker extraction | every push |
| Eval / bench | scripts | `eval/`, `bench/` | on demand + milestone gates |

## Fixture repos

Each fixture under `fixtures/` is a small hand-written repo exercising **one** pattern, with an `expected.json` golden graph and a `README.md` stating what it tests. Required set (added in the milestone that needs it):

- **M1:** `express-basic`, `express-nested-routers`, `next-app-router`, `next-pages-api`, `prisma-relations`, `pnpm-monorepo`, `syntax-error`, `no-tsconfig`.
- **M2:** `fetch-template-literal`, `axios-baseurl-instance`, `env-base-heuristic`, `ambiguous-routes`, `wrapper-fetch`, `external-sdk`, `compose-and-env`, `fake-secrets`, `queues-bullmq`. `fixtures.test.ts` also asserts over every fixture that each collected HTTP call has an edge ("no call site dropped") and that no env value or planted secret reaches the output.
- **M6:** `diff-removed-route-still-called` (base and head), `diff-renamed-file`, `diff-changed-method`, `diff-removed-model-field`.
- **Malicious (M5):** `postinstall-script`, `huge-file`, `symlink-escape`, `path-traversal-tar`, `zip-bomb`, `deep-nesting`, `too-many-files` (generated in test, not committed).

Fixtures are never executed: no `npm install`, no scripts. Tests only call the analyzer on the directory.

## Coverage (enforced in CI by Vitest thresholds)

| Package | Lines |
|---|---|
| `packages/analyzer` | ≥ 85% |
| `packages/diff` | ≥ 85% |
| everything else | ≥ 70% |

Coverage is a floor, not a goal. Don't write tests that only touch lines.

## Visual regression

- Screenshots only in Linux CI (Playwright's Docker image) so font rendering is stable. Windows runs skip visual comparison.
- Baselines live in the repo. A change to a baseline must be intentional and mentioned in the commit body.
- Every Storybook story is captured in dark and light (`packages/viewer/visual/`, ADR-0053): baselines are `visual/baselines/<story-id>--<theme>.png`, compared by CI's `visual` job in `mcr.microsoft.com/playwright:v<@playwright/test version>-noble`. Run locally (Linux) with `pnpm --filter @gitinside/viewer build-storybook` then `pnpm --filter @gitinside/viewer visual`.
- To update baselines: run the **Visual baselines** workflow (`gh workflow run visual-baselines.yml`), download its artifact (`gh run download <run> -n visual-baselines -D packages/viewer/visual/baselines`), look at the changed images, and commit them with the reason. Bump the image tag in both workflows whenever `@playwright/test` changes.
- Every UI task also takes light and dark screenshots for the self-critique loop (CLAUDE.md), saved to `docs/milestones/` for review docs.

## Security tests (see SECURITY.md)

These must show that the worker:
- Rejects path traversal and symlinks during extraction.
- Stops at size and file limits.
- Never runs package scripts. The test asserts that no child process other than the analyzer is spawned, and that a sentinel file a postinstall script would create never appears.
- Never writes secret values into the graph.
- Verifies webhook signatures.
- Denies private snapshots to users without access.

## CI (GitHub Actions)

- **On every push:** install (pnpm, cached), lint, typecheck, unit + snapshot + property + determinism + integration + security, coverage thresholds, Storybook build, visual regression.
- **On push to main:** all of the above plus Playwright E2E.
- **Required for M8 PR flow:** CI must pass before autopilot merges a PR.

## Commands

```sh
pnpm test            # all unit/snapshot/property/integration tests via turbo
pnpm coverage        # with thresholds
pnpm typecheck
pnpm lint            # from M1
pnpm e2e             # from M4b
pnpm eval            # from M3
pnpm bench           # from M1/M4b/M6
```
