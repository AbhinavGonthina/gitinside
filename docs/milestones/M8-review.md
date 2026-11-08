# M8 review: sign-in, private repos, PR bot

**Status: draft (M8.10a, 2026-11-08).** The fresh-eyes review's findings are planned as M8.10b–f; M8.10z re-runs the checks, records each finding's outcome, and tags `m8`. · **Range:** `m7..d5b6b70` (M8.1 `e65c1a8` to M8.9 `0cdbc61`, merged in PR #28) · **Checked at:** `d5b6b70`

## What was built

M8 turns the public website into a GitHub App: people sign in, install the App on private repos, see those diagrams only while GitHub says they may, and get a comment plus a Check Run on each pull request. Every private surface answers a refusal exactly as it answers a repo that was never analyzed.

| Piece | Where | What it does |
|---|---|---|
| App registration | ADR-0220, planning #23 | `gitinside-bot` (ID 5659224): ADR-0009's permissions only, Pull request and Push events, routes and secret names fixed |
| Sign-in and sessions | `apps/web/lib/session.ts`, `authRoute.ts` (ADR-0221–0223) | The App's user authorization with state + PKCE in a signed 10-minute cookie; `__Host-` session cookie whose SHA-256 keys the row; GitHub tokens sealed (AES-256-GCM) and bound to the session; refresh 60 s ahead with a compare-and-swap; sign-out only with this site's `Origin`; 30 analyses an hour per signed-in user |
| Dashboard and install return | `app/dashboard`, ADR-0223, ADR-0225 | The user's installations and repos live from GitHub (bounded); an install return's `installation_id` counts only if GitHub lists it for the signed-in user (its `code` is never redeemed: login CSRF) |
| Webhooks | `lib/githubWebhook.ts` (ADR-0224, 0240, 0245, 0246) | HMAC (current and previous secret, constant time) before parsing; `installation`, `installation_repositories`, `pull_request`, `push` |
| Installation tokens | `lib/githubApp.ts`, `POST /api/worker/installation-token` (ADR-0226–0229) | The website mints one-repo tokens when the worker asks at job start, signed with an HKDF-derived key; the repo comes from the job's row, never the request; read token (contents + metadata) for live jobs, post token (PRs, checks) only between a diff and its Check Run |
| Access check | `lib/repoAccess.ts`, db `access.ts` (ADR-0231) | `GET /repositories/{id}` with the viewer's token, allowed and refused alike cached 60 s by the database's clock; anything else an uncached error (fails closed) |
| Private surfaces | `/api/graph`, pages and `?base=`, check-on-view, Analyze, job API and events, `/api/source` (ADR-0232–0237) | Behind the check, `private, no-store`, `Vary: Cookie`, `noindex`; a refusal is a missing repo's answer byte for byte |
| Visibility changes | ADR-0238, ADR-0239 | Public graphs tagged `repo-<GitHub ID>` and deleted from the CDN when a view finds the repo private; a `private/` key is only ever served behind the check, so a repo turned public is re-analyzed publicly |
| Uninstall deletion | db `deleteInstallationData`, worker `startInstallationAnalysis`, `purgeUnlinkedFolders` (ADR-0240–0242) | One locked transaction deletes rows, then the website deletes `private/<id>/` objects; a job in flight re-creates nothing and deletes its own private upload; the fact cache is per repo and purged at every job's start |
| PR bot | `packages/diff/src/pr.ts`, db `pullRequests.ts`, worker `diffJob.ts`, `post.ts` (ADR-0243–0245) | `pull_request` events record the pair (never moved back to an older head) and queue one diff job: merge base via GitHub's compare, both sides' stored graphs or the analysis child, `diffGraphs`, stored privately, then a comment (found again by its marker, edited in place) and a Check Run (`neutral` with breaks, `success` without); the comment links to the interactive diff, which draws the stored diff |
| Push webhook | ADR-0246 | A push to the default branch of an analyzed repo queues its commit under check-on-view's limits |
| Security suite | `apps/web/lib/security.test.ts` (M8.8) | Two look-alike tenants on every private surface, revocation within 60 s, forged webhooks and token requests, every `app/api` route listed with the test of its guard |
| PR flow | CLAUDE.md §5, ADR-0247 | Autopilot tasks now land through `task/<id>` PRs, read by the bot once it's installed on this repo (planning #24) |

## Results (exactly as measured)

- **Tests (local at `d5b6b70`, uncached, `npx turbo run test --force --concurrency=1 --continue`, 15 of 15 tasks, 0 cached):** 5,197 passed, 4 skipped. Analyzer 1,442, viewer 1,121, web 1,031, worker 828 (+1 skipped), db 257 (+3 skipped), eval 226, diff 161, bench 95, schema 36. Nothing failed or was rerun. Against `m7` (4,550): web +338, worker +187, db +103, diff +14, viewer +5.
- **Coverage (CI run 42523686832 on `d5b6b70`, all jobs green: check, worker-image, visual, web-e2e, deploy):** analyzer 97.66% lines, 91.14% branches; diff 99.01% / 93.83% (`pr.ts` 100% / 98.41%); web 97.46% / 95.71% (`githubApp.ts` 100%, `githubWebhook.ts` 98.57%, `session.ts` 98.4%); worker 96.47% / 93.66% (`diffJob.ts` 98.12%, `post.ts` 96.49%); db 99.44% / 93.25% (`pullRequests.ts` 100% / 88.57%); viewer 99.33%, eval 98.5%, schema 94.8%, bench 100%. Targets: analyzer and diff ≥ 85%, the rest ≥ 70%.
- **Checks:** `pnpm eval --check` reproduced `eval/results/2026-11-08-0.2.0.md` (recorded at `3d37c5b`, `4a85310`) byte for byte. M8 didn't touch the analyzer; its only eval re-records were lockfile changes with no delta.
- **Not measured:** the bot has never commented on a real pull request. It isn't installed on any repo yet (planning #24 installs it on this one), so the whole PR path, App to comment, is proven only against the fake GitHub.

## Key decisions and trade-offs

- **Refusals look like absence** (ADR-0232–0236): a signed-out visitor, a refused user, a dead cookie, and a never-analyzed name get the same status, headers, and body, so nobody learns that a private repo exists. The cost is unfriendly errors: a signed-in user without access sees "not found", not "ask for access".
- **The website mints, the worker asks** (ADR-0226): the App's private key stays in Vercel. A token in the queued task would expire while it waits, and a key next to untrusted tarballs would reach every installation. Each token names one repo and only the permissions the step needs, and the answer is checked for exactly that.
- **The 60 s cache keeps refusals too** (ADR-0231): a revoked user loses access within a minute, and a burst of views costs GitHub one call. An error is never cached, so the check fails closed.
- **Delete first, from the webhook** (ADR-0240): uninstall deletes rows in one transaction under the installation's lock, then objects by prefix; the worker's lock-holding start (ADR-0241) means a job can't revive what was deleted. Retention's orphan sweep is the backstop, not the plan.
- **One job does the whole PR** (ADR-0245): diff, store, and post in one worker job, "done" meaning posted, so a failed post is retried by the queue rather than lost.

## Hardest problem: proving a private repo looks like nothing

"Refused" has many shapes: no session, an ended session, a revoked grant, another tenant's repo, a refresh that fails, a repo that went private after its public analysis. Each surface (graph, page, permalink, `?base=`, job API, event stream, code previews, Analyze, the token route) had to collapse all of them into the answer a never-analyzed name gets, without reading the bucket first, and stay correct when GitHub is slow (an undecided check is "temporarily unavailable", never cached).

The approach was tests that compare whole answers rather than status codes: M8.8's suite seeds two tenants with look-alike repos at one commit and checks every private surface both ways, byte for byte, plus a list of every API route with the test of its guard, so a new route without one fails. Two bugs showed how easy it is to leak by side effect: Next prefetches a `<Link>`'s metadata, so a lookup in `generateMetadata` ran check-on-view (and hid repos) for every link on screen (`f9a9b18`); and `request.url` under `next start` is always `localhost`, so an `Origin` check passed tests and refused a real sign-out (`siteOrigin`).

## What's still weak

- **The bot is unproven on GitHub.** No real PR has a GitInside comment yet (planning #24).
- **Uninstall isn't instantaneous everywhere.** A diff job in flight can upload under `private/<id>/` after the purge (F4), and a racing request can re-create a deleted installation row (F5); the orphan sweep removes such objects within ~2 hours.
- **A repo turned private is hidden only when someone views it** (SECURITY.md T6, F16): the App doesn't subscribe to `repository` events.
- **Retention can break the PR link's diff** on an active public repo (F1), and a retargeted base isn't re-diffed (F2).
- **Badges refresh only when their 10-minute cache expires** after a push's analysis lands (M8.7).

## Fresh-eyes review

Three subagents with no prior context reviewed `m7..d5b6b70` read-only, split by area: sign-in and private surfaces (M8.2–M8.4), webhooks, tokens and deletion (M8.3, M8.5, M8.7, M8.8), and the PR bot (M8.6). They checked it against SPEC.md, SECURITY.md, DESIGN.md, and TESTING.md. None found anything high-severity.

They confirmed the following as correct:
- **Sign-in:** signed state cookie (constant time, 10 minutes, cleared on every outcome), state checked before GitHub's error, PKCE S256, `__Host-` HttpOnly Secure Lax cookies, only the token's hash stored, sealed tokens bound to their session, `returnTo` rejecting `//`, `/\`, backslashes, control characters, and > 512 characters; sign-out POST-only with `siteOrigin`.
- **Private surfaces:** the check runs before any spelling redirect or bucket read; every refusal is the same `404`; private answers are `private, no-store`, `Vary: Cookie`, untagged; `/api/source` rejects empty, `.`, `..` segments, caps at 2 MiB, serves `nosniff` with a sandbox CSP; `private/` keys never come back from public lookups; README images never pass a viewer.
- **Webhook and token route:** body capped at 4 MiB, both secrets compared with `timingSafeEqual` before parsing; the token route's derived key can't be swapped with the job signature's (tested both ways); repo and installation from the row; post token only in its window.
- **Deletion:** one transaction, `FOR UPDATE` against the `FOR SHARE` of `upsertRepo` and `startInstallationAnalysis`; transferred repos spared; an analysis job during an uninstall can't start or re-create rows.
- **PR bot:** repo text only in fenced code spans or percent-encoded links, Mermaid labels as entities and generated node IDs (T10); size limits conservative (UTF-16 length); records ordered by GitHub's `updated_at`; results written by job ID; the record re-read before posting; stored graphs only from `public/` or this installation's own folder; the diff route checks access before reading.

Findings marked "confirmed" were traced in the code by the reviewer and, for F1–F3 and F11, again in this task; "plausible" ones need a red test first.

| # | Severity | Finding | Plan |
|---|---|---|---|
| F1 | Medium (confirmed) | Retention pins each PR record's event `baseSha` and `headSha` (`packages/db/src/retention.ts` `listPinnedShas`), but the diff job stores and links the **merge base**, usually a different commit. On an active public repo (5 commits kept) the merge base's analysis is evicted within the hour; the comment's link then shows "missing base", `/api/diff` answers `404`, and a `diffed` retry reruns the whole job | M8.10b |
| F2 | Medium (confirmed) | Retargeting a PR's base sends `pull_request` `edited` with `changes.base`, which the webhook ignores (`githubWebhook.test.ts` asserts `edited` is ignored); the comment and Check Run describe the old base until the next push. No ADR names this | M8.10c |
| F3 | Low-medium (confirmed, two reviewers) | `isBotComment` (`apps/worker/src/post.ts:228`) accepts any `Bot` author whose comment starts with the marker; ADR-0243 asked for the App as author. A workflow echoing PR text as `github-actions[bot]` gets its comment overwritten, or the edit's `403` fails the job permanently (`POST_REFUSED`) | M8.10d |
| F7 | Low (confirmed) | The comment is posted before the Check Run; a refused comment (locked conversation, `POST_REFUSED`) means no Check Run either, so the PR shows nothing ("fail visibly") | M8.10d |
| F8 | Low (plausible) | Two attempts of one diff job can run at once (no row to claim; A→B→A force-pushes or two PRs sharing a pair), and on a PR's first comment both search, find nothing, and create: two comments | M8.10d (red test or documented bound) |
| F9 | Low (plausible) | The Mermaid summary is kept whenever the comment fits 65,536 characters, but non-ASCII labels become entities (up to ~420 characters each); past Mermaid's default 50,000-character text limit GitHub may show an error instead of the diagram (GitHub's setting not checked) | M8.10d |
| F10 | Low (docs) | No doc lists when the bot never posts: a refused comment (F7), `MERGE_BASE_NOT_FOUND`, a failed job never re-queued until the next push (same task name) | M8.10d |
| F4 | Low-medium (confirmed, two reviewers) | A diff job in flight during an uninstall uploads a side snapshot (`storeSide`) and the diff (`publish`) under `private/<id>/` after the purge; db answers `false` / `[]` and the objects wait ~2 h for the orphan sweep. ADR-0241 deletes at once for analysis jobs; ADR-0240 says nothing private outlives the delivery but failed deletes | M8.10e |
| F5 | Low-medium (plausible) | A request racing an uninstall re-creates the installation: `resolvePrivateRepo` reads `/user/installations`, then `upsertInstallation` with no fence, so a `deleted` committed in between is undone, and `storeQueueRepo` writes the repo and a queued row nothing will delete. Likewise a `pull_request` delivery after `installation_repositories` `removed` re-creates the repo row and a PR record | M8.10e |
| F6 | Low (confirmed) | SECURITY.md says "every write is idempotent, so a replayed delivery changes nothing twice", but a replayed signed `installation` `created` after `deleted` re-creates the row and re-links stored repos (even moving a transferred repo's link back); a replayed suspend flips the flag. GitHub still refuses tokens, so integrity, not a leak | M8.10e |
| F11 | Low (confirmed) | The worker's `cache_purge_failed` log (`apps/worker/src/job.ts:463`) carries `error.message`, which can hold a database host; elsewhere logs carry error names only | M8.10e |
| F13 | Low (confirmed, spec drift) | `recordAccess` stamps `checkedAt = now()` when writing, not when GitHub was asked (up to 10 s earlier), so a grant can be trusted ~70 s, and a slow grant finishing after a newer refusal overwrites it. SPEC: at most 60 s. (A job event stream keeps its decision 25 s, ADR-0236, also past 60 s in total) | M8.10f |
| F12 | Low (confirmed) | `/api/source` and the repo page call `checkRepoAccess` and then `userAccessToken` with the same `SignedInUser`, whose sealed tokens were read at the start; near expiry the second call spends the already-used refresh token, and a timeout there turns an allowed view into `503` / `unknown` | M8.10f |
| F17 | Low (confirmed) | A repo GitHub blocks (`451`) is stored as hidden; for a signed-in viewer `/repositories/{id}` answers `451`, which is an uncached error: "temporarily unavailable" forever, GitHub asked on every view | M8.10f |
| F15 | Low (confirmed, UX) | The first view after a repo turns private hides it and answers `missing` even to a signed-in viewer who would pass the check; their next view works | M8.10f |
| F14 | Low (plausible) | A `/api/graph` answer read while the repo was still public can land in the CDN after the purge (`s-maxage` a day), and no later view purges again because the repo is now hidden | M8.10f |
| F16 | Low (documented) | Nothing hides a repo the moment it goes private (no `repository` `privatized` handling); SECURITY.md T6 states the window. Needs a new App event subscription (Abhinav's settings) | Not planned in M8; T6 stays the record |

## Smoke test

Run as a signed-out user would, from the laptop against production (`https://gitinside.abhinavgonthina.dev`), 2026-11-08, one request per check (`apps/web/dist/m8-smoke.mjs`, `m8-smoke2.mjs`). Signing in needs a GitHub account in a browser, so the signed-in path is covered by the `signed-in` E2E project against the fake GitHub, not here.

- **Landing:** `200`, with "Sign in" and the private-repos line.
- **`/dashboard` signed out:** `307` to `/api/auth/github?returnTo=%2Fdashboard`, which answers `303` to `https://github.com/login/oauth/authorize` with `client_id`, `state`, `code_challenge` (`S256`), and `redirect_uri` `https://gitinside.abhinavgonthina.dev/api/auth/github/callback`; the state cookie is `__Host-gi_signin` (Path, Max-Age, HttpOnly, Secure, SameSite). An off-site `returnTo` still starts sign-in (it's replaced, checked in unit tests).
- **Webhook without a signature:** `401 {"error":"BAD_SIGNATURE"}`, `no-store`. **Token route without a signature:** `401 {"error":"MISSING_SIGNATURE"}`, `no-store`.
- **A never-analyzed name:** `/api/graph` `404 GRAPH_NOT_FOUND`, `/api/diff` `404 DIFF_NOT_FOUND`, `/api/source` `404 SOURCE_NOT_FOUND` (`private, no-store`, `Vary: cookie`), the permalink page `404`.
- **This repo's page** (`/AbhinavGonthina/gitinside`): `200`, showing `184ce7c`'s diagram with "The latest commit, d5b6b70, is being analyzed", no `noindex` (public). The README badge: `200` SVG, `public, max-age=600`, "10 services · 8 datastores · 1 queue".

## Interview questions

1. **How do you stop a private repo's existence from leaking?**
   Every refusal (signed out, refused, ended session, another tenant) returns exactly what a never-analyzed name gets: same status, headers, and body, and nothing is read from the bucket first. Tests compare whole answers across two look-alike tenants, and a test lists every API route with the test of its guard so a new route can't skip it. Private answers are `private, no-store` with `Vary: Cookie`, so no shared cache keeps them.

2. **Why does the website mint installation tokens instead of putting one in the job?**
   A token in a queued task would expire while it waits, and the App's private key next to untrusted tarballs could mint for every installation. The worker asks with a signed request at job start; the website takes the repo and installation from the job's row, not the request, asks GitHub for one repo with only the permissions that step needs, and refuses an answer that grants more.

3. **What happens when someone uninstalls the App while a job is running?**
   The webhook deletes rows in one transaction under the installation's row lock, then deletes `private/<id>/` objects. An analysis job can only start while holding that lock and finding its queued, linked row, so it can't re-create anything; if its upload lands after, it sees its row is gone and deletes the object. The review found diff jobs don't do that last step yet (F4): their uploads wait for the orphan sweep, up to ~2 hours.

4. **How does the bot avoid posting a stale result when someone pushes again mid-job?**
   PR records only move forward by GitHub's `updated_at`; a new pair clears the diff and Check Run. Results are written by job ID, so an old job can't land on a new pair, and just before posting the job re-reads the record and skips it if the pair moved on. The post token is only minted while a record has its diff and no Check Run.

5. **Your access cache is 60 seconds. Is that really the bound?**
   Not quite, which the review found (F13): the row is stamped when written, not when GitHub was asked, so a slow answer can be trusted ~70 s, and a slow grant can overwrite a newer refusal. The fix stamps the ask time and never replaces a newer answer. An event stream also keeps its decision for its 25 s, which is documented.

Quiz yourself: open Claude Code and say "quiz me on M8".
