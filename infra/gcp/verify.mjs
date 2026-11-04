#!/usr/bin/env node
/**
 * `verify-guardrails` (ADR-0111, ADR-0171): reads the live Google Cloud project through
 * Google's REST APIs and compares it with this folder's reviewed files. Run from the repo root,
 * signed in with `gcloud auth login` as the project's owner:
 *
 *   pnpm verify-guardrails
 *
 * Exit 0 when the project matches, 1 with one line per mismatch, and per thing it couldn't
 * read (a check that can't run never passes). It only reads: GETs and `getIamPolicy` calls.
 *
 * What it checks:
 *   - both Cloud Run services (`service.json`, `killswitch.json`): scale, concurrency,
 *     timeout, CPU and memory, ingress, CPU throttling and boost, account, image, variables,
 *     no VPC egress, Ready;
 *   - the queue (`queue.json`);
 *   - every IAM policy `iam.json` names, exactly, and the project's: no basic role and no
 *     `allUsers` beyond Google's own service agents and the owner; no service account keys;
 *   - the GitHub Workload Identity provider (`github.json`);
 *   - billing on, the budget (`budget.json`), the topic and the kill switch's push
 *     subscription (`pubsub.json`);
 *   - nothing billed by the hour: no Cloud NAT, load balancer (forwarding rule), reserved IP,
 *     Memorystore instance, or Serverless VPC Access connector;
 *   - Artifact Registry (`registry.json`): the cleanup policies, live (not a dry run), no
 *     other repository, and under the free 0.5 GB.
 *
 * Not checked: the Vercel Workload Identity pool (set up by hand with M5.17e4's steps, no file
 * here yet), secret values, and anything outside the project (the billing account's other
 * projects).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GCP = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(GCP, name), "utf8"));

/** Artifact Registry's free storage, 0.5 GB, in decimal bytes like `check.mjs`'s image limit. */
export const FREE_REGISTRY_BYTES = 500e6;

/** The base URL of a Google API host; tests point every host at one fake Google. */
export const googleBase = (host) => `https://${host}`;

const READ_TIMEOUT_MS = 30_000;

/** APIs whose being off proves there's nothing of theirs to bill. */
const OPTIONAL_APIS = new Set([
  "compute.googleapis.com",
  "redis.googleapis.com",
  "vpcaccess.googleapis.com",
]);

/** What Cloud Run assumes for an annotation it leaves out. */
const ANNOTATION_DEFAULTS = {
  "autoscaling.knative.dev/minScale": "0",
  "run.googleapis.com/cpu-throttling": "true",
  "run.googleapis.com/startup-cpu-boost": "false",
};

/** Template annotations that route a service's egress through a VPC (billed connectors, NAT). */
const VPC_ANNOTATIONS = [
  "run.googleapis.com/network-interfaces",
  "run.googleapis.com/vpc-access-connector",
  "run.googleapis.com/vpc-access-egress",
];

const BASIC_ROLES = new Set(["roles/owner", "roles/editor", "roles/viewer"]);
const PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);

/** A failed Google call: the API host, the HTTP status, and Google's reason (`SERVICE_DISABLED`, …). */
export class GoogleError extends Error {
  constructor(host, status, reason, message) {
    super(message);
    this.host = host;
    this.status = status;
    this.reason = reason;
  }
}

