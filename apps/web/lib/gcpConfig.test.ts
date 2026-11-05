// @vitest-environment node
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGET_PATH,
  GOOGLE_TIMEOUT_MS,
  HEALTH_PATH,
  killSwitchConfigFromEnv,
  overBudget,
  INSTANCE_MEMORY_MIB,
  JOB_BUDGET_MS,
  MAX_ATTEMPTS,
  MAX_TASK_AGE_SECONDS,
  workerConfigFromEnv,
} from "@gitinside/worker";
import { describe, expect, it } from "vitest";
import {
  DISPATCH_DEADLINE_SECONDS,
  QUEUE_SLOTS,
  RETRY_BACKOFF_SECONDS,
  STRANDED_AFTER_SECONDS,
  TASK_ATTEMPTS,
} from "./cloudTasks";

/**
 * `infra/gcp`'s reviewed config (ADR-0151) against the code it has to agree with: the worker's
 * budget, attempts, and signature window, the website's dispatch deadline, and the cost
 * guardrails of ADR-0111, and the billing kill switch's service, budget, and topic (ADR-0169).
 * A setting changed on one side only fails here, before a deploy.
 */

const GCP = join(dirname(fileURLToPath(import.meta.url)), "../../../infra/gcp");
const read = (name: string): unknown => JSON.parse(readFileSync(join(GCP, name), "utf8"));

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef: { name: string; key: string } };
}
interface Service {
  metadata: {
    name: string;
    namespace?: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  spec: {
    template: {
      metadata: { annotations: Record<string, string> };
      spec: {
        containerConcurrency: number;
        timeoutSeconds: number;
        serviceAccountName: string;
        containers: {
          image: string;
          command?: string[];
          args?: string[];
          ports: { containerPort: number }[];
          resources: { limits: { cpu: string; memory: string } };
          env: EnvVar[];
          startupProbe: {
            httpGet: { path: string; port: number };
            periodSeconds: number;
            timeoutSeconds: number;
            failureThreshold: number;
          };
          livenessProbe?: unknown;
        }[];
      };
    };
  };
}
interface Queue {
  name: string;
  rateLimits: { maxDispatchesPerSecond: number; maxConcurrentDispatches: number };
  retryConfig: {
    maxAttempts: number;
    maxRetryDuration: string;
    minBackoff: string;
    maxBackoff: string;
    maxDoublings: number;
  };
}
interface Iam {
  project: string;
  serviceAccounts: { id: string }[];
  googleAgents: string[];
  secrets: string[];
  bindings: { resource: string; role: string; member: string }[];
}
interface Budget {
  budgetFilter: unknown;
  amount: { specifiedAmount: { currencyCode: string; units: string } };
  thresholdRules: { thresholdPercent: number; spendBasis: string }[];
  notificationsRule: { pubsubTopic: string; schemaVersion: string };
}
interface PubSub {
  topic: { name: string };
  subscription: {
    topic: string;
    pushConfig: {
      pushEndpoint: string;
      oidcToken: { serviceAccountEmail: string; audience: string };
    };
    ackDeadlineSeconds: number;
    messageRetentionDuration: string;
    expirationPolicy: { ttl: string };
  };
}

const service = read("service.json") as Service;
const killSwitch = read("killswitch.json") as Service;
const queue = read("queue.json") as Queue;
const iam = read("iam.json") as Iam;
const budget = read("budget.json") as Budget;
const pubsub = read("pubsub.json") as PubSub;
const topicId = "billing-alerts";
const template = service.spec.template;
const [container] = template.spec.containers;
const email = (id: string) => `${id}@${iam.project}.iam.gserviceaccount.com`;
const seconds = (duration: string) => {
  const match = /^(\d+)s$/.exec(duration);
  if (!match?.[1]) throw new Error(`not a duration: ${duration}`);
  return Number(match[1]);
};
const queueName = /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/.exec(queue.name);

/**
 * Cloud Tasks' wait before each retry: `minBackoff`, doubled `maxDoublings` times, then
 * growing linearly by the last doubling's step, never past `maxBackoff`.
 */
function backoffs(config: Queue["retryConfig"]): number[] {
  const min = seconds(config.minBackoff);
  const max = seconds(config.maxBackoff);
  const waits: number[] = [];
  let wait = min;
  for (let retry = 1; retry < config.maxAttempts; retry++) {
    waits.push(Math.min(wait, max));
    wait = retry <= config.maxDoublings ? wait * 2 : wait + min * 2 ** config.maxDoublings;
  }
  return waits;
}

describe("infra/gcp service.json (Cloud Run)", () => {
  it("holds ADR-0111's guardrails: max 2 instances, scale to zero, one job each, 5 min", () => {
    const annotations = template.metadata.annotations;
    expect(annotations["autoscaling.knative.dev/maxScale"]).toBe("2");
    expect(annotations["autoscaling.knative.dev/minScale"]).toBe("0");
    expect(template.spec.containerConcurrency).toBe(1);
    expect(template.spec.timeoutSeconds).toBe(300);
    // CPU only during requests (billed per request), and no boost billed at start.
    expect(annotations["run.googleapis.com/cpu-throttling"]).toBe("true");
    expect(annotations["run.googleapis.com/startup-cpu-boost"]).toBe("false");
  });

  it("gives one job the 1 vCPU / 4 GiB its memory budget was sized for", () => {
    expect(template.spec.containers).toHaveLength(1);
    expect(container?.resources.limits).toEqual({
      cpu: "1",
      memory: `${INSTANCE_MEMORY_MIB / 1024}Gi`,
    });
  });

  it("ends every attempt inside the request timeout, and the dispatch deadline outlasts it", () => {
    // 20 s to record a failure and answer (ADR-0143).
    expect(JOB_BUDGET_MS + 20_000).toBeLessThanOrEqual(template.spec.timeoutSeconds * 1000);
    expect(DISPATCH_DEADLINE_SECONDS).toBeGreaterThan(template.spec.timeoutSeconds);
  });

  it("accepts pushes only from inside the project, and only with IAM (no public invoker)", () => {
    expect(service.metadata.annotations["run.googleapis.com/ingress"]).toBe("internal");
    expect(service.metadata.annotations).not.toHaveProperty(
      "run.googleapis.com/invoker-iam-disabled",
    );
    // Besides the invokers, only the deploy account holds a role on the services, and it
    // can't change who may invoke them (gcpDeploy.test.ts).
    const invokers = iam.bindings.filter(
      (binding) =>
        binding.role === "roles/run.invoker" ||
        (binding.resource === `run/service/${service.metadata.name}` &&
          binding.member !== `serviceAccount:${email("gitinside-deploy")}`),
    );
    expect(invokers).toEqual([
      {
        resource: `run/service/${service.metadata.name}`,
        role: "roles/run.invoker",
        member: `serviceAccount:${email("gitinside-invoker")}`,
      },
      {
        resource: `run/service/${killSwitch.metadata.name}`,
        role: "roles/run.invoker",
        member: `serviceAccount:${email("gitinside-killswitch")}`,
      },
    ]);
  });

  it("probes the worker's unauthenticated health path on its port before sending traffic", () => {
    const port = container?.ports[0]?.containerPort;
    expect(container?.startupProbe.httpGet).toEqual({ path: HEALTH_PATH, port });
    const probe = container?.startupProbe;
    // Cloud Run allows at most 240 s for a startup probe.
    expect((probe?.periodSeconds ?? 0) * (probe?.failureThreshold ?? 0)).toBeLessThanOrEqual(240);
    // A liveness probe would hit an instance that's busy with its one job.
    expect(container?.livenessProbe).toBeUndefined();
  });

  it("runs as its own runtime account, in the queue's project and region", () => {
    expect(template.spec.serviceAccountName).toBe(email("gitinside-worker"));
    // No namespace in the file: with one, `gcloud run services replace` first reads the
    // project's number from Resource Manager, which the deploy account may not (ADR-0188).
    // The deploy's `--project` names the project instead (gcpDeploy.test.ts).
    expect(service.metadata.namespace).toBeUndefined();
    expect(queueName?.[1]).toBe(iam.project);
    expect(queueName?.[2]).toBe(service.metadata.labels["cloud.googleapis.com/location"]);
  });

  it("sets every variable the worker needs, with secrets only from Secret Manager", () => {
    const env = container?.env ?? [];
    const names = env.map((variable) => variable.name);
    // Cloud Run sets PORT itself and refuses it here; the image sets HOST.
    expect(names).not.toContain("PORT");
    expect(new Set(names).size).toBe(names.length);
    for (const variable of env) {
      if (/SECRET|TOKEN|DATABASE_URL|PASSWORD/.test(variable.name)) {
        expect(variable.value, variable.name).toBeUndefined();
        expect(variable.valueFrom?.secretKeyRef.name, variable.name).toBeDefined();
      } else {
        // Plain values are placeholders the deploy fills in (M5.17e); nothing literal.
        expect(variable.value, variable.name).toBe(`{{${variable.name}}}`);
      }
    }
    const fake: Record<string, string> = {
      DATABASE_URL: "postgres://user:password@db.example:5432/gitinside",
      SNAPSHOTS_NAMESPACE: "checkns",
      SNAPSHOTS_REGION: "us-ashburn-1",
      SNAPSHOTS_BUCKET: "gitinside-check",
      SNAPSHOTS_ACCESS_KEY_ID: "check",
      SNAPSHOTS_SECRET_ACCESS_KEY: "check",
      ENQUEUE_HMAC_SECRET: "a".repeat(64),
      GITHUB_TOKEN: "github_pat_check",
    };
    expect(Object.keys(fake).sort()).toEqual([...names].sort());
    const config = workerConfigFromEnv({ ...fake, HOST: "0.0.0.0" });
    expect(config.githubToken).toBe(fake.GITHUB_TOKEN);
  });

  it("uses only the placeholders the deploy knows", () => {
    const text = readFileSync(join(GCP, "service.json"), "utf8");
    expect([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).sort()).toEqual([
      "COMMIT",
      "IMAGE",
      "SNAPSHOTS_ACCESS_KEY_ID",
      "SNAPSHOTS_BUCKET",
      "SNAPSHOTS_NAMESPACE",
      "SNAPSHOTS_REGION",
    ]);
  });
});

describe("infra/gcp queue.json (Cloud Tasks)", () => {
  it("dispatches at most one job per instance at once", () => {
    const maxScale = Number(template.metadata.annotations["autoscaling.knative.dev/maxScale"]);
    expect(queue.rateLimits.maxConcurrentDispatches).toBe(
      maxScale * template.spec.containerConcurrency,
    );
  });

  it("makes exactly the worker's attempts, governed by count alone", () => {
    expect(queue.retryConfig.maxAttempts).toBe(MAX_ATTEMPTS);
    // 0 = no time limit, so maxAttempts alone stops retries.
    expect(queue.retryConfig.maxRetryDuration).toBe("0s");
  });

  it("fits every attempt and backoff inside the signature window, leaving most of it for waiting", () => {
    const waits = backoffs(queue.retryConfig);
    expect(waits).toEqual([30, 60]);
    const span = MAX_ATTEMPTS * DISPATCH_DEADLINE_SECONDS + waits.reduce((a, b) => a + b, 0);
    expect(span).toBeLessThanOrEqual(MAX_TASK_AGE_SECONDS / 24);
  });

  it("is what the website assumes when it calls a queued row stranded (R10)", () => {
    expect(TASK_ATTEMPTS).toBe(queue.retryConfig.maxAttempts);
    expect(RETRY_BACKOFF_SECONDS).toEqual(backoffs(queue.retryConfig));
    expect(QUEUE_SLOTS).toBe(queue.rateLimits.maxConcurrentDispatches);
    const span = MAX_ATTEMPTS * DISPATCH_DEADLINE_SECONDS + 30 + 60;
    expect(STRANDED_AFTER_SECONDS).toBe(span + 120);
    // Far sooner than maintenance's day, which stays for rows nobody asks about.
    expect(STRANDED_AFTER_SECONDS).toBeLessThan(MAX_TASK_AGE_SECONDS / 24);
  });

  it("is named as the website names it", () => {
    expect(queueName?.[3]).toMatch(/^[A-Za-z0-9-]{1,100}$/);
  });
});

describe("infra/gcp iam.json", () => {
  const members = iam.bindings.map((binding) => binding.member);

  it("grants nothing to the public, nothing project-wide but the kill switch's, no basic roles", () => {
    expect(members.filter((member) => /allUsers|allAuthenticatedUsers/.test(member))).toEqual([]);
    // Unlinking billing needs a project permission (ADR-0169); nothing else is project-wide.
    expect(iam.bindings.filter((binding) => binding.resource.startsWith("project"))).toEqual([
      {
        resource: "project",
        role: "roles/billing.projectManager",
        member: `serviceAccount:${email("gitinside-killswitch")}`,
      },
    ]);
    expect(
      iam.bindings.filter((binding) => /^roles\/(owner|editor|viewer)$/.test(binding.role)),
    ).toEqual([]);
  });

  it("lets the runtime account read exactly the secrets the service mounts, and nothing else", () => {
    const mounted = (container?.env ?? []).flatMap((variable) =>
      variable.valueFrom ? [variable.valueFrom.secretKeyRef.name] : [],
    );
    expect([...iam.secrets].sort()).toEqual([...mounted].sort());
    // Secret Manager's free tier: 6 active versions a month, so one spare for a rotation.
    expect(iam.secrets.length).toBeLessThanOrEqual(5);
    const worker = iam.bindings.filter(
      (b) => b.member === `serviceAccount:${email("gitinside-worker")}`,
    );
    expect(worker.map((b) => `${b.role} ${b.resource}`).sort()).toEqual(
      mounted.map((name) => `roles/secretmanager.secretAccessor secret/${name}`).sort(),
    );
  });

  it("lets the enqueue account only add tasks to the queue, as the invoker", () => {
    const enqueue = iam.bindings.filter(
      (b) => b.member === `serviceAccount:${email("gitinside-enqueue")}`,
    );
    expect(enqueue.map((b) => `${b.role} ${b.resource}`).sort()).toEqual([
      `roles/cloudtasks.enqueuer cloudtasks/queue/${queueName?.[3]}`,
      "roles/iam.serviceAccountUser serviceAccount/gitinside-invoker",
    ]);
  });

  it("lets only Vercel's production deployments become the enqueue account", () => {
    const users = iam.bindings.filter(
      (b) => b.role === "roles/iam.workloadIdentityUser" && /\/vercel\//.test(b.member),
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.resource).toBe("serviceAccount/gitinside-enqueue");
    expect(
      iam.bindings.filter((b) => b.resource === "serviceAccount/gitinside-enqueue"),
    ).toHaveLength(1);
    expect(users[0]?.member).toMatch(
      /^principalSet:\/\/iam\.googleapis\.com\/projects\/\{\{PROJECT_NUMBER\}\}\/locations\/global\/workloadIdentityPools\/vercel\/attribute\.environment\/production$/,
    );
  });

  it("binds only the accounts it declares, and Google's own agents only where listed", () => {
    const declared = new Set(
      iam.serviceAccounts.map((account) => `serviceAccount:${email(account.id)}`),
    );
    const accounts = members.filter((member) => member.startsWith("serviceAccount:"));
    expect(
      accounts.filter((member) => !declared.has(member) && !iam.googleAgents.includes(member)),
    ).toEqual([]);
    expect(declared.size).toBe(5);
    // The budget's publisher, on the topic only.
    expect(
      iam.bindings.filter((b) => iam.googleAgents.includes(b.member)).map((b) => b.resource),
    ).toEqual([`pubsub/topic/${topicId}`]);
  });
});

describe("infra/gcp billing kill switch (killswitch.json, budget.json, pubsub.json)", () => {
  const switchTemplate = killSwitch.spec.template;
  const [switchContainer] = switchTemplate.spec.containers;
  const switchAccount = `serviceAccount:${email("gitinside-killswitch")}`;

  it("runs the worker's image with the kill switch's entry, which the build produces", () => {
    expect(switchTemplate.spec.containers).toHaveLength(1);
    expect(switchContainer?.image).toBe(container?.image);
    expect(switchContainer?.command).toEqual(["node"]);
    const [entry] = switchContainer?.args ?? [];
    expect(entry).toMatch(/^dist\/[a-z-]+\.js$/);
    const source = join(GCP, "../../apps/worker/src", `${basename(entry ?? "", ".js")}.ts`);
    expect(readFileSync(source, "utf8")).toContain("runKillSwitch(");
  });

  it("is small, scales to zero, and never runs twice at once", () => {
    const annotations = switchTemplate.metadata.annotations;
    expect(annotations["autoscaling.knative.dev/maxScale"]).toBe("1");
    expect(annotations["autoscaling.knative.dev/minScale"]).toBe("0");
    expect(annotations["run.googleapis.com/cpu-throttling"]).toBe("true");
    expect(annotations["run.googleapis.com/startup-cpu-boost"]).toBe("false");
    expect(switchTemplate.spec.containerConcurrency).toBe(1);
    expect(switchContainer?.resources.limits).toEqual({ cpu: "1", memory: "512Mi" });
  });

  it("finishes its three Google calls inside the request timeout and Pub/Sub's ack deadline", () => {
    expect(3 * GOOGLE_TIMEOUT_MS).toBeLessThanOrEqual(switchTemplate.spec.timeoutSeconds * 1000);
    expect(pubsub.subscription.ackDeadlineSeconds).toBeGreaterThanOrEqual(
      switchTemplate.spec.timeoutSeconds,
    );
  });

  it("is reached only from inside the project, with IAM, by its own account", () => {
    expect(killSwitch.metadata.annotations["run.googleapis.com/ingress"]).toBe("internal");
    expect(killSwitch.metadata.annotations).not.toHaveProperty(
      "run.googleapis.com/invoker-iam-disabled",
    );
    expect(switchTemplate.spec.serviceAccountName).toBe(email("gitinside-killswitch"));
    expect(pubsub.subscription.pushConfig.oidcToken.serviceAccountEmail).toBe(
      email("gitinside-killswitch"),
    );
    expect(
      iam.bindings.filter((b) => b.member === switchAccount).map((b) => `${b.role} ${b.resource}`),
    ).toEqual([
      `roles/run.invoker run/service/${killSwitch.metadata.name}`,
      "roles/billing.projectManager project",
    ]);
  });

  it("unlinks billing on this project, and its config is what the entry accepts", () => {
    expect(killSwitch.metadata.namespace).toBeUndefined();
    expect(killSwitch.metadata.labels).toEqual(service.metadata.labels);
    const env = Object.fromEntries(
      (switchContainer?.env ?? []).map((variable) => [variable.name, variable.value]),
    );
    expect(killSwitchConfigFromEnv(env).projectId).toBe(iam.project);
    expect(switchContainer?.env.every((variable) => variable.valueFrom === undefined)).toBe(true);
    const port = switchContainer?.ports[0]?.containerPort;
    expect(switchContainer?.startupProbe.httpGet).toEqual({ path: HEALTH_PATH, port });
  });

  it("budgets $1 a month for this project, after credits, alerting at the amount", () => {
    expect(budget.amount.specifiedAmount).toEqual({ currencyCode: "USD", units: "1" });
    expect(budget.budgetFilter).toEqual({
      projects: ["projects/{{PROJECT_NUMBER}}"],
      // What the card would actually pay: free-trial and promotional credits count.
      creditTypesTreatment: "INCLUDE_ALL_CREDITS",
      calendarPeriod: "MONTH",
    });
    const thresholds = budget.thresholdRules.map((rule) => rule.thresholdPercent);
    expect(thresholds).toContain(1);
    // Forecasts can't turn billing off: every threshold is on actual spend.
    expect(budget.thresholdRules.every((rule) => rule.spendBasis === "CURRENT_SPEND")).toBe(true);
    const units = Number(budget.amount.specifiedAmount.units);
    expect(
      overBudget({
        budgetDisplayName: "",
        costAmount: units,
        budgetAmount: units,
        currencyCode: "",
      }),
    ).toBe(true);
  });

  it("delivers the budget's notifications to the switch, and keeps them until it answers", () => {
    expect(budget.notificationsRule.pubsubTopic).toBe(pubsub.topic.name);
    expect(budget.notificationsRule.schemaVersion).toBe("1.0");
    expect(pubsub.subscription.topic).toBe(pubsub.topic.name);
    expect(pubsub.topic.name).toBe(`projects/${iam.project}/topics/${topicId}`);
    expect(pubsub.subscription.pushConfig.pushEndpoint).toBe(`{{KILLSWITCH_URL}}${BUDGET_PATH}`);
    expect(pubsub.subscription.pushConfig.oidcToken.audience).toBe("{{KILLSWITCH_URL}}");
    // Pub/Sub's longest retention: a failed unlink keeps being retried for a week.
    expect(pubsub.subscription.messageRetentionDuration).toBe("604800s");
    expect(pubsub.subscription.expirationPolicy.ttl).toBe("");
  });
});
