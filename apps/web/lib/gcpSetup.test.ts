// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The one-time Google Cloud setup (M5.17e4): `infra/gcp/README.md`'s "Applying it" commands
 * against the reviewed files they create, so the steps the owner pastes into Cloud Shell can't
 * drift from what `verify.mjs` later expects.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = (path: string) => readFileSync(join(ROOT, path), "utf8");
const read = (name: string): unknown => JSON.parse(text(`infra/gcp/${name}`));

interface Iam {
  project: string;
  serviceAccounts: { id: string; displayName: string }[];
  secrets: string[];
  bindings: { resource: string; role: string; member: string }[];
}
interface Github {
  pool: string;
  provider: {
    id: string;
    displayName: string;
    oidc: { issuerUri: string };
    attributeMapping: Record<string, string>;
    attributeCondition: string;
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
  stackdriverLoggingConfig: { samplingRatio: number };
}
interface Budget {
  displayName: string;
  budgetFilter: { projects: string[]; creditTypesTreatment: string; calendarPeriod: string };
  amount: { specifiedAmount: { currencyCode: string; units: string } };
  thresholdRules: { thresholdPercent: number; spendBasis: string }[];
  notificationsRule: { pubsubTopic: string; schemaVersion: string };
}
interface Pubsub {
  topic: { name: string };
  subscription: {
    name: string;
    topic: string;
    pushConfig: {
      pushEndpoint: string;
      oidcToken: { serviceAccountEmail: string; audience: string };
    };
    ackDeadlineSeconds: number;
    messageRetentionDuration: string;
    retryPolicy: { minimumBackoff: string; maximumBackoff: string };
  };
}
interface Registry {
  repository: string;
  format: string;
}
interface Service {
  metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> };
  spec: {
    template: {
      metadata: { annotations: Record<string, string> };
      spec: {
        containerConcurrency: number;
        timeoutSeconds: number;
        serviceAccountName: string;
        containers: { resources: { limits: { cpu: string; memory: string } } }[];
      };
    };
  };
}

const iam = read("iam.json") as Iam;
const github = read("github.json") as Github;
const queue = read("queue.json") as Queue;
const budget = read("budget.json") as Budget;
const pubsub = read("pubsub.json") as Pubsub;
const registry = read("registry.json") as Registry;
const worker = read("service.json") as Service;
const killswitch = read("killswitch.json") as Service;
const REGION = worker.metadata.labels["cloud.googleapis.com/location"] ?? "";
const email = (id: string) => `${id}@${iam.project}.iam.gserviceaccount.com`;

/** One parsed shell command: its words before the first flag, and its `--name=value` flags. */
interface Command {
  words: string[];
  flags: Map<string, string[]>;
  line: string;
}

/**
 * The README's setup block as commands: continuation lines joined, comments dropped, and the
 * block's variables filled in (`$N`, the project number, as the files' `{{PROJECT_NUMBER}}`).
 */