/** A read-only client for Google's REST APIs with an OAuth access token. */
function client({ token, project, fetch, base }) {
  async function call(method, host, path, body) {
    let response;
    try {
      response = await fetch(`${base(host)}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          // Budgets (and some others) refuse a user's token without a quota project.
          "x-goog-user-project": project,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GoogleError(host, 0, "NETWORK", `${host}: ${error.message}`);
    }
    const text = await response.text();
    let json;
    try {
      json = text === "" ? {} : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (response.ok && json !== undefined) return json;
    const error = json?.error ?? {};
    const reason =
      error.details?.find((detail) => detail.reason)?.reason ??
      error.errors?.find((item) => item.reason)?.reason ??
      error.status ??
      "UNKNOWN";
    const message = error.message ?? text.slice(0, 200);
    throw new GoogleError(
      host,
      response.status,
      reason,
      `${host} answered ${response.status}: ${message}`,
    );
  }

  /** Every item of a paged list (`key` holds each page's items). */
  async function list(host, path, key) {
    const items = [];
    let pageToken = "";
    do {
      const separator = path.includes("?") ? "&" : "?";
      const page = await call(
        "GET",
        host,
        pageToken ? `${path}${separator}pageToken=${encodeURIComponent(pageToken)}` : path,
      );
      items.push(...(page[key] ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return items;
  }

  /** Every item of a Compute Engine aggregated list, from every region's scope. */
  async function aggregated(path, key) {
    const items = [];
    let pageToken = "";
    do {
      const page = await call(
        "GET",
        "compute.googleapis.com",
        pageToken ? `${path}?pageToken=${encodeURIComponent(pageToken)}` : path,
      );
      for (const [scope, value] of Object.entries(page.items ?? {})) {
        for (const item of value[key] ?? []) items.push({ ...item, scope });
      }
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return items;
  }

  return {
    get: (host, path) => call("GET", host, path),
    post: (host, path, body) => call("POST", host, path, body),
    list,
    aggregated,
  };
}

/** Whether an error says an API whose being off is fine is turned off for the project. */
const optionalApiOff = (error) =>
  error instanceof GoogleError &&
  OPTIONAL_APIS.has(error.host) &&
  (error.reason === "SERVICE_DISABLED" || error.reason === "accessNotConfigured");

const show = (value) => (value === undefined ? "unset" : JSON.stringify(value));

/** Seconds in a duration: Google's `"30s"`, `"3600.5s"`, or gcloud's `"1h"`, `"30m"`, `"7d"`. */
export function seconds(duration) {
  const match = /^([0-9]+(?:\.[0-9]+)?)([smhd])$/.exec(String(duration ?? ""));
  if (!match) return undefined;
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
}

/** Millicores in a Kubernetes CPU quantity (`"1"`, `"1000m"`, `"0.5"`). */
export function millicores(quantity) {
  const match = /^([0-9]+(?:\.[0-9]+)?)(m?)$/.exec(String(quantity ?? ""));
  if (!match) return undefined;
  return match[2] === "m" ? Number(match[1]) : Number(match[1]) * 1000;
}

/** Bytes in a Kubernetes memory quantity (`"4Gi"`, `"4096Mi"`, `"512M"`). */
export function bytes(quantity) {
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(String(quantity ?? ""));
  if (!match) return undefined;
  const unit = {
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  return Number(match[1]) * (match[2] ? unit[match[2]] : 1);
}

/** Fill `{{NAME}}` placeholders in a string. */
const fill = (text, values) =>
  text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name) => values[name] ?? whole);

/** A cleanup policy as one comparable string, from gcloud's file format or the REST API's. */
export function cleanupPolicyKey(policy) {
  const action = String(policy.action?.type ?? policy.action ?? "").toUpperCase();
  const condition = policy.condition
    ? {
        tagState: String(policy.condition.tagState ?? "").toUpperCase(),
        olderThan: seconds(policy.condition.olderThan),
        tagPrefixes: policy.condition.tagPrefixes ?? [],
        packageNamePrefixes: policy.condition.packageNamePrefixes ?? [],
      }
    : null;
  const recent = policy.mostRecentVersions
    ? {
        packageNamePrefixes: policy.mostRecentVersions.packageNamePrefixes ?? [],
        keepCount: Number(policy.mostRecentVersions.keepCount),
      }
    : null;
  return JSON.stringify({ id: policy.name ?? policy.id, action, condition, recent });
}

/** Whether a project-level binding is one Google or the project's creation puts there. */
function expectedOnProject(role, member, projectNumber) {
  // The project's owner, a person (the account that created it).
  if (role === "roles/owner" && member.startsWith("user:")) return true;
  // The Google APIs Service Agent, which Google grants Editor on every project.
  if (
    role === "roles/editor" &&
    member === `serviceAccount:${projectNumber}@cloudservices.gserviceaccount.com`
  ) {
    return true;
  }
  // Each enabled API's own service agent, with its service agent role.
  return (
    /^roles\/[A-Za-z]+\.[sS]erviceAgent$/.test(role) &&
    member.startsWith(`serviceAccount:service-${projectNumber}@`) &&
    member.endsWith(".iam.gserviceaccount.com")
  );
}

/** The `getIamPolicy` call for one of `iam.json`'s resource names. */
function policyOf(google, resource, { project, region }) {
  const v3 = "options.requestedPolicyVersion=3";
  const [kind, ...rest] = resource.split("/");
  const name = rest.at(-1);
  if (resource === "project") {
    return google.post(
      "cloudresourcemanager.googleapis.com",
      `/v1/projects/${project}:getIamPolicy`,
      {
        options: { requestedPolicyVersion: 3 },
      },
    );
  }
  if (kind === "secret") {
    return google.get(
      "secretmanager.googleapis.com",
      `/v1/projects/${project}/secrets/${name}:getIamPolicy?${v3}`,
    );
  }
  if (kind === "run") {
    return google.get(
      "run.googleapis.com",
      `/v2/projects/${project}/locations/${region}/services/${name}:getIamPolicy?${v3}`,
    );
  }
  if (kind === "cloudtasks") {
    return google.post(
      "cloudtasks.googleapis.com",
      `/v2/projects/${project}/locations/${region}/queues/${name}:getIamPolicy`,
      { options: { requestedPolicyVersion: 3 } },
    );
  }
  if (kind === "serviceAccount") {
    return google.post(
      "iam.googleapis.com",
      `/v1/projects/${project}/serviceAccounts/${name}@${project}.iam.gserviceaccount.com:getIamPolicy?${v3}`,
    );
  }
  if (kind === "pubsub") {
    return google.get(
      "pubsub.googleapis.com",
      `/v1/projects/${project}/topics/${name}:getIamPolicy?${v3}`,
    );
  }
  if (kind === "artifactregistry") {
    return google.get(
      "artifactregistry.googleapis.com",
      `/v1/projects/${project}/locations/${region}/repositories/${name}:getIamPolicy?${v3}`,
    );
  }
  throw new Error(`iam.json names a resource verify.mjs can't read: ${resource}`);
}

/**
 * Compare the live project with `infra/gcp`. `token` is an OAuth access token (`gcloud auth
 * print-access-token`); `fetch` and `base` are for tests. Resolves to the number of checks run
 * and one line per problem, in check order.
 */
export async function verifyGuardrails({ token, fetch = globalThis.fetch, base = googleBase }) {
  const iam = read("iam.json");
  const queue = read("queue.json");
  const budget = read("budget.json");
  const pubsub = read("pubsub.json");
  const registry = read("registry.json");
  const github = read("github.json");
  const services = [read("killswitch.json"), read("service.json")];
  const project = iam.project;
  const region = services[1].metadata.labels["cloud.googleapis.com/location"];
  const image = `${region}-docker.pkg.dev/${project}/${registry.repository}/${registry.image}`;
  const google = client({ token, project, fetch, base });

  const problems = [];
  let checks = 0;
  const check = (ok, message) => {
    checks += 1;
    if (!ok) problems.push(message);
  };
  const same = (what, field, live, want) =>
    check(live === want, `${what}: ${field} is ${show(live)}, infra/gcp says ${show(want)}`);
  /** Run one part; a read that fails is a problem of its own, and the other parts go on. */
  const part = async (what, run) => {
    try {
      await run();
    } catch (error) {
      check(false, `${what}: couldn't read it (${error.message})`);
    }
  };

  // The project's number fills the files' {{PROJECT_NUMBER}}; nothing else can be compared without it.
  let projectNumber;
  await part(`project ${project}`, async () => {
    const live = await google.get("cloudresourcemanager.googleapis.com", `/v1/projects/${project}`);
    projectNumber = String(live.projectNumber ?? "");
    same(`project ${project}`, "state", live.lifecycleState, "ACTIVE");
  });
  if (!projectNumber) return { checks, problems };
  const values = { PROJECT_NUMBER: projectNumber };

  // Cloud Run: the kill switch first, as the deploy does.
  const urls = new Map();
  for (const want of services) {
    const name = want.metadata.name;
    const what = `service ${name}`;
    await part(what, async () => {
      const live = await google.get(
        `${region}-run.googleapis.com`,
        `/apis/serving.knative.dev/v1/namespaces/${project}/services/${name}`,
      );
      urls.set(
        name,
        [
          live.status?.url,
          ...JSON.parse(live.metadata?.annotations?.["run.googleapis.com/urls"] ?? "[]"),
        ].filter(Boolean),
      );
      for (const [key, value] of Object.entries(want.metadata.annotations)) {
        if (key === "run.googleapis.com/launch-stage") continue;
        same(what, key, live.metadata?.annotations?.[key], value);
      }
      const template = live.spec?.template ?? {};
      const annotations = template.metadata?.annotations ?? {};
      for (const [key, value] of Object.entries(want.spec.template.metadata.annotations)) {
        same(what, key, annotations[key] ?? ANNOTATION_DEFAULTS[key], value);
      }
      for (const key of VPC_ANNOTATIONS) {
        check(
          annotations[key] === undefined,
          `${what}: ${key} is set (VPC egress is billed separately)`,
        );
      }
      const spec = template.spec ?? {};
      const wantSpec = want.spec.template.spec;
      same(what, "containerConcurrency", spec.containerConcurrency, wantSpec.containerConcurrency);
      same(what, "timeoutSeconds", spec.timeoutSeconds, wantSpec.timeoutSeconds);
      same(what, "serviceAccountName", spec.serviceAccountName, wantSpec.serviceAccountName);
      const containers = spec.containers ?? [];
      same(what, "number of containers", containers.length, 1);
      const [container = {}] = containers;
      const [wantContainer] = wantSpec.containers;
      const limits = container.resources?.limits ?? {};
      same(
        what,
        "CPU (millicores)",
        millicores(limits.cpu),
        millicores(wantContainer.resources.limits.cpu),
      );
      same(
        what,
        "memory (bytes)",
        bytes(limits.memory),
        bytes(wantContainer.resources.limits.memory),
      );
      check(
        new RegExp(`^${image.replace(/[.]/g, "\\.")}@sha256:[0-9a-f]{64}$`).test(
          container.image ?? "",
        ),
        `${what}: runs ${show(container.image)}, not ${image} pinned by digest (CI's deploy hasn't run)`,
      );
      same(
        what,
        "command",
        JSON.stringify(container.command ?? []),
        JSON.stringify(wantContainer.command ?? []),
      );
      same(
        what,
        "args",
        JSON.stringify(container.args ?? []),
        JSON.stringify(wantContainer.args ?? []),
      );
      const env = new Map((container.env ?? []).map((variable) => [variable.name, variable]));
      for (const variable of wantContainer.env) {
        const found = env.get(variable.name);
        env.delete(variable.name);
        if (variable.valueFrom) {
          const ref = variable.valueFrom.secretKeyRef;
          const liveRef = found?.valueFrom?.secretKeyRef;
          same(
            what,
            `${variable.name}'s secret`,
            liveRef && `${liveRef.name}:${liveRef.key}`,
            `${ref.name}:${ref.key}`,
          );
        } else if (/\{\{/.test(variable.value)) {
          check(Boolean(found?.value), `${what}: ${variable.name} isn't set`);
        } else {
          same(what, variable.name, found?.value, variable.value);
        }
      }
      for (const name of env.keys())
        check(false, `${what}: has a variable infra/gcp doesn't: ${name}`);
      const ready = (live.status?.conditions ?? []).find((condition) => condition.type === "Ready");
      check(
        ready?.status === "True",
        `${what}: isn't Ready (${ready?.message ?? "no Ready condition"})`,
      );
    });
  }

  // Cloud Tasks.
  await part("queue", async () => {
    const live = await google.get("cloudtasks.googleapis.com", `/v2/${queue.name}`);
    const what = `queue ${queue.name.split("/").at(-1)}`;
    for (const [field, value] of Object.entries(queue.rateLimits)) {
      same(what, field, live.rateLimits?.[field], value);
    }
    for (const [field, value] of Object.entries(queue.retryConfig)) {
      const liveValue = live.retryConfig?.[field];
      if (typeof value === "string") {
        // A zero duration is left out of Google's answer.
        same(what, `${field} (s)`, seconds(liveValue ?? "0s"), seconds(value));
      } else {
        same(what, field, liveValue, value);
      }
    }
    same(
      what,
      "samplingRatio",
      live.stackdriverLoggingConfig?.samplingRatio,
      queue.stackdriverLoggingConfig.samplingRatio,
    );
  });

  // IAM: each resource's policy holds exactly iam.json's bindings.
  const resources = new Set([
    "project",
    ...iam.serviceAccounts.map((account) => `serviceAccount/${account.id}`),
    ...iam.secrets.map((secret) => `secret/${secret}`),
    ...iam.bindings.map((binding) => binding.resource),
  ]);
  for (const resource of [...resources].sort()) {
    await part(`iam ${resource}`, async () => {
      const policy = await policyOf(google, resource, { project, region });
      const live = new Set(
        (policy.bindings ?? []).flatMap((binding) =>
          (binding.members ?? []).map((member) => `${binding.role} ${member}`),
        ),
      );
      const want = new Set(
        iam.bindings
          .filter((binding) => binding.resource === resource)
          .map((binding) => `${binding.role} ${fill(binding.member, values)}`),
      );
      for (const grant of [...want].sort()) {
        check(live.has(grant), `iam ${resource}: missing ${grant.replace(" ", " for ")}`);
      }
      for (const grant of [...live].sort()) {
        if (want.has(grant)) continue;
        const [role, member] = grant.split(" ");
        const allowed =
          resource === "project" &&
          !PUBLIC_MEMBERS.has(member) &&
          expectedOnProject(role, member, projectNumber);
        const why = PUBLIC_MEMBERS.has(member)
          ? " (anyone on the internet)"
          : BASIC_ROLES.has(role)
            ? " (a basic role)"
            : "";
        check(allowed, `iam ${resource}: unexpected ${role} for ${member}${why}`);
      }
    });
  }

  // Keyless: no service account has a key anyone could leak.
  for (const account of iam.serviceAccounts) {
    const email = `${account.id}@${project}.iam.gserviceaccount.com`;
    await part(`service account ${account.id}`, async () => {
      const keys = await google.get(
        "iam.googleapis.com",
        `/v1/projects/${project}/serviceAccounts/${email}/keys?keyTypes=USER_MANAGED`,
      );
      same(`service account ${account.id}`, "user-managed keys", (keys.keys ?? []).length, 0);
    });
  }

  // The GitHub Workload Identity provider: which CI tokens may become the deploy account.
  await part("workload identity github", async () => {
    const live = await google.get(
      "iam.googleapis.com",
      `/v1/projects/${projectNumber}/locations/global/workloadIdentityPools/${github.pool}/providers/${github.provider.id}`,
    );
    const what = `workload identity provider ${github.pool}/${github.provider.id}`;
    same(what, "attributeCondition", live.attributeCondition, github.provider.attributeCondition);
    const sorted = (mapping) => JSON.stringify(Object.entries(mapping ?? {}).sort());
    same(
      what,
      "attributeMapping",
      sorted(live.attributeMapping),
      sorted(github.provider.attributeMapping),
    );
    same(what, "issuer", live.oidc?.issuerUri, github.provider.oidc.issuerUri);
    same(what, "disabled", live.disabled ?? false, false);
  });

  // Billing and the budget that trips the kill switch.
  await part("billing", async () => {
    const info = await google.get(
      "cloudbilling.googleapis.com",
      `/v1/projects/${project}/billingInfo`,
    );
    check(
      info.billingEnabled === true,
      "billing: is off for the project (the kill switch fired, or no account is linked)",
    );
    if (!info.billingAccountName) return;
    const budgets = await google.list(
      "billingbudgets.googleapis.com",
      `/v1/${info.billingAccountName}/budgets`,
      "budgets",
    );
    const named = budgets.filter((item) => item.displayName === budget.displayName);
    same("budget", `budgets named ${budget.displayName}`, named.length, 1);
    const [live] = named;
    if (!live) return;
    const what = `budget ${budget.displayName}`;
    const filter = live.budgetFilter ?? {};
    same(
      what,
      "projects",
      JSON.stringify([...(filter.projects ?? [])].sort()),
      JSON.stringify(budget.budgetFilter.projects.map((name) => fill(name, values)).sort()),
    );
    same(
      what,
      "creditTypesTreatment",
      filter.creditTypesTreatment,
      budget.budgetFilter.creditTypesTreatment,
    );
    same(what, "calendarPeriod", filter.calendarPeriod, budget.budgetFilter.calendarPeriod);
    const amount = live.amount?.specifiedAmount ?? {};
    const wantAmount = budget.amount.specifiedAmount;
    same(what, "currency", amount.currencyCode, wantAmount.currencyCode);
    same(
      what,
      "amount",
      `${amount.units ?? "0"}.${amount.nanos ?? 0}`,
      `${wantAmount.units}.${wantAmount.nanos ?? 0}`,
    );
    const rules = (list) =>
      JSON.stringify(
        (list ?? [])
          .map((rule) => `${rule.thresholdPercent} ${rule.spendBasis ?? "CURRENT_SPEND"}`)
          .sort(),
      );
    same(what, "thresholds", rules(live.thresholdRules), rules(budget.thresholdRules));
    const notify = live.notificationsRule ?? {};
    same(what, "pubsubTopic", notify.pubsubTopic, budget.notificationsRule.pubsubTopic);
    same(what, "schemaVersion", notify.schemaVersion, budget.notificationsRule.schemaVersion);
    same(
      what,
      "disableDefaultIamRecipients",
      notify.disableDefaultIamRecipients ?? false,
      budget.notificationsRule.disableDefaultIamRecipients,
    );
  });

  // The topic, and the subscription that pushes it to the kill switch.
  await part("pubsub", async () => {
    await google.get("pubsub.googleapis.com", `/v1/${pubsub.topic.name}`);
    const want = pubsub.subscription;
    const live = await google.get("pubsub.googleapis.com", `/v1/${want.name}`);
    const what = `subscription ${want.name.split("/").at(-1)}`;
    same(what, "topic", live.topic, want.topic);
    const switchUrls = urls.get("gitinside-killswitch") ?? [];
    const push = live.pushConfig ?? {};
    check(
      switchUrls.some(
        (url) => push.pushEndpoint === fill(want.pushConfig.pushEndpoint, { KILLSWITCH_URL: url }),
      ),
      `${what}: pushes to ${show(push.pushEndpoint)}, not the kill switch's /budget (${switchUrls.join(", ") || "its URL unknown"})`,
    );
    check(
      switchUrls.some(
        (url) =>
          push.oidcToken?.audience ===
          fill(want.pushConfig.oidcToken.audience, { KILLSWITCH_URL: url }),
      ),
      `${what}: token audience is ${show(push.oidcToken?.audience)}, not the kill switch's URL`,
    );
    same(
      what,
      "push account",
      push.oidcToken?.serviceAccountEmail,
      want.pushConfig.oidcToken.serviceAccountEmail,
    );
    same(what, "ackDeadlineSeconds", live.ackDeadlineSeconds, want.ackDeadlineSeconds);
    same(
      what,
      "retention (s)",
      seconds(live.messageRetentionDuration),
      seconds(want.messageRetentionDuration),
    );
    same(
      what,
      "minimumBackoff (s)",
      seconds(live.retryPolicy?.minimumBackoff),
      seconds(want.retryPolicy.minimumBackoff),
    );
    same(
      what,
      "maximumBackoff (s)",
      seconds(live.retryPolicy?.maximumBackoff),
      seconds(want.retryPolicy.maximumBackoff),
    );
    // An empty or missing ttl means it never expires.
    same(
      what,
      "expiry",
      live.expirationPolicy?.ttl || "never",
      want.expirationPolicy.ttl || "never",
    );
    if (live.state !== undefined) same(what, "state", live.state, "ACTIVE");
  });

  // Nothing billed by the hour. An API that's off has nothing to bill.
  const none = async (what, run) =>
    part(what, async () => {
      try {
        for (const line of await run()) check(false, line);
        checks += 1;
      } catch (error) {
        if (!optionalApiOff(error)) throw error;
        checks += 1;
      }
    });
  await none("Cloud NAT", async () =>
    (
      await google.aggregated(`/compute/v1/projects/${project}/aggregated/routers`, "routers")
    ).flatMap((router) =>
      (router.nats ?? []).map(
        (nat) =>
          `Cloud NAT ${nat.name} on router ${router.name} (${router.scope}): billed by the hour`,
      ),
    ),
  );
  await none("load balancers", async () => {
    const rules = [
      ...(await google.aggregated(
        `/compute/v1/projects/${project}/aggregated/forwardingRules`,
        "forwardingRules",
      )),
      ...(
        await google.list(
          "compute.googleapis.com",
          `/compute/v1/projects/${project}/global/forwardingRules`,
          "items",
        )
      ).map((rule) => ({ ...rule, scope: "global" })),
    ];
    return unique(rules).map(
      (rule) => `forwarding rule ${rule.name} (${rule.scope}): a load balancer, billed by the hour`,
    );
  });
  await none("static IPs", async () => {
    const addresses = [
      ...(await google.aggregated(
        `/compute/v1/projects/${project}/aggregated/addresses`,
        "addresses",
      )),
      ...(
        await google.list(
          "compute.googleapis.com",
          `/compute/v1/projects/${project}/global/addresses`,
          "items",
        )
      ).map((address) => ({ ...address, scope: "global" })),
    ];
    return unique(addresses).map(
      (address) =>
        `reserved IP ${address.name} (${address.scope}, ${address.address}): billed while reserved`,
    );
  });
  await none("Memorystore", async () =>
    (
      await google.list(
        "redis.googleapis.com",
        `/v1/projects/${project}/locations/-/instances`,
        "instances",
      )
    ).map((instance) => `Memorystore instance ${instance.name}: billed by the hour`),
  );
  await none("VPC connectors", async () =>
    (
      await google.list(
        "vpcaccess.googleapis.com",
        `/v1/projects/${project}/locations/${region}/connectors`,
        "connectors",
      )
    ).map(
      (connector) =>
        `Serverless VPC Access connector ${connector.name}: runs VMs, billed by the hour`,
    ),
  );

  // Artifact Registry: the cleanup policies keep it inside the free 0.5 GB.
  await part("registry", async () => {
    const repositories = await google.list(
      "artifactregistry.googleapis.com",
      `/v1/projects/${project}/locations/${region}/repositories`,
      "repositories",
    );
    const name = `projects/${project}/locations/${region}/repositories/${registry.repository}`;
    const listed = repositories.find((repository) => repository.name === name);
    check(listed !== undefined, `registry: no repository ${registry.repository} in ${region}`);
    for (const other of repositories) {
      if (other !== listed)
        check(false, `registry: a repository infra/gcp doesn't have: ${other.name}`);
    }
    if (!listed) return;
    // `list` leaves out the cleanup policies and the dry-run flag (#19); only `get` has them.
    const live = await google.get("artifactregistry.googleapis.com", `/v1/${name}`);
    const what = `registry ${registry.repository}`;
    same(what, "format", live.format, registry.format);
    same(what, "cleanupPolicyDryRun", live.cleanupPolicyDryRun ?? false, false);
    same(
      what,
      "cleanup policies",
      JSON.stringify(
        Object.values(live.cleanupPolicies ?? {})
          .map(cleanupPolicyKey)
          .sort(),
      ),
      JSON.stringify(registry.cleanupPolicies.map(cleanupPolicyKey).sort()),
    );
    const total = repositories.reduce(
      (sum, repository) => sum + Number(repository.sizeBytes ?? 0),
      0,
    );
    check(
      total <= FREE_REGISTRY_BYTES,
      `registry: ${(total / 1e6).toFixed(1)} MB stored in ${region}, over the free ${FREE_REGISTRY_BYTES / 1e6} MB`,
    );
  });

  return { checks, problems };
}

/** Items of two lists that may overlap (an aggregated list and a global one), once each. */
function unique(items) {
  const seen = new Map();
  for (const item of items) seen.set(item.selfLink ?? `${item.scope}/${item.name}`, item);
  return [...seen.values()];
}

/** The signed-in gcloud account's access token. */
export function gcloudToken() {
  // `gcloud` is a .cmd script on Windows, which only a shell runs; the command is constant.
  const output =
    process.platform === "win32"
      ? execFileSync("gcloud auth print-access-token", { encoding: "utf8", shell: true })
      : execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" });
  return output.trim();
}

/** The CLI: print the result and resolve to the exit code (0 all match, 1 otherwise). */
export async function main({ token = gcloudToken, log = console.log, ...options } = {}) {
  let accessToken;
  try {
    accessToken = token();
  } catch (error) {
    log(
      `verify-guardrails: couldn't get a token from gcloud (sign in with gcloud auth login): ${error.message}`,
    );
    return 1;
  }
  const { checks, problems } = await verifyGuardrails({ token: accessToken, ...options });
  for (const problem of problems) log(`MISMATCH ${problem}`);
  log(
    problems.length === 0
      ? `verify-guardrails: all ${checks} checks match infra/gcp.`
      : `verify-guardrails: ${problems.length} of ${checks} checks don't match infra/gcp.`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
