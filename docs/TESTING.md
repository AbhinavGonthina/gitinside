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
| Property | fast-check | `packages/diff`, the viewer's diff overlay (on diff's generators), URL normalizer | every push |
| Determinism | Vitest | analyzer: each fixture analyzed twice, `stringifyGraph` bytes compared | every push |
| Integration | Vitest over real HTTP (the worker's `POST /run` pushed by a fake Cloud Tasks, a fake GitHub, a fake S3, a fake Google), real Postgres in CI | `apps/web`, `apps/worker`, `packages/db` (PGlite locally, CI's Postgres service when `TEST_DATABASE_URL` is set; ADR-0057) | every push |
| Component | Storybook stories (every state, light/dark) | `packages/viewer` | every push (build) |
| Visual regression | Playwright screenshots | stories + key screens | every push, Linux CI only |
| E2E | Playwright | `apps/web/e2e`: the unconfigured site, and the explorer on a seeded PGlite database (ADR-0132) | push to main |
| Security | Vitest + malicious fixtures | `fixtures/malicious/*`, worker extraction | every push |
| Container | `node infra/gcp/check.mjs` (Docker, Linux CI job `worker-image`) | the worker image run as Cloud Run runs it: non-root, nothing writable outside `/tmp`, signed `/run`, a golden analysis, SIGTERM (ADR-0150) | every push |
| Deploy config | Vitest | `infra/gcp/{service,queue,iam}.json` against the code's limits and ADR-0111's guardrails (`apps/web/lib/gcpConfig.test.ts`, ADR-0151) | every push |
| Live guardrails | `pnpm verify-guardrails` (`infra/gcp/verify.mjs`), tested against a fake Google (`apps/web/lib/gcpVerify.test.ts`) | the live Google Cloud project read back against `infra/gcp`: services, queue, IAM, budget and kill switch, nothing billed by the hour, registry size (ADR-0171) | the script: by hand after setup or a console change; its tests: every push |
| Eval / bench | scripts | `eval/`, `bench/` | on demand + milestone gates |

## Fixture repos

Each fixture under `fixtures/` is a small hand-written repo exercising **one** pattern, with an `expected.json` golden graph and a `README.md` stating what it tests. Required set (added in the milestone that needs it):

- **M1:** `express-basic`, `express-nested-routers`, `next-app-router`, `next-pages-api`, `prisma-relations`, `pnpm-monorepo`, `syntax-error`, `no-tsconfig`.
- **M2:** `fetch-template-literal`, `axios-baseurl-instance`, `env-base-heuristic`, `ambiguous-routes`, `wrapper-fetch`, `external-sdk`, `compose-and-env`, `fake-secrets`, `queues-bullmq`. `fixtures.test.ts` also asserts over every fixture that each collected HTTP call has an edge ("no call site dropped") and that no env value or planted secret reaches the output.
- **M6:** pairs, each a base and a head one commit apart. `diff-rename-base`/`-head` (M6.3): a moved file and folder, renamed symbols. `diff-broken-base`/`-head` (M6.4a, M6.4b): a removed route still called, a changed method, a deleted file still imported, a removed model still read, a function that gained a required parameter, a removed model field still filtered on, and a route removed with its only caller (not broken).
- **Malicious (M5):** `postinstall-script`, `huge-file`, `symlink-escape`, `path-traversal-tar`, `zip-bomb`, `deep-nesting`, `too-many-files`. Only `fixtures/malicious/postinstall-script/` is a folder; the rest are built byte by byte in `apps/worker/src/security.test.ts` (`fixtures/malicious/README.md` lists each case and its expected outcome; ADR-0076).

Fixtures are never executed: no `npm install`, no scripts. Tests only call the analyzer on the directory.

## Coverage (enforced in CI by Vitest thresholds)

| Package | Lines |
|---|---|
| `packages/analyzer` | ≥ 85% |
| `packages/diff` | ≥ 85% |
| everything else | ≥ 70% |

Coverage is a floor, not a goal. Don't write tests that only touch lines.

## E2E

- `pnpm turbo run build --filter=@gitinside/web`, then `pnpm --filter @gitinside/web e2e` (Windows or Linux, no Docker). Two servers of the production build: `unconfigured` (no database or worker; `site.e2e.ts`) and `seeded`, reading PGlite served over Postgres's wire protocol with one finished analysis of `fixtures/shop-demo` (`database.ts`; `explorer.e2e.ts` drives load, drill down, select, trace, the code preview, and Open on GitHub). The browser's graph and GitHub reads are answered by the tests (ADR-0132). Any console error or warning, a CSP violation included, fails a test.