function setupCommands(): Command[] {
  const readme = text("infra/gcp/README.md");
  const section = readme.slice(readme.indexOf("## Applying it"));
  const block = /```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
  return block
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) =>
      line
        .replaceAll("$P", iam.project)
        .replaceAll("$R", REGION)
        .replaceAll("$N", "{{PROJECT_NUMBER}}")
        .replaceAll("$KS", "{{KILLSWITCH_URL}}"),
    )
    .map((line) => {
      const tokens = (line.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
        token.replaceAll('"', ""),
      );
      const words: string[] = [];
      const flags = new Map<string, string[]>();
      for (const token of tokens) {
        if (token.startsWith("--")) {
          const at = token.indexOf("=");
          const name = at < 0 ? token.slice(2) : token.slice(2, at);
          const value = at < 0 ? "" : token.slice(at + 1);
          flags.set(name, [...(flags.get(name) ?? []), value]);
        } else if (flags.size === 0) {
          words.push(token);
        }
      }
      return { words, flags, line };
    });
}

const commands = setupCommands();
const starting = (...prefix: string[]) =>
  commands.filter((command) => prefix.every((word, i) => command.words[i] === word));
const flag = (command: Command | undefined, name: string) => command?.flags.get(name)?.[0];

describe("the README's Google Cloud setup", () => {
  it("is found, and fills in only the variables it defines", () => {
    expect(commands.length).toBeGreaterThan(40);
    // Left after filling in: the hidden prompt's V, the billing account B (read in the block),
    // and the Vercel IDs the owner sets by hand (VT, VO, VP).
    const left = commands.flatMap(({ line }) =>
      [...line.matchAll(/\$([A-Za-z_]+)/g)].map((m) => m[1]),
    );
    expect([...new Set(left)].sort()).toEqual(["B", "V", "VO", "VP", "VT"]);
  });

  it("enables no API that bills by the hour", () => {
    const enabled = starting("gcloud", "services", "enable").flatMap((command) =>
      command.words.slice(3),
    );
    expect(enabled).toContain("run.googleapis.com");
    expect(enabled).toContain("cloudtasks.googleapis.com");
    for (const api of [
      "compute.googleapis.com",
      "redis.googleapis.com",
      "vpcaccess.googleapis.com",
    ]) {
      expect(enabled).not.toContain(api);
    }
  });

  it("creates exactly iam.json's service accounts, with their names, and no keys", () => {
    const created = starting("gcloud", "iam", "service-accounts", "create").map((command) => [
      command.words[4],
      flag(command, "display-name"),
    ]);
    expect(created).toEqual(
      iam.serviceAccounts.map((account) => [account.id, account.displayName]),
    );
    expect(starting("gcloud", "iam", "service-accounts", "keys")).toEqual([]);
  });

  it("creates exactly iam.json's secrets, in the region only, each given one value from stdin", () => {
    const created = starting("gcloud", "secrets", "create");
    expect(created.map((command) => command.words[3])).toEqual(iam.secrets);
    for (const command of created) {
      expect(flag(command, "replication-policy")).toBe("user-managed");
      expect(flag(command, "locations")).toBe(REGION);
    }
    const values = commands.filter((command) => command.line.includes("secrets versions add"));
    expect(values.map((command) => /versions add (\S+)/.exec(command.line)?.[1])).toEqual(
      iam.secrets,
    );
    for (const command of values) {
      expect(command.line).toMatch(
        /^read -rs V && printf %s "\$V" \| gcloud .* --data-file=- && unset V$/,
      );
    }
  });

  it("grants every binding in iam.json once, on its own resource, and nothing else", () => {
    const grants = commands.filter((command) => command.words.includes("add-iam-policy-binding"));
    /** iam.json's name for what a grant is on: `gcloud <group> [<kind>] add-iam-policy-binding <target>`. */
    const resourceOf = (command: Command): string => {
      const group = command.words[1];
      const target = command.words[command.words.indexOf("add-iam-policy-binding") + 1] ?? "";
      if (group === "secrets") return `secret/${target}`;
      if (group === "run") return `run/service/${target}`;
      if (group === "tasks") return `cloudtasks/queue/${target}`;
      if (group === "iam") return `serviceAccount/${target.replace(/@.*$/, "")}`;
      if (group === "projects") return target === iam.project ? "project" : `project ${target}`;
      if (group === "pubsub") return `pubsub/topic/${target}`;
      if (group === "artifacts") return `artifactregistry/repository/${target}`;
      return `unknown ${command.line}`;
    };
    for (const command of grants.filter((c) => c.words[1] === "iam")) {
      expect(command.words.at(-1)).toMatch(
        new RegExp(`@${iam.project}\\.iam\\.gserviceaccount\\.com$`),
      );
    }
    const key = (grant: { resource: string; role: string; member: string }) =>
      `${grant.resource} ${grant.role} ${grant.member}`;
    const granted = grants.map((command) =>
      key({
        resource: resourceOf(command),
        role: flag(command, "role") ?? "",
        member: flag(command, "member") ?? "",
      }),
    );
    expect(granted.sort()).toEqual(iam.bindings.map(key).sort());
    for (const command of grants) {
      const region = flag(command, "region") ?? flag(command, "location");
      if (region !== undefined) expect(region).toBe(REGION);
    }
    // A project-level grant without an explicit condition makes gcloud ask interactively.
    for (const command of starting("gcloud", "projects", "add-iam-policy-binding")) {
      expect(flag(command, "condition")).toBe("None");
    }
  });

  it("creates the queue with every setting of queue.json", () => {
    const [command, ...rest] = starting("gcloud", "tasks", "queues", "create");
    expect(rest).toEqual([]);
    expect(
      `projects/${iam.project}/locations/${flag(command, "location")}/queues/${command?.words[4]}`,
    ).toBe(queue.name);
    expect(Number(flag(command, "max-concurrent-dispatches"))).toBe(
      queue.rateLimits.maxConcurrentDispatches,
    );
    expect(Number(flag(command, "max-dispatches-per-second"))).toBe(
      queue.rateLimits.maxDispatchesPerSecond,
    );
    expect(Number(flag(command, "max-attempts"))).toBe(queue.retryConfig.maxAttempts);
    expect(flag(command, "max-retry-duration")).toBe(queue.retryConfig.maxRetryDuration);
    expect(flag(command, "min-backoff")).toBe(queue.retryConfig.minBackoff);
    expect(flag(command, "max-backoff")).toBe(queue.retryConfig.maxBackoff);
    expect(Number(flag(command, "max-doublings"))).toBe(queue.retryConfig.maxDoublings);
    expect(Number(flag(command, "log-sampling-ratio"))).toBe(
      queue.stackdriverLoggingConfig.samplingRatio,
    );
  });

  it("creates both services private and internal, as their accounts, inside service.json's limits", () => {
    const deploys = starting("gcloud", "run", "deploy");
    expect(deploys.map((command) => command.words[3])).toEqual([
      worker.metadata.name,
      killswitch.metadata.name,
    ]);
    for (const [command, service] of [
      [deploys[0], worker],
      [deploys[1], killswitch],
    ] as const) {
      const template = service.spec.template;
      const limits = template.spec.containers[0]?.resources.limits;
      expect(flag(command, "region")).toBe(REGION);
      expect(command?.flags.has("no-allow-unauthenticated")).toBe(true);
      expect(command?.flags.has("allow-unauthenticated")).toBe(false);
      expect(flag(command, "ingress")).toBe(
        service.metadata.annotations["run.googleapis.com/ingress"],
      );
      expect(flag(command, "service-account")).toBe(template.spec.serviceAccountName);
      expect(flag(command, "min-instances")).toBe(
        template.metadata.annotations["autoscaling.knative.dev/minScale"],
      );
      expect(flag(command, "max-instances")).toBe(
        template.metadata.annotations["autoscaling.knative.dev/maxScale"],
      );
      expect(Number(flag(command, "concurrency"))).toBe(template.spec.containerConcurrency);
      expect(Number(flag(command, "timeout"))).toBe(template.spec.timeoutSeconds);
      expect(flag(command, "cpu")).toBe(limits?.cpu);
      expect(flag(command, "memory")).toBe(limits?.memory);
      expect(command?.flags.has("cpu-throttling")).toBe(true);
      expect(command?.flags.has("no-cpu-boost")).toBe(true);
      // Google's public sample until CI's first deploy; never an image from elsewhere.
      expect(flag(command, "image")).toBe("us-docker.pkg.dev/cloudrun/container/hello");
    }
    expect(flag(deploys[0], "execution-environment")).toBe(
      worker.spec.template.metadata.annotations["run.googleapis.com/execution-environment"],
    );
  });

  it("creates the kill switch's topic and push subscription as pubsub.json", () => {
    const topics = starting("gcloud", "pubsub", "topics", "create").map((c) => c.words[4]);
    expect(topics.map((name) => `projects/${iam.project}/topics/${name}`)).toEqual([
      pubsub.topic.name,
    ]);
    const [command, ...rest] = starting("gcloud", "pubsub", "subscriptions", "create");
    expect(rest).toEqual([]);
    const want = pubsub.subscription;
    expect(`projects/${iam.project}/subscriptions/${command?.words[4]}`).toBe(want.name);
    expect(`projects/${iam.project}/topics/${flag(command, "topic")}`).toBe(want.topic);
    expect(flag(command, "push-endpoint")).toBe(want.pushConfig.pushEndpoint);
    expect(flag(command, "push-auth-service-account")).toBe(
      want.pushConfig.oidcToken.serviceAccountEmail,
    );
    expect(flag(command, "push-auth-token-audience")).toBe(want.pushConfig.oidcToken.audience);
    expect(Number(flag(command, "ack-deadline"))).toBe(want.ackDeadlineSeconds);
    expect(flag(command, "message-retention-duration")).toBe("7d");
    expect(want.messageRetentionDuration).toBe(`${7 * 24 * 3600}s`);
    expect(flag(command, "min-retry-delay")).toBe(want.retryPolicy.minimumBackoff);
    expect(flag(command, "max-retry-delay")).toBe(want.retryPolicy.maximumBackoff);
    expect(flag(command, "expiration-period")).toBe("never");
  });

  it("creates the budget that trips the kill switch as budget.json", () => {
    const [command, ...rest] = starting("gcloud", "billing", "budgets", "create");
    expect(rest).toEqual([]);
    const amount = budget.amount.specifiedAmount;
    expect(flag(command, "display-name")).toBe(budget.displayName);
    expect(flag(command, "budget-amount")).toBe(`${amount.units}.00${amount.currencyCode}`);
    expect(command?.flags.get("filter-projects")).toEqual(budget.budgetFilter.projects);
    expect(flag(command, "credit-types-treatment")).toBe(
      budget.budgetFilter.creditTypesTreatment.toLowerCase().replaceAll("_", "-"),
    );
    expect(flag(command, "calendar-period")).toBe(budget.budgetFilter.calendarPeriod.toLowerCase());
    expect(command?.flags.get("threshold-rule")?.map((rule) => Number(rule.split("=")[1]))).toEqual(
      budget.thresholdRules.map((rule) => rule.thresholdPercent),
    );
    expect(budget.thresholdRules.every((rule) => rule.spendBasis === "CURRENT_SPEND")).toBe(true);
    expect(flag(command, "notifications-rule-pubsub-topic")).toBe(
      budget.notificationsRule.pubsubTopic,
    );
    expect(flag(command, "notifications-rule-schema-version")).toBe(
      budget.notificationsRule.schemaVersion,
    );
  });

  it("creates the registry and applies registry.json's cleanup for real", () => {
    const [created] = starting("gcloud", "artifacts", "repositories", "create");
    expect(created?.words[4]).toBe(registry.repository);
    expect(flag(created, "repository-format")).toBe(registry.format.toLowerCase());
    expect(flag(created, "location")).toBe(REGION);
    const [cleanup] = starting("gcloud", "artifacts", "repositories", "set-cleanup-policies");
    expect(cleanup?.words[4]).toBe(registry.repository);
    expect(cleanup?.flags.has("no-dry-run")).toBe(true);
    const writer = commands.find((command) => command.line.startsWith("node -e"));
    expect(writer?.line).toContain("registry.json");
    expect(writer?.line).toContain("cleanupPolicies");
    expect(writer?.line).toContain(flag(cleanup, "policy") ?? "(no --policy)");
  });

  it("sets up the GitHub provider exactly as github.json, and a Vercel provider iam.json can name", () => {
    expect(
      starting("gcloud", "iam", "workload-identity-pools", "create").map((c) => c.words[4]),
    ).toEqual([github.pool, "vercel"]);
    const providers = starting(
      "gcloud",
      "iam",
      "workload-identity-pools",
      "providers",
      "create-oidc",
    );
    const [gh, vercel] = providers;
    expect(providers).toHaveLength(2);
    expect(gh?.words[5]).toBe(github.provider.id);
    expect(flag(gh, "workload-identity-pool")).toBe(github.pool);
    expect(flag(gh, "display-name")).toBe(github.provider.displayName);
    expect(flag(gh, "issuer-uri")).toBe(github.provider.oidc.issuerUri);
    expect(flag(gh, "attribute-condition")).toBe(github.provider.attributeCondition);
    expect(
      Object.fromEntries(
        (flag(gh, "attribute-mapping") ?? "").split(",").map((pair) => pair.split("=")),
      ),
    ).toEqual(github.provider.attributeMapping);
    // iam.json lets the pool's production principals become the enqueue account.
    const enqueue = iam.bindings.find(
      (binding) =>
        binding.role === "roles/iam.workloadIdentityUser" &&
        binding.resource === "serviceAccount/gitinside-enqueue",
    );
    expect(enqueue?.member).toContain(
      `/workloadIdentityPools/${vercel?.words[5]}/attribute.environment/production`,
    );
    expect(flag(vercel, "workload-identity-pool")).toBe(vercel?.words[5]);
    expect(flag(vercel, "attribute-mapping")).toContain(
      "attribute.environment=assertion.environment",
    );
    // Vercel's team issuer and its default audience; only this team's one project.
    expect(flag(vercel, "issuer-uri")).toBe("https://oidc.vercel.com/$VT");
    expect(flag(vercel, "allowed-audiences")).toBe("https://vercel.com/$VT");
    expect(flag(vercel, "attribute-condition")).toBe(
      "assertion.owner_id == '$VO' && assertion.project_id == '$VP'",
    );
  });

  it("gives the website the provider name serverDeps.ts accepts", () => {
    const readme = text("infra/gcp/README.md");
    const provider = /GCP_WORKLOAD_IDENTITY_PROVIDER=(\S+?)`/.exec(readme)?.[1] ?? "";
    expect(provider.replace("<N>", "123456789012")).toMatch(
      /^\/\/iam\.googleapis\.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/vercel\/providers\/vercel$/,
    );
    expect(readme).toContain(`GCP_ENQUEUE_SERVICE_ACCOUNT=${email("gitinside-enqueue")}`);
    expect(readme).toContain(`GCP_INVOKER_SERVICE_ACCOUNT=${email("gitinside-invoker")}`);
    expect(readme).toContain(`GCP_TASKS_QUEUE=${queue.name.split("/").at(-1)}`);
    expect(readme).toContain(`GCP_REGION=${REGION}`);
  });
});
