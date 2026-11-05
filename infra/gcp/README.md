# The worker on Google Cloud Run

The analysis worker runs as a Cloud Run service that Cloud Tasks pushes each job to (ADR-0111, ADR-0114). This folder holds the reviewed configuration of the three Google pieces, and CI's check of the image. Nothing here holds a secret. Decisions: ADR-0150 (the image and its check) and ADR-0151 (this config). Security background: [docs/SECURITY.md](../../docs/SECURITY.md) §3.

| File | What it is |
|---|---|
| `service.json` | The Cloud Run service (Knative `serving.knative.dev/v1`; JSON is valid YAML, so `gcloud run services replace` reads it) |
| `queue.json` | The Cloud Tasks queue (the REST API's `Queue` resource) |
| `iam.json` | The five service accounts, the four secrets, and every role binding, each on one resource |
| `killswitch.json` | The billing kill switch's Cloud Run service (the worker's image, another command) |
| `budget.json` | The $1 monthly budget (Cloud Billing Budget API's `Budget`), publishing to `billing-alerts` |
| `pubsub.json` | The `billing-alerts` topic and the push subscription that delivers it to the kill switch |
| `registry.json` | The Artifact Registry repository for the image, its cleanup policies (`gcloud artifacts repositories set-cleanup-policies` format), and the image's size limit |
| `github.json` | The Workload Identity pool `github` and its provider: which GitHub Actions tokens may become the deploy account |
| `deploy.mjs` | CI's deploy (job `deploy`): build, push, render, replace both services, update the queue |
| `check.mjs` | CI's check of the image as Cloud Run runs it, the kill switch included (job `worker-image`); never deployed |
| `verify.mjs` | `pnpm verify-guardrails`: reads the live project back against these files (ADR-0171); run by hand |

`apps/web/lib/gcpConfig.test.ts` checks these files against the code: the worker's attempts, job budget, signature window, memory budget, and required variables, the website's dispatch deadline, and ADR-0111's guardrails. `apps/web/lib/gcpDeploy.test.ts` checks the deploy: the script against a fake `gcloud`/`docker`, CI's job, the provider's condition, and the deploy account's IAM. Change a setting on one side only and they fail. `apps/web/lib/gcpVerify.test.ts` runs `verify.mjs` against a fake Google built from these files.

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
| `execution-environment` | gen2 | Full Linux behaviour, which the image check reproduces with plain Docker, and faster CPU for a CPU-bound job under a fixed budget; each instance is still in Google's sandbox, and holds one job. Egress is the platform's ordinary network: the analysis child's own guards are its boundary (SECURITY.md T4, ADR-0152) |
| `ingress` | internal | Only Google services in this project (Cloud Tasks) on the `run.app` URL reach it; the public internet gets nothing, before IAM is even asked |
| invoker | `gitinside-invoker` only | No `allUsers` binding: an unauthenticated request is refused by Cloud Run, and the HMAC is a second check (ADR-0143) |
| `startupProbe` | `GET /health`, every 2 s, up to 60 s | Traffic only once the server listens; no liveness probe (an instance is busy with its one job) |
| `serviceAccountName` | `gitinside-worker` | Its own account, never the default compute account (which has Editor on the project) |

**Variables.** Plain values, filled in by the deploy (M5.17e) from GitHub Actions variables: `SNAPSHOTS_NAMESPACE`, `SNAPSHOTS_REGION`, `SNAPSHOTS_BUCKET`, `SNAPSHOTS_ACCESS_KEY_ID` (an identifier, not a secret), `{{IMAGE}}`, and `{{COMMIT}}` (the revision's `gitinside-commit` label, which the next deploy compares with). From Secret Manager, version `latest`, read when an instance starts: `DATABASE_URL` (`worker-database-url`), `SNAPSHOTS_SECRET_ACCESS_KEY` (`worker-snapshots-secret-key`), `ENQUEUE_HMAC_SECRET` (`enqueue-hmac-secret`, the same value as in Vercel), and `GITHUB_TOKEN` (`worker-github-token`: Cloud Run's outbound addresses are shared, so the anonymous limit of 60 an hour would run out; a fine-grained token with "Public repositories (read-only)" access and no permissions, so a leak reads only public data, SECURITY.md §4). `PORT` is set by Cloud Run and `HOST` by the image.

**Migrations** (ADR-0192). Each instance applies pending migrations at startup, before it listens, so a new revision takes no traffic (its startup probe fails) until Neon's schema matches its code. It connects to Neon's direct endpoint, the `worker-database-url` host without `-pooler` (same role and password), since a session advisory lock and DDL don't go through PgBouncer's transaction pooling; that lock makes two instances starting together take turns. A migration waits at most 15 s for a lock and then fails the start, which Cloud Run retries. No extra secret, role, or step: the deploy is unchanged. Migrations must keep the previous revision working (add, don't rename or drop in the same commit), since it serves until the new one is ready.

Secret Manager's free tier is 6 active secret versions and 10,000 accesses a month. Four secrets leave one version spare for a rotation; four reads per cold start allow 2,500 cold starts a month. The worker counts its four reads at each start in `compute_usage` (M5.14b3g2), so new analyses pause at 2,000 starts like any other meter at 80%.

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
| This repo's CI on `main` (pool `github`, `github.json`) | become `gitinside-deploy` | that account only |
| `gitinside-deploy` | push images (`artifactregistry.writer`) | the `gitinside` repository only |
| `gitinside-deploy` | replace a service (`run.developer`: no IAM changes, so it can't add an invoker) | `gitinside-worker` and `gitinside-killswitch`, each |
| `gitinside-deploy` | run them as their accounts (`iam.serviceAccountUser`) | `gitinside-worker` and `gitinside-killswitch`, each |
| `gitinside-deploy` | update the queue (`cloudtasks.queueAdmin`) | the `analyses` queue only |
| `gitinside-killswitch` | invoke | the `gitinside-killswitch` service only (it signs Pub/Sub's pushes) |
| `gitinside-killswitch` | unlink billing (`billing.projectManager`) | the project: the one project-level binding (ADR-0169) |
| Cloud Billing's budget agent (`billing-budget-alert@system…`) | publish | the `billing-alerts` topic only |

No other binding is on the project, none is a basic role (owner, editor, viewer), and none names `allUsers`. Cloud Tasks' own service agent mints the invoker's OIDC tokens through its default role; nothing extra is granted to it. The pool `vercel` (Vercel's OIDC issuer, `attribute.environment` from the token's `environment` claim, restricted to this Vercel project) and the project number in its principal are set up with M5.17e4's steps.

## The billing kill switch (`budget.json`, `pubsub.json`, `killswitch.json`)

Google's documented way to cap spending (ADR-0111, ADR-0169). After the trial, usage past the free allowance is billable, and the app's own compute pause (ADR-0156) is the first stop; this is the last.

```
budget "gitinside-kill-switch" ($1 a month, this project, after all credits)
   │ several times a day: {costAmount, budgetAmount, …}
   ▼
Pub/Sub topic "billing-alerts" ──push (OIDC as gitinside-killswitch)──▶ Cloud Run "gitinside-killswitch" POST /budget
                                                                           │ costAmount ≥ budgetAmount?
                                                                           ▼ token from the metadata server
                                         Cloud Billing: PUT projects/gitinside-513223/billingInfo {"billingAccountName": ""}
```

| Setting | Value | Why |
|---|---|---|
| Budget | 1 USD a month, `INCLUDE_ALL_CREDITS`, thresholds 50/90/100% of actual spend | What the card would pay: during the trial, credits cover everything, so it never fires. Thresholds only add emails to billing admins; the switch reads the cost from every message. The currency must be the billing account's own |
| Trigger | cost ≥ budget (never with a budget of 0) | `overBudget` in `apps/worker/src/killswitch.ts` |
| Service | max 1 instance, concurrency 1, 1 vCPU / 512 MiB, 60 s, ingress internal, own account | A few requests a day; Pub/Sub counts as internal traffic from the project |
| Subscription | push to `{{KILLSWITCH_URL}}/budget`, ack deadline 60 s, retries 10 s–10 min, kept 7 days, never expires | A failed unlink (`503`) is retried for a week; anything else is answered `204` |

Unlinking billing stops every paid service in the project, the worker included, and Google warns that it may delete resources of a project that stays without billing. Turning it back on is a manual step in the console (Billing → link the account), after finding out why. Budget data lags actual usage by hours, so the bill can pass $1 by what accrues in that time; the worker's 2-instance cap bounds that to cents.

## The deploy (`deploy.mjs`, `github.json`, `registry.json`)

CI's last job, `deploy` in `.github/workflows/ci.yml` (ADR-0170), on a push to `main` or a manual run there:

```
every other CI job green ─▶ GitHub OIDC token ──Workload Identity Federation, pool "github"──▶ gitinside-deploy (no key anywhere)
   │
   ▼ deploy.mjs changed <sha>: did the image's inputs change since the commit both services run?
       (their gitinside-commit revision label; apps/worker, the workspace packages it builds from,
        root manifests, infra/gcp)
   │ yes (or can't tell)
   ▼ deploy.mjs apply <sha>
docker build ─▶ push us-east4-docker.pkg.dev/gitinside-513223/gitinside/worker:<sha>
   ─▶ render killswitch.json, service.json with the pushed digest and the repo variables
   ─▶ gcloud run services replace (kill switch first) ─▶ gcloud tasks queues update (queue.json)
```

| Piece | What | Why |
|---|---|---|
| Trigger | `needs` all four CI jobs; `main` only; skipped while `GCP_PROJECT_NUMBER` isn't set | Nothing ships red, and the job is idle until #3's setup exists |
| Change check | `git diff --name-only` from the commit the live services run to this one, against the image's inputs (read from the worker's `package.json` and its workspace dependencies). The live commit is each service's `gitinside-commit` revision label (`{{COMMIT}}`), trusted only when its newest revision is Ready and serves all traffic; no label, a failed or half-rolled revision, a failed describe, or a commit git doesn't have deploys, and so does a manual run | Most commits are docs or the website, and each build is a new image in the registry. Comparing with what's live, not the previous push, means a run that failed, was cancelled, or never reached the deploy is shipped by the next push (R3, second M5 review) |
| Provider condition | repository and owner **IDs**, `ref == refs/heads/main`, `workflow_ref` = `ci.yml` on main, event `push` or `workflow_dispatch` | A pull request, another branch, another workflow file, or a re-created repo of the same name gets no token |
| Image | pinned by digest in both services | The services run exactly what was pushed, whatever the tag later points to |
| Render | on the parsed JSON, string by string; `IMAGE` must be this registry's worker by digest, other values (`COMMIT`, the repo variables) identifiers | A repo variable can't change a service's structure |
| Actions | `google-github-actions/auth` and `setup-gcloud` pinned by commit | They hold the job's Google credentials |
| Registry | keep the 3 most recent versions, delete anything else older than an hour; CI fails if the image passes 150 MB gzipped (`check.mjs`; 85.9 MB on 2026-11-01) | 3 × 150 MB fits Artifact Registry's free 0.5 GB: the running image, the one before, and one from a deploy that failed half way. Cleanup runs about daily, so a day with many deploys can pass 0.5 GB for hours, cents at most |

**Repo variables** (Settings → Secrets and variables → Actions → Variables; identifiers, none secret): `GCP_PROJECT_NUMBER`, `SNAPSHOTS_NAMESPACE`, `SNAPSHOTS_REGION`, `SNAPSHOTS_BUCKET`, `SNAPSHOTS_ACCESS_KEY_ID`. The secrets stay in Secret Manager.

The deploy never creates a service, a queue, or a binding. The first time, the two services are created by hand from Google's public sample image (M5.17e4's steps), so the deploy account needs no project-wide role; from then on CI replaces them. For the same reason `service.json` and `killswitch.json` set no `metadata.namespace`: with one, `gcloud run services replace` first reads the project's number from Resource Manager (`projects.get`, a project-level permission) to check it, and the first deploy was refused there (#16, ADR-0188). Without it, the namespace is the `--project` the deploy passes. A redeploy without a change: Actions → CI → Run workflow on `main`. A rollback: revert the commit on `main`.

## Applying it

The one-time setup, by the project's owner, in [Cloud Shell](https://shell.cloud.google.com) (free; `gcloud` and Node are installed). Every command creates exactly one piece of this folder's files; nothing here is billed by the hour, and nothing turns on an API this folder doesn't use. `apps/web/lib/gcpSetup.test.ts` checks the block below against `iam.json`, `queue.json`, `github.json`, `budget.json`, `pubsub.json`, and `registry.json`, so a change to one side fails CI. Run it in order: later steps name what earlier ones create.

A new Cloud Shell session forgets step 0: run it again (from `gcloud config set project` through `N=…`, then `cd gitinside`) before any later step. Without `billing/quota_project`, the budget and billing calls fail with a quota-project error.

```sh
# 0. The project, and names used below. N is the project's number (not secret).
#    Repeat this step in every new Cloud Shell session.
gcloud config set project gitinside-513223
gcloud config set billing/quota_project gitinside-513223
P=gitinside-513223
R=us-east4
N=$(gcloud projects describe $P --format='value(projectNumber)')
git clone --depth 1 https://github.com/AbhinavGonthina/gitinside
cd gitinside

# 1. The APIs this folder uses (enabling one is free). Not Compute Engine.
gcloud services enable run.googleapis.com cloudtasks.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com pubsub.googleapis.com cloudbilling.googleapis.com \
  billingbudgets.googleapis.com cloudresourcemanager.googleapis.com

# 2. The five service accounts (iam.json). Never create a key for any of them.
gcloud iam service-accounts create gitinside-worker --display-name="GitInside worker (Cloud Run runtime)"
gcloud iam service-accounts create gitinside-invoker --display-name="GitInside invoker (Cloud Tasks OIDC)"
gcloud iam service-accounts create gitinside-enqueue --display-name="GitInside enqueue (Vercel, keyless)"
gcloud iam service-accounts create gitinside-killswitch --display-name="GitInside billing kill switch"
gcloud iam service-accounts create gitinside-deploy --display-name="GitInside deploy (GitHub Actions, keyless)"

# 3. The four secrets, stored in us-east4 only (one location: the free tier counts versions per location).
gcloud secrets create worker-database-url --replication-policy=user-managed --locations=$R
gcloud secrets create worker-snapshots-secret-key --replication-policy=user-managed --locations=$R
gcloud secrets create enqueue-hmac-secret --replication-policy=user-managed --locations=$R
gcloud secrets create worker-github-token --replication-policy=user-managed --locations=$R
# Then one value each, typed at a hidden prompt (never on a command line, in a file, or in an issue):
#   worker-database-url          Neon's pooled connection string (Vercel's DATABASE_URL)
#   worker-snapshots-secret-key  the Customer Secret Key's secret (Vercel's SNAPSHOTS_SECRET_ACCESS_KEY)
#   enqueue-hmac-secret          Vercel's ENQUEUE_HMAC_SECRET (the same value on both sides)
#   worker-github-token          a fine-grained GitHub token: "Public repositories (read-only)", no permissions
read -rs V && printf %s "$V" | gcloud secrets versions add worker-database-url --data-file=- && unset V
read -rs V && printf %s "$V" | gcloud secrets versions add worker-snapshots-secret-key --data-file=- && unset V
read -rs V && printf %s "$V" | gcloud secrets versions add enqueue-hmac-secret --data-file=- && unset V
read -rs V && printf %s "$V" | gcloud secrets versions add worker-github-token --data-file=- && unset V

# 4. The image registry and its cleanup (registry.json).
gcloud artifacts repositories create gitinside --repository-format=docker --location=$R
node -e "const r=require('./infra/gcp/registry.json');require('fs').writeFileSync('/tmp/cleanup.json',JSON.stringify(r.cleanupPolicies))"
gcloud artifacts repositories set-cleanup-policies gitinside --location=$R --policy=/tmp/cleanup.json --no-dry-run

# 5. The queue (queue.json).
gcloud tasks queues create analyses --location=$R \
  --max-concurrent-dispatches=2 --max-dispatches-per-second=1 --max-attempts=3 \
  --max-retry-duration=0s --min-backoff=30s --max-backoff=120s --max-doublings=2 --log-sampling-ratio=1

# 6. Both services, from Google's sample image; CI's first deploy replaces them with service.json
#    and killswitch.json. No unauthenticated access, internal ingress, their own accounts.
gcloud run deploy gitinside-worker --image=us-docker.pkg.dev/cloudrun/container/hello --region=$R \
  --no-allow-unauthenticated --ingress=internal --service-account=gitinside-worker@$P.iam.gserviceaccount.com \
  --min-instances=0 --max-instances=2 --concurrency=1 --cpu=1 --memory=4Gi --timeout=300 \
  --cpu-throttling --no-cpu-boost --execution-environment=gen2
gcloud run deploy gitinside-killswitch --image=us-docker.pkg.dev/cloudrun/container/hello --region=$R \
  --no-allow-unauthenticated --ingress=internal --service-account=gitinside-killswitch@$P.iam.gserviceaccount.com \
  --min-instances=0 --max-instances=1 --concurrency=1 --cpu=1 --memory=512Mi --timeout=60 \
  --cpu-throttling --no-cpu-boost
KS=$(gcloud run services describe gitinside-killswitch --region=$R --format='value(status.url)')

# 7. The kill switch's topic and push subscription (pubsub.json).
gcloud pubsub topics create billing-alerts
gcloud pubsub subscriptions create billing-alerts-killswitch --topic=billing-alerts \
  --push-endpoint=$KS/budget --push-auth-service-account=gitinside-killswitch@$P.iam.gserviceaccount.com \
  --push-auth-token-audience=$KS --ack-deadline=60 --message-retention-duration=7d \
  --min-retry-delay=10s --max-retry-delay=600s --expiration-period=never

# 8. The kill switch's budget (budget.json). Keep the $1 budget made at signup too: it only emails.
B=$(gcloud billing projects describe $P --format='value(billingAccountName)' | cut -d/ -f2)
gcloud billing budgets create --billing-account=$B --display-name=gitinside-kill-switch \
  --budget-amount=1.00USD --filter-projects=projects/$N --credit-types-treatment=include-all-credits \
  --calendar-period=month --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 --notifications-rule-pubsub-topic=projects/$P/topics/billing-alerts
#    (gcloud sets the notification schema version 1.0 itself when a topic is given.)

# 9. Workload Identity Federation: GitHub Actions (github.json) and Vercel. Set VT to the Vercel team
#    slug (the path in your Vercel dashboard's URL), VO to its team ID (team_…), VP to the project's
#    ID (prj_…, Project Settings → General). Vercel: Project Settings → Security → OIDC Federation
#    on, issuer mode "Team".
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github --location=global \
  --workload-identity-pool=github --display-name="GitHub Actions (gitinside main)" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref" \
  --attribute-condition="assertion.repository_owner_id == '184985044' && assertion.repository_id == '1431766616' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'AbhinavGonthina/gitinside/.github/workflows/ci.yml@refs/heads/main' && assertion.event_name in ['push', 'workflow_dispatch']"
gcloud iam workload-identity-pools create vercel --location=global --display-name="Vercel"
gcloud iam workload-identity-pools providers create-oidc vercel --location=global \
  --workload-identity-pool=vercel --display-name="Vercel (gitinside)" \
  --issuer-uri="https://oidc.vercel.com/$VT" --allowed-audiences="https://vercel.com/$VT" \
  --attribute-mapping="google.subject=assertion.sub,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.owner_id == '$VO' && assertion.project_id == '$VP'"

# 10. Every role binding (iam.json), each on one resource. The kill switch's billing role is the only
#     one on the project.
gcloud secrets add-iam-policy-binding worker-database-url \
  --member=serviceAccount:gitinside-worker@$P.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding worker-snapshots-secret-key \
  --member=serviceAccount:gitinside-worker@$P.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding enqueue-hmac-secret \
  --member=serviceAccount:gitinside-worker@$P.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding worker-github-token \
  --member=serviceAccount:gitinside-worker@$P.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud run services add-iam-policy-binding gitinside-worker --region=$R \
  --member=serviceAccount:gitinside-invoker@$P.iam.gserviceaccount.com --role=roles/run.invoker
gcloud run services add-iam-policy-binding gitinside-worker --region=$R \
  --member=serviceAccount:gitinside-deploy@$P.iam.gserviceaccount.com --role=roles/run.developer
gcloud run services add-iam-policy-binding gitinside-killswitch --region=$R \
  --member=serviceAccount:gitinside-killswitch@$P.iam.gserviceaccount.com --role=roles/run.invoker
gcloud run services add-iam-policy-binding gitinside-killswitch --region=$R \
  --member=serviceAccount:gitinside-deploy@$P.iam.gserviceaccount.com --role=roles/run.developer
gcloud tasks queues add-iam-policy-binding analyses --location=$R \
  --member=serviceAccount:gitinside-enqueue@$P.iam.gserviceaccount.com --role=roles/cloudtasks.enqueuer
gcloud tasks queues add-iam-policy-binding analyses --location=$R \
  --member=serviceAccount:gitinside-deploy@$P.iam.gserviceaccount.com --role=roles/cloudtasks.queueAdmin
gcloud iam service-accounts add-iam-policy-binding gitinside-invoker@$P.iam.gserviceaccount.com \
  --member=serviceAccount:gitinside-enqueue@$P.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
gcloud iam service-accounts add-iam-policy-binding gitinside-worker@$P.iam.gserviceaccount.com \
  --member=serviceAccount:gitinside-deploy@$P.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
gcloud iam service-accounts add-iam-policy-binding gitinside-killswitch@$P.iam.gserviceaccount.com \
  --member=serviceAccount:gitinside-deploy@$P.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
gcloud iam service-accounts add-iam-policy-binding gitinside-enqueue@$P.iam.gserviceaccount.com \
  --member=principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/vercel/attribute.environment/production \
  --role=roles/iam.workloadIdentityUser
gcloud iam service-accounts add-iam-policy-binding gitinside-deploy@$P.iam.gserviceaccount.com \
  --member=principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/attribute.repository_id/1431766616 \
  --role=roles/iam.workloadIdentityUser
gcloud projects add-iam-policy-binding $P --condition=None \
  --member=serviceAccount:gitinside-killswitch@$P.iam.gserviceaccount.com --role=roles/billing.projectManager
gcloud pubsub topics add-iam-policy-binding billing-alerts \
  --member=serviceAccount:billing-budget-alert@system.gserviceaccount.com --role=roles/pubsub.publisher
gcloud artifacts repositories add-iam-policy-binding gitinside --location=$R \
  --member=serviceAccount:gitinside-deploy@$P.iam.gserviceaccount.com --role=roles/artifactregistry.writer

# 11. What the website and CI need (identifiers, none secret).
echo "GCP_PROJECT_NUMBER=$N"
echo "WORKER_URL=$(gcloud run services describe gitinside-worker --region=$R --format='value(status.url)')"
```

Then, outside Google:

1. **GitHub** (Settings → Secrets and variables → Actions → Variables): `SNAPSHOTS_NAMESPACE`, `SNAPSHOTS_REGION`, `SNAPSHOTS_BUCKET`, `SNAPSHOTS_ACCESS_KEY_ID` (Vercel's values), then `GCP_PROJECT_NUMBER` last: it switches CI's `deploy` job on. Actions → CI → Run workflow on `main` deploys the worker and the kill switch over the sample image.
2. **Vercel** (Production): `GCP_PROJECT_ID=gitinside-513223`, `GCP_REGION=us-east4`, `GCP_TASKS_QUEUE=analyses`, `GCP_WORKLOAD_IDENTITY_PROVIDER=//iam.googleapis.com/projects/<N>/locations/global/workloadIdentityPools/vercel/providers/vercel`, `GCP_ENQUEUE_SERVICE_ACCOUNT=gitinside-enqueue@gitinside-513223.iam.gserviceaccount.com`, `GCP_INVOKER_SERVICE_ACCOUNT=gitinside-invoker@gitinside-513223.iam.gserviceaccount.com`, `WORKER_URL` from step 11; then redeploy.
3. **Check:** in Cloud Shell, `node infra/gcp/verify.mjs` (below) after CI's deploy. Before it, the two services' image and settings are reported as the sample's.

Paid options this setup never turns on: Compute Engine (if its API is ever on, remove the default compute account's Editor binding, which `verify.mjs` reports), Cloud NAT, a load balancer, a reserved IP, Memorystore, a Serverless VPC Access connector, minimum instances above 0, always-allocated CPU, startup CPU boost, multi-region secrets, more than 6 active secret versions, more than 0.5 GB of images.

## Checking the live project (`verify.mjs`)

From a checkout, signed in as the project's owner (`gcloud auth login`): `pnpm verify-guardrails`. It reads the project through Google's REST APIs, never changes anything, and prints one `MISMATCH` line per difference from these files; exit 0 only when every check matches. A part it can't read (a missing resource, a denied call) is a mismatch too.

| Part | Compared with |
|---|---|
| Both Cloud Run services | `service.json`, `killswitch.json`: scale, concurrency, timeout, CPU and memory, ingress, CPU throttling and boost, execution environment, account, image (this registry's worker by digest), command, variables and secret references; no VPC egress; Ready |
| The queue | `queue.json` |
| IAM | Each policy `iam.json` names, and each account's and secret's: exactly its bindings. On the project, besides the kill switch's role, only the owner (a person, `roles/owner`), the Google APIs Service Agent's Editor, and Google's `*.serviceAgent` roles. No `allUsers`, no other basic role, no service account keys |
| Workload Identity | The `github` provider's condition, mapping, and issuer (`github.json`) |
| Billing | Billing on; the budget (`budget.json`); the topic and the subscription pushing to the kill switch's live URL (`pubsub.json`) |
| Nothing billed by the hour | No Cloud NAT, forwarding rule (load balancer), reserved IP, Memorystore instance, or Serverless VPC Access connector (an API that's off counts as none) |
| Artifact Registry | `registry.json`'s cleanup policies, not a dry run, no other repository in `us-east4`, under the free 0.5 GB |

Not checked: the Vercel Workload Identity pool (no file here yet), secret values, whether the deploy's and the kill switch's roles are enough for what they do (the first deploy and the first over-budget message show that), and other projects on the billing account. Until CI's first deploy, both services run Google's sample image, which it reports. Run it after the setup, after any change in the console, and before the trial's day 90.

## Operations

| Task | How |
|---|---|
| Check the guardrails | `pnpm verify-guardrails` (above) |
| Logs (JSON lines) | Cloud Run → `gitinside-worker` → Logs, or `gcloud run services logs read gitinside-worker --region us-east4` |
| Quota check (Object Storage bytes and requests, Neon, and the month's Cloud Run vCPU- and GB-seconds, requests, Cloud Tasks operations, and Secret Manager accesses as GitInside counts them, vs. the free limits; exit 2 at 80%, when new analyses are paused, ADR-0156) | From a checkout with the production values in `apps/worker/.env`: `pnpm --filter @gitinside/worker quota` |
| Quota alarms from maintenance | Logs, filter `jsonPayload.event="quota_alarm"` |
| Rotate the HMAC secret | Add the old value as a temporary secret `enqueue-hmac-secret-previous` mounted as `ENQUEUE_HMAC_SECRET_PREVIOUS`, add a new version of `enqueue-hmac-secret`, deploy, update Vercel; once a day has passed (the longest a signed task can wait), remove the variable, deploy, and delete the temporary secret |

Stopping the service stops nothing in flight that matters: a job cut off by a new revision or a scale-in is answered `503` and Cloud Tasks delivers it again (DESIGN.md §12).
