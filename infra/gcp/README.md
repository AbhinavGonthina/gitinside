# The worker on Google Cloud Run

The analysis worker runs as a Cloud Run service that Cloud Tasks pushes each job to (ADR-0111, ADR-0114). This folder holds the reviewed configuration of the three Google pieces, and CI's check of the image. Nothing here holds a secret. Decisions: ADR-0150 (the image and its check) and ADR-0151 (this config). Security background: [docs/SECURITY.md](../../docs/SECURITY.md) §3.

| File | What it is |
|---|---|
| `service.json` | The Cloud Run service (Knative `serving.knative.dev/v1`; JSON is valid YAML, so `gcloud run services replace` reads it) |
| `queue.json` | The Cloud Tasks queue (the REST API's `Queue` resource) |
| `iam.json` | The three service accounts, the four secrets, and every role binding, each on one resource |
| `check.mjs` | CI's check of the image as Cloud Run runs it (job `worker-image`); never deployed |

`apps/web/lib/gcpConfig.test.ts` checks these files against the code: the worker's attempts, job budget, signature window, memory budget, and required variables, the website's dispatch deadline, and ADR-0111's guardrails. Change a setting on one side only and that test fails.

## What runs

```
Vercel (/api/analyze) ──create task (as gitinside-enqueue, keyless)──▶ Cloud Tasks queue "analyses"
                                                                          │ max 2 at once, 3 attempts
                                                                          ▼ OIDC token of gitinside-invoker
                                     Cloud Run "gitinside-worker" (ingress internal, IAM only)
                                       1 vCPU / 4 GiB, 1 job per instance, ≤ 2 instances, 300 s
                                          │ runs as gitinside-worker (reads its 4 secrets, nothing else)
                                          ▼
                    api.github.com, codeload.github.com, Oracle Object Storage, Neon
```

Project `gitinside-513223`, region `us-east4` (northern Virginia, beside Vercel's `iad1` and Neon, ADR-0111).

## The service (`service.json`)

| Setting | Value | Why |
|---|---|---|
| `maxScale` / `minScale` | 2 / 0 | ADR-0111's cost guardrails: two jobs at most, nothing billed while idle |
| `containerConcurrency` | 1 | One job per instance: its 4 GiB budget is for one job (ADR-0146); the worker also answers a second push `429` |
| `timeoutSeconds` | 300 | A job's 280 s budget plus 20 s to record a failure and answer (ADR-0143) |
| `cpu` / `memory` | 1 / 4Gi | What `apps/worker/src/budget.ts` adds up to |
| `cpu-throttling` | true | CPU only during a request, billed per request; maintenance runs inside a job's request for this reason (ADR-0147) |
| `startup-cpu-boost` | false | It bills extra vCPU-seconds at every cold start |
| `execution-environment` | gen2 | Full Linux behaviour, which the image check reproduces with plain Docker, and faster CPU for a CPU-bound job under a fixed budget; each instance is still in Google's sandbox (reviewed in M5.17f) |
| `ingress` | internal | Only Google services in this project (Cloud Tasks) on the `run.app` URL reach it; the public internet gets nothing, before IAM is even asked |
| invoker | `gitinside-invoker` only | No `allUsers` binding: an unauthenticated request is refused by Cloud Run, and the HMAC is a second check (ADR-0143) |
| `startupProbe` | `GET /health`, every 2 s, up to 60 s | Traffic only once the server listens; no liveness probe (an instance is busy with its one job) |
| `serviceAccountName` | `gitinside-worker` | Its own account, never the default compute account (which has Editor on the project) |

**Variables.** Plain values, filled in by the deploy (M5.17e) from GitHub Actions variables: `SNAPSHOTS_NAMESPACE`, `SNAPSHOTS_REGION`, `SNAPSHOTS_BUCKET`, `SNAPSHOTS_ACCESS_KEY_ID` (an identifier, not a secret), and `{{IMAGE}}`. From Secret Manager, version `latest`, read when an instance starts: `DATABASE_URL` (`worker-database-url`), `SNAPSHOTS_SECRET_ACCESS_KEY` (`worker-snapshots-secret-key`), `ENQUEUE_HMAC_SECRET` (`enqueue-hmac-secret`, the same value as in Vercel), and `GITHUB_TOKEN` (`worker-github-token`: Cloud Run's outbound addresses are shared, so the anonymous limit of 60 an hour would run out). `PORT` is set by Cloud Run and `HOST` by the image.

Secret Manager's free tier is 6 active secret versions and 10,000 accesses a month. Four secrets leave one version spare for a rotation; four reads per cold start allow 2,500 cold starts a month.

## The queue (`queue.json`)

| Setting | Value | Why |
|---|---|---|
| `maxConcurrentDispatches` | 2 | One per instance (`maxScale` × concurrency) |
| `maxDispatchesPerSecond` | 1 | Jobs take tens of seconds; a burst only queues |
| `maxAttempts` | 3 | The worker's `MAX_ATTEMPTS`: it answers `200` on the third, so more would never re-run a job anyway |
| `maxRetryDuration` | 0s (none) | The attempt count alone stops retries |
| backoff | 30 s, then 60 s (`minBackoff` 30 s, doubling, `maxBackoff` 120 s) | Long enough for a cold instance or GitHub to recover; three 330 s dispatch deadlines plus both waits are 18 minutes, far inside the signature's one-day window (ADR-0143), which leaves the rest of the day for waiting behind other jobs |
| logging | every task operation | Cheap at this volume, and the only record of a delivery the worker never saw |

Tasks are created by the website with a 330 s dispatch deadline (ADR-0141). Never upload a `queue.yaml` for this project: it switches the queue to App Engine's mode, where a used task name is reserved for 9 days instead of a day.

## IAM (`iam.json`)

| Account | May | On |
|---|---|---|
| `gitinside-worker` (runtime) | read secret versions | each of the 4 secrets, separately |
| `gitinside-invoker` | invoke | the `gitinside-worker` service only |
| `gitinside-enqueue` | create tasks (`cloudtasks.enqueuer`) | the `analyses` queue only |
| `gitinside-enqueue` | act as `gitinside-invoker` | that account only (needed to name it in a task's OIDC token) |
| Vercel production (Workload Identity Federation) | become `gitinside-enqueue` | that account only |

No binding is on the project, none is a basic role (owner, editor, viewer), and none names `allUsers`. Cloud Tasks' own service agent mints the invoker's OIDC tokens through its default role; nothing extra is granted to it. The pool `vercel` (Vercel's OIDC issuer, `attribute.environment` from the token's `environment` claim, restricted to this Vercel project), the project number in its principal, and the GitHub Actions deploy account belong to M5.17e.

## Applying it

M5.17e adds the GitHub Actions deploy (keyless) and a `verify-guardrails` script, and posts the one-time Google Cloud steps on planning issue #3. Until then nothing is deployed. By hand, with the placeholders filled in, the pieces map to:

```sh
gcloud run services replace service.json --region us-east4
gcloud run services add-iam-policy-binding gitinside-worker --region us-east4 \
  --member serviceAccount:gitinside-invoker@gitinside-513223.iam.gserviceaccount.com --role roles/run.invoker
gcloud tasks queues create analyses --location us-east4 \
  --max-concurrent-dispatches 2 --max-dispatches-per-second 1 --max-attempts 3 \
  --max-retry-duration 0s --min-backoff 30s --max-backoff 120s --max-doublings 2 --log-sampling-ratio 1
```

## Operations

| Task | How |
|---|---|
| Logs (JSON lines) | Cloud Run → `gitinside-worker` → Logs, or `gcloud run services logs read gitinside-worker --region us-east4` |
| Quota check (Object Storage bytes and requests, Neon, vs. the free limits; exit 2 at 80%) | From a checkout with the production values in `apps/worker/.env`: `pnpm --filter @gitinside/worker quota` |
| Quota alarms from maintenance | Logs, filter `jsonPayload.event="quota_alarm"` |
| Rotate the HMAC secret | Add the old value as a temporary secret `enqueue-hmac-secret-previous` mounted as `ENQUEUE_HMAC_SECRET_PREVIOUS`, add a new version of `enqueue-hmac-secret`, deploy, update Vercel; once a day has passed (the longest a signed task can wait), remove the variable, deploy, and delete the temporary secret |

Stopping the service stops nothing in flight that matters: a job cut off by a new revision or a scale-in is answered `503` and Cloud Tasks delivers it again (DESIGN.md §12).