## Visual regression

- Screenshots only in Linux CI (Playwright's Docker image) so font rendering is stable. Windows runs skip visual comparison.
- Baselines live in the repo. A change to a baseline must be intentional and mentioned in the commit body.
- Every Storybook story is captured in dark and light (`packages/viewer/visual/`, ADR-0053): baselines are `visual/baselines/<story-id>--<theme>.png`, compared by CI's `visual` job in `mcr.microsoft.com/playwright:v<@playwright/test version>-noble`. Run locally (Linux) with `pnpm --filter @gitinside/viewer build-storybook` then `pnpm --filter @gitinside/viewer visual`.
- To update baselines: run the **Visual baselines** workflow (`gh workflow run visual-baselines.yml`), download its artifact (`gh run download <run> -n visual-baselines -D packages/viewer/visual/baselines`), look at the changed images, and commit them with the reason. Bump the image tag in both workflows whenever `@playwright/test` changes.
- The website's key screens (landing, the repo page's diagram, a selection, a trace) in dark and light (`apps/web/e2e/screens.visual.ts`, ADR-0133): baselines are `apps/web/e2e/baselines/<screen>--<theme>.png`, compared by CI's `web-e2e` job on the seeded server. The same workflow captures them (artifact `web-visual-baselines`, `-D apps/web/e2e/baselines`).
- Every UI task also takes light and dark screenshots for the self-critique loop (CLAUDE.md), saved to `docs/milestones/` for review docs.

## Security tests (see SECURITY.md)

`apps/worker/src/security.test.ts` runs each malicious case through the whole job (fake GitHub ⇒ extraction ⇒ the sandboxed child ⇒ the stored graph) at the production limits; the unit tests in `extract.test.ts`, `runner.test.ts`, and the analyzer's `inventory.test.ts` cover each layer alone. Its 20,001-file case takes about 2.5 minutes on Windows (per-file cost of NTFS) and seconds on Linux. Together they must show that the worker:
- Rejects path traversal and symlinks during extraction.
- Stops at size and file limits.
- Never runs package scripts. The test asserts that no child process other than the analyzer is spawned, and that a sentinel file a postinstall script would create never appears.
- Never writes secret values into the graph.
- Verifies webhook signatures (M8.8).
- Denies private snapshots to users without access (M8.8).

`apps/web/lib/security.test.ts` (M8.8) covers the last two, and the website's other promises that span routes, with two tenants at once (installations 41 and 52, each with a private repo named `Shop` analyzed at the same commit, a stored pull request diff, a code file, and a queued job):
- **Cross-tenant isolation:** each tenant's member reads all of their own data on every private surface (graph, stored diff, code file, job and its events, permalink page), and gets exactly a never-analyzed name's answers for the other tenant's, with no object read and no file asked of GitHub. Signed out, a dead cookie, and sign-in not configured answer the same. The token route never mints one tenant's job a token through the other's installation, though GitHub alone couldn't tell the two `Shop`s apart.
- **Revocation:** access removed on GitHub is refused on every surface once the 60 s check is old (a code file at once, since GitHub reads it with the user's token); a revoked authorization ends the session; an uninstall deletes that tenant's rows and objects at once and leaves the other's answers unchanged (only the global queue position moves).
- **Signatures:** the webhook and the token route refuse an unsigned request, one signed with another of our secrets or for another path, body, or time, before anything is read or written, then accept the genuine one; a token request's signature never passes the worker's job check.
- **Every API route is listed** with the test of its guard, so a new route fails until it's classified.
Mutation-checked: removing the graph's access check, the job route's, the token route's installation match, or the webhook's signature comparison each turns it red.

## CI (GitHub Actions)

- **On every pull request and push to main:** install (pnpm, cached), lint, typecheck, unit + snapshot + property + determinism + integration + security, coverage thresholds, Storybook build, visual regression, the worker image check, and Playwright E2E (`check`, `worker-image`, `visual`, `web-e2e` in `.github/workflows/ci.yml`).
- **On push to main only:** once every job is green and the worker image's inputs changed, the `deploy` job ships the worker and kill switch to Cloud Run, keyless (`infra/gcp/deploy.mjs`, checked by `apps/web/lib/gcpDeploy.test.ts`, ADR-0170).
- **PR flow (since M8.9, ADR-0247):** every task lands through a `task/<id>` PR; autopilot merges it (merge commit) only when every CI check is green and GitInside Bot's `GitInside` Check Run has posted and been read (or, until the App is installed on this repo, after CI alone, saying so). See CLAUDE.md §5.

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
