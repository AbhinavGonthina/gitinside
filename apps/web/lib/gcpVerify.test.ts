// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deployTarget, render, WEBSITE_ORIGIN } from "../../../infra/gcp/deploy.mjs";
import {
  bytes,
  cleanupPolicyKey,
  FREE_REGISTRY_BYTES,
  main,
  millicores,
  seconds,
  verifyGuardrails,
} from "../../../infra/gcp/verify.mjs";

/**
 * `verify-guardrails` (ADR-0171): `infra/gcp/verify.mjs` against a fake Google holding a
 * project built from `infra/gcp`'s own files, then changed one setting at a time. The fake
 * checks what Google checks for these reads: the bearer token, the quota project header, and
 * each API's method for `getIamPolicy`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = (path: string) => readFileSync(join(ROOT, path), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- live Google resources are deep JSON the tests edit freely
type Json = any;
const file = (name: string): Json => JSON.parse(text(`infra/gcp/${name}`));

const TOKEN = "ya29.fake-owner-token";
const PROJECT = "gitinside-513223";
const NUMBER = "123456789012";
const REGION = "us-east4";
const BILLING = "billingAccounts/000000-AAAAAA-BBBBBB";
const target = deployTarget();
const DIGEST = `${target.image}@sha256:${"ab".repeat(32)}`;
const account = (id: string) => `serviceAccount:${id}@${PROJECT}.iam.gserviceaccount.com`;
const switchUrl = `https://gitinside-killswitch-${NUMBER}.${REGION}.run.app`;

/** A non-200 answer from the fake. */
class Failure {
  constructor(
    readonly status: number,
    readonly body: Json,
  ) {}
}
const googleError = (status: number, grpc: string, message: string, reason?: string) =>
  new Failure(status, {
    error: {
      code: status,
      status: grpc,
      message,
      ...(reason
        ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] }
        : {}),
    },
  });
const serviceDisabled = (host: string) =>
  googleError(
    403,
    "PERMISSION_DENIED",
    `${host} has not been used in project ${NUMBER} before or it is disabled.`,
    "SERVICE_DISABLED",
  );

type Answer = Json | Failure | ((query: URLSearchParams) => Json | Failure);

/** A project exactly as infra/gcp describes it, as Google's APIs answer for it. */
function healthyProject() {
  const routes = new Map<string, Answer>();
  const on = (method: string, host: string, path: string, answer: Answer) =>
    routes.set(`${method} /${host}${path}`, answer);

  on("GET", "cloudresourcemanager.googleapis.com", `/v1/projects/${PROJECT}`, {
    projectId: PROJECT,
    projectNumber: NUMBER,
    lifecycleState: "ACTIVE",
  });

  const values = {
    IMAGE: DIGEST,
    SNAPSHOTS_NAMESPACE: "axabcdefgh",
    SNAPSHOTS_REGION: "us-ashburn-1",
    SNAPSHOTS_BUCKET: "gitinside-snapshots",
    SNAPSHOTS_ACCESS_KEY_ID: "0123456789abcdef",
    COMMIT: "0123456789abcdef0123456789abcdef01234567",
    WEBSITE_ORIGIN,
  };
  const service = (name: string): Json => ({
    ...JSON.parse(render(text(`infra/gcp/${name}`), values)),
    status: {
      url: `https://${name === "service.json" ? "gitinside-worker" : "gitinside-killswitch"}-${NUMBER}.${REGION}.run.app`,
      conditions: [{ type: "Ready", status: "True" }],
    },
  });
  const worker = service("service.json");
  const killswitch = service("killswitch.json");
  for (const live of [worker, killswitch]) {
    on(
      "GET",
      `${REGION}-run.googleapis.com`,
      `/apis/serving.knative.dev/v1/namespaces/${PROJECT}/services/${live.metadata.name}`,
      live,
    );
  }

  const queue: Json = structuredClone(file("queue.json"));
  queue.state = "RUNNING";
  queue.rateLimits.maxBurstSize = 1;
  // Google leaves a zero duration out.
  delete queue.retryConfig.maxRetryDuration;
  on("GET", "cloudtasks.googleapis.com", `/v2/${queue.name}`, queue);

  // Every IAM policy, from iam.json's bindings; the project's also has what Google puts there.
  const iam = file("iam.json");
  const policies = new Map<string, Json>();
  const policy = (resource: string): Json => {
    if (!policies.has(resource)) policies.set(resource, { version: 1, etag: "BwY=", bindings: [] });
    return policies.get(resource);
  };
  const grant = (resource: string, role: string, member: string) => {
    const bindings = policy(resource).bindings;
    const binding = bindings.find((b: Json) => b.role === role);
    if (binding) binding.members.push(member);
    else bindings.push({ role, members: [member] });
  };
  for (const binding of iam.bindings) {
    grant(binding.resource, binding.role, binding.member.replace("{{PROJECT_NUMBER}}", NUMBER));
  }
  grant("project", "roles/owner", "user:owner@example.com");
  grant("project", "roles/editor", `serviceAccount:${NUMBER}@cloudservices.gserviceaccount.com`);
  grant(
    "project",
    "roles/run.serviceAgent",
    `serviceAccount:service-${NUMBER}@serverless-robot-prod.iam.gserviceaccount.com`,
  );
  grant(
    "project",
    "roles/cloudtasks.serviceAgent",
    `serviceAccount:service-${NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com`,
  );
  for (const id of iam.serviceAccounts.map((a: Json) => a.id)) policy(`serviceAccount/${id}`);
  for (const secret of iam.secrets) policy(`secret/${secret}`);
  const v1 = (path: string) => `/v1/projects/${PROJECT}${path}`;
  const at = (path: string) => `/v1/projects/${PROJECT}/locations/${REGION}${path}`;
  for (const [resource, value] of policies) {
    const [kind, ...rest] = resource.split("/");
    const name = rest.at(-1);
    if (resource === "project") {
      on(
        "POST",
        "cloudresourcemanager.googleapis.com",
        `/v1/projects/${PROJECT}:getIamPolicy`,
        value,
      );
    } else if (kind === "secret") {
      on("GET", "secretmanager.googleapis.com", v1(`/secrets/${name}:getIamPolicy`), value);
    } else if (kind === "run") {
      on(
        "GET",
        "run.googleapis.com",
        `/v2/projects/${PROJECT}/locations/${REGION}/services/${name}:getIamPolicy`,
        value,
      );
    } else if (kind === "cloudtasks") {
      on(
        "POST",
        "cloudtasks.googleapis.com",
        `/v2/projects/${PROJECT}/locations/${REGION}/queues/${name}:getIamPolicy`,
        value,
      );
    } else if (kind === "serviceAccount") {
      const email = `${name}@${PROJECT}.iam.gserviceaccount.com`;
      on("POST", "iam.googleapis.com", v1(`/serviceAccounts/${email}:getIamPolicy`), value);
    } else if (kind === "pubsub") {
      on("GET", "pubsub.googleapis.com", v1(`/topics/${name}:getIamPolicy`), value);
    } else if (kind === "artifactregistry") {
      on("GET", "artifactregistry.googleapis.com", at(`/repositories/${name}:getIamPolicy`), value);
    } else {
      throw new Error(`the fake has no route for ${resource}`);
    }
  }

  // No account has a key: Google answers an empty object.
  const keys = new Map<string, Json>();
  for (const id of iam.serviceAccounts.map((a: Json) => a.id)) {
    const value = {};
    keys.set(id, value);
    const email = `${id}@${PROJECT}.iam.gserviceaccount.com`;
    on("GET", "iam.googleapis.com", v1(`/serviceAccounts/${email}/keys`), value);
  }

  const github = file("github.json");
  const provider: Json = {
    name: `projects/${NUMBER}/locations/global/workloadIdentityPools/github/providers/github`,
    displayName: github.provider.displayName,
    state: "ACTIVE",
    attributeMapping: { ...github.provider.attributeMapping },
    attributeCondition: github.provider.attributeCondition,
    oidc: { issuerUri: github.provider.oidc.issuerUri },
  };
  on("GET", "iam.googleapis.com", `/v1/${provider.name}`, provider);

  const billing: Json = {
    name: `projects/${PROJECT}/billingInfo`,
    projectId: PROJECT,
    billingAccountName: BILLING,
    billingEnabled: true,
  };
  on("GET", "cloudbilling.googleapis.com", v1("/billingInfo"), billing);
  const wanted = file("budget.json");
  const budget: Json = {
    name: `${BILLING}/budgets/0f1e2d3c`,
    displayName: wanted.displayName,
    budgetFilter: {
      projects: [`projects/${NUMBER}`],
      creditTypesTreatment: wanted.budgetFilter.creditTypesTreatment,
      calendarPeriod: wanted.budgetFilter.calendarPeriod,
    },
    amount: { specifiedAmount: { currencyCode: "USD", units: "1" } },
    thresholdRules: structuredClone(wanted.thresholdRules),
    // Google leaves out a false boolean.
    notificationsRule: {
      pubsubTopic: wanted.notificationsRule.pubsubTopic,
      schemaVersion: wanted.notificationsRule.schemaVersion,
    },
    etag: "abc",
  };
  const budgets: Json = { budgets: [budget] };
  on("GET", "billingbudgets.googleapis.com", `/v1/${BILLING}/budgets`, budgets);

  const pubsub = file("pubsub.json");
  on("GET", "pubsub.googleapis.com", `/v1/${pubsub.topic.name}`, { name: pubsub.topic.name });
  const subscription: Json = {
    ...JSON.parse(JSON.stringify(pubsub.subscription).replaceAll("{{KILLSWITCH_URL}}", switchUrl)),
    expirationPolicy: {},
    state: "ACTIVE",
  };
  on("GET", "pubsub.googleapis.com", `/v1/${subscription.name}`, subscription);

  // Compute Engine is on, with nothing in it; Memorystore is off; Serverless VPC Access is on, empty.
  const compute = `/compute/v1/projects/${PROJECT}`;
  const empty = () => ({
    items: { [`regions/${REGION}`]: { warning: { code: "NO_RESULTS_ON_PAGE" } } },
  });
  const routers: Json = empty();
  const forwardingRules: Json = empty();
  const addresses: Json = empty();
  const globalRules: Json = {};
  const globalAddresses: Json = {};
  on("GET", "compute.googleapis.com", `${compute}/aggregated/routers`, routers);
  on("GET", "compute.googleapis.com", `${compute}/aggregated/forwardingRules`, forwardingRules);
  on("GET", "compute.googleapis.com", `${compute}/aggregated/addresses`, addresses);
  on("GET", "compute.googleapis.com", `${compute}/global/forwardingRules`, globalRules);
  on("GET", "compute.googleapis.com", `${compute}/global/addresses`, globalAddresses);
  on(
    "GET",
    "redis.googleapis.com",
    v1("/locations/-/instances"),
    serviceDisabled("redis.googleapis.com"),
  );
  const connectors: Json = {};
  on("GET", "vpcaccess.googleapis.com", at("/connectors"), connectors);

  const registry: Json = {
    name: `projects/${PROJECT}/locations/${REGION}/repositories/gitinside`,
    format: "DOCKER",
    sizeBytes: "171800000",
    cleanupPolicies: {
      "keep-recent": {
        id: "keep-recent",
        action: "KEEP",
        mostRecentVersions: { packageNamePrefixes: ["worker"], keepCount: 3 },
      },
      "delete-older": {
        id: "delete-older",
        action: "DELETE",
        condition: { tagState: "ANY", olderThan: "3600s" },
      },
    },
  };
  on("GET", "artifactregistry.googleapis.com", `/v1/${registry.name}`, registry);
  // `repositories.list` leaves out the cleanup policies and the dry-run flag (#19: the live
  // project's list answer had none, while `gcloud artifacts repositories describe`, a `get`,
  // showed both); only `get` has them.
  const repositories: Json = { repositories: [registry] };
  on("GET", "artifactregistry.googleapis.com", at("/repositories"), () => ({
    repositories: repositories.repositories.map((repository: Json) => {
      const { cleanupPolicies: _policies, cleanupPolicyDryRun: _dryRun, ...listed } = repository;
      return listed;
    }),
  }));

  return {
    routes,
    on,
    worker,
    killswitch,
    queue,
    policy,
    keys,
    provider,
    billing,
    budget,
    budgets,
    subscription,
    routers,
    globalRules,
    addresses,
    connectors,
    registry,
    repositories,
  };
}

let project = healthyProject();
let server: Server;
let base: (host: string) => string;
const requests: {
  method: string;
  path: string;
  authorization: string | undefined;
  userProject: string | undefined;
}[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        authorization: req.headers.authorization,
        userProject: req.headers["x-goog-user-project"] as string | undefined,
      });
      const send = (status: number, body: Json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        const failure = googleError(401, "UNAUTHENTICATED", "Request had invalid credentials.");
        return send(failure.status, failure.body);
      }
      if (req.headers["x-goog-user-project"] !== PROJECT) {
        const failure = googleError(403, "PERMISSION_DENIED", "This API requires a quota project.");
        return send(failure.status, failure.body);
      }
      const route = project.routes.get(`${req.method} ${url.pathname}`);
      const answer = typeof route === "function" ? route(url.searchParams) : route;
      if (answer === undefined) {
        const failure = googleError(404, "NOT_FOUND", `no ${req.method} ${url.pathname}`);
        return send(failure.status, failure.body);
      }
      if (answer instanceof Failure) return send(answer.status, answer.body);
      return send(200, answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = (host) => `http://127.0.0.1:${port}/${host}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  project = healthyProject();
  requests.length = 0;
});

const verify = () => verifyGuardrails({ token: TOKEN, base });
const templateAnnotations = (live: Json) => live.spec.template.metadata.annotations;
const container = (live: Json) => live.spec.template.spec.containers[0];

describe("a project as infra/gcp describes it", () => {
  it("passes every check, reading only, with the token and the quota project on each request", async () => {
    const { checks, problems } = await verify();
    expect(problems).toEqual([]);
    expect(checks).toBeGreaterThan(100);
    expect(requests.length).toBeGreaterThan(30);
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.userProject).toBe(PROJECT);
      // Reads only: GETs, and POSTs only to getIamPolicy.
      if (request.method !== "GET") {
        expect(request.method).toBe("POST");
        expect(request.path).toMatch(/:getIamPolicy$/);
      }
    }
  });

  it("reads every resource iam.json names", async () => {
    await verify();
    const iam = file("iam.json");
    const policyReads = requests.filter((r) => r.path.endsWith(":getIamPolicy")).map((r) => r.path);
    const resources = new Set<string>(iam.bindings.map((b: Json) => b.resource));
    for (const resource of resources) {
      const name = resource === "project" ? PROJECT : resource.split("/").at(-1);
      expect(
        policyReads.some((path) => path.includes(`/${name}`)),
        resource,
      ).toBe(true);
    }
    // Plus each account and secret, even one with no binding.
    expect(policyReads).toHaveLength(
      new Set([
        ...resources,
        "project",
        ...iam.serviceAccounts.map((a: Json) => `serviceAccount/${a.id}`),
        ...iam.secrets.map((s: string) => `secret/${s}`),
      ]).size,
    );
  });

  it("takes what Google leaves out for its defaults, and equal quantities in other units", async () => {
    for (const live of [project.worker, project.killswitch]) {
      const annotations = templateAnnotations(live);
      delete annotations["autoscaling.knative.dev/minScale"];
      delete annotations["run.googleapis.com/cpu-throttling"];
      delete annotations["run.googleapis.com/startup-cpu-boost"];
      container(live).resources.limits.cpu = "1000m";
    }
    container(project.worker).resources.limits.memory = "4096Mi";
    expect((await verify()).problems).toEqual([]);
  });

  it("finds the budget on a later page", async () => {
    project.on(
      "GET",
      "billingbudgets.googleapis.com",
      `/v1/${BILLING}/budgets`,
      (query: URLSearchParams) =>
        query.get("pageToken") === "next"
          ? { budgets: [project.budget] }
          : {
              budgets: [{ ...project.budget, displayName: "something else" }],
              nextPageToken: "next",
            },
    );
    expect((await verify()).problems).toEqual([]);
  });

  it("accepts the kill switch's other URL in the subscription", async () => {
    const other = "https://gitinside-killswitch-abcdefghij-uk.a.run.app";
    project.killswitch.metadata.annotations["run.googleapis.com/urls"] = JSON.stringify([
      project.killswitch.status.url,
      other,
    ]);
    project.subscription.pushConfig.pushEndpoint = `${other}/budget`;
    project.subscription.pushConfig.oidcToken.audience = other;
    expect((await verify()).problems).toEqual([]);
  });

  it("counts an API that's off as nothing to bill, for Compute Engine and VPC Access only", async () => {
    for (const path of ["routers", "forwardingRules", "addresses"]) {
      project.on(
        "GET",
        "compute.googleapis.com",
        `/compute/v1/projects/${PROJECT}/aggregated/${path}`,
        serviceDisabled("compute.googleapis.com"),
      );
    }
    project.on(
      "GET",
      "vpcaccess.googleapis.com",
      `/v1/projects/${PROJECT}/locations/${REGION}/connectors`,
      serviceDisabled("vpcaccess.googleapis.com"),
    );
    expect((await verify()).problems).toEqual([]);

    project.on(
      "GET",
      "cloudtasks.googleapis.com",
      `/v2/projects/${PROJECT}/locations/${REGION}/queues/analyses`,
      serviceDisabled("cloudtasks.googleapis.com"),
    );
    const { problems } = await verify();
    expect(problems).toEqual([
      expect.stringMatching(/^queue: couldn't read it \(cloudtasks\.googleapis\.com answered 403/),
    ]);
  });
});

/** One setting changed from infra/gcp, and the one line it must produce. */
const deviations: [string, (p: ReturnType<typeof healthyProject>) => void, RegExp][] = [
  [
    "the worker scales past 2",
    (p) => (templateAnnotations(p.worker)["autoscaling.knative.dev/maxScale"] = "3"),
    /^service gitinside-worker: autoscaling\.knative\.dev\/maxScale is "3", infra\/gcp says "2"$/,
  ],
  [
    "the worker keeps an instance warm",
    (p) => (templateAnnotations(p.worker)["autoscaling.knative.dev/minScale"] = "1"),
    /^service gitinside-worker: autoscaling\.knative\.dev\/minScale is "1", infra\/gcp says "0"$/,
  ],
  [
    "the kill switch scales past 1",
    (p) => (templateAnnotations(p.killswitch)["autoscaling.knative.dev/maxScale"] = "4"),
    /^service gitinside-killswitch: autoscaling\.knative\.dev\/maxScale is "4"/,
  ],
  [
    "the worker takes 80 requests at once",
    (p) => (p.worker.spec.template.spec.containerConcurrency = 80),
    /^service gitinside-worker: containerConcurrency is 80, infra\/gcp says 1$/,
  ],
  [
    "the worker's timeout is an hour",
    (p) => (p.worker.spec.template.spec.timeoutSeconds = 3600),
    /^service gitinside-worker: timeoutSeconds is 3600, infra\/gcp says 300$/,
  ],
  [
    "the worker has 8 GiB",
    (p) => (container(p.worker).resources.limits.memory = "8Gi"),
    /^service gitinside-worker: memory \(bytes\) is 8589934592, infra\/gcp says 4294967296$/,
  ],
  [
    "the worker has 2 vCPUs",
    (p) => (container(p.worker).resources.limits.cpu = "2"),
    /^service gitinside-worker: CPU \(millicores\) is 2000, infra\/gcp says 1000$/,
  ],
  [
    "the worker is open to the internet",
    (p) => (p.worker.metadata.annotations["run.googleapis.com/ingress"] = "all"),
    /^service gitinside-worker: run\.googleapis\.com\/ingress is "all", infra\/gcp says "internal"$/,
  ],
  [
    "the worker has CPU always allocated",
    (p) => (templateAnnotations(p.worker)["run.googleapis.com/cpu-throttling"] = "false"),
    /cpu-throttling is "false", infra\/gcp says "true"$/,
  ],
  [
    "the kill switch boosts CPU at start",
    (p) => (templateAnnotations(p.killswitch)["run.googleapis.com/startup-cpu-boost"] = "true"),
    /^service gitinside-killswitch: run\.googleapis\.com\/startup-cpu-boost is "true"/,
  ],
  [
    "the worker egresses through a VPC connector",
    (p) =>
      (templateAnnotations(p.worker)["run.googleapis.com/vpc-access-connector"] = "connector-1"),
    /^service gitinside-worker: run\.googleapis\.com\/vpc-access-connector is set/,
  ],
  [
    "the worker still runs Google's sample image",
    (p) => (container(p.worker).image = "us-docker.pkg.dev/cloudrun/container/hello"),
    /^service gitinside-worker: runs "us-docker\.pkg\.dev\/cloudrun\/container\/hello", not .*pinned by digest/,
  ],
  [
    "the worker runs its image by tag",
    (p) => (container(p.worker).image = `${target.image}:latest`),
    /^service gitinside-worker: runs ".*:latest", not/,
  ],
  [
    "the kill switch runs the worker's command",
    (p) => (container(p.killswitch).args = ["dist/main.js"]),
    /^service gitinside-killswitch: args is "\[\\"dist\/main\.js\\"\]"/,
  ],
  [
    "the kill switch's revision failed",
    (p) =>
      (p.killswitch.status.conditions = [
        { type: "Ready", status: "False", message: "container failed to start" },
      ]),
    /^service gitinside-killswitch: isn't Ready \(container failed to start\)$/,
  ],
  [
    "the worker has a variable added by hand",
    (p) => container(p.worker).env.push({ name: "DEBUG", value: "1" }),
    /^service gitinside-worker: has a variable infra\/gcp doesn't: DEBUG$/,
  ],
  [
    "the worker reads another secret for its database",
    (p) => (container(p.worker).env[4].valueFrom.secretKeyRef.name = "other-secret"),
    /^service gitinside-worker: DATABASE_URL's secret is "other-secret:latest"/,
  ],
  [
    "the worker's account is the default compute account",
    (p) =>
      (p.worker.spec.template.spec.serviceAccountName = `${NUMBER}-compute@developer.gserviceaccount.com`),
    /^service gitinside-worker: serviceAccountName is "123456789012-compute@/,
  ],
  [
    "the queue dispatches 1,000 at once",
    (p) => (p.queue.rateLimits.maxConcurrentDispatches = 1000),
    /^queue analyses: maxConcurrentDispatches is 1000, infra\/gcp says 2$/,
  ],
  [
    "the queue retries 100 times",
    (p) => (p.queue.retryConfig.maxAttempts = 100),
    /^queue analyses: maxAttempts is 100, infra\/gcp says 3$/,
  ],
  [
    "the queue retries for an hour",
    (p) => (p.queue.retryConfig.maxRetryDuration = "3600s"),
    /^queue analyses: maxRetryDuration \(s\) is 3600, infra\/gcp says 0$/,
  ],
  [
    "anyone may invoke the worker",
    (p) =>
      p
        .policy("run/service/gitinside-worker")
        .bindings.push({ role: "roles/run.invoker", members: ["allUsers"] }),
    /^iam run\/service\/gitinside-worker: unexpected roles\/run\.invoker for allUsers \(anyone on the internet\)$/,
  ],
  [
    "the default compute account has Editor",
    (p) =>
      p
        .policy("project")
        .bindings.find((b: Json) => b.role === "roles/editor")
        .members.push(`serviceAccount:${NUMBER}-compute@developer.gserviceaccount.com`),
    /^iam project: unexpected roles\/editor for serviceAccount:123456789012-compute@developer\.gserviceaccount\.com \(a basic role\)$/,
  ],
  [
    "the project is viewable by anyone",
    (p) => p.policy("project").bindings.push({ role: "roles/viewer", members: ["allUsers"] }),
    /^iam project: unexpected roles\/viewer for allUsers \(anyone on the internet\)$/,
  ],
  [
    "a person has Editor (only owners are expected)",
    (p) =>
      p
        .policy("project")
        .bindings.find((b: Json) => b.role === "roles/editor")
        .members.push("user:helper@example.com"),
    /^iam project: unexpected roles\/editor for user:helper@example\.com \(a basic role\)$/,
  ],
  [
    "a service agent role held by an account that isn't Google's",
    (p) =>
      p.policy("project").bindings.push({
        role: "roles/run.serviceAgent",
        members: [account("gitinside-worker")],
      }),
    /^iam project: unexpected roles\/run\.serviceAgent for serviceAccount:gitinside-worker@/,
  ],
  [
    "the kill switch can't unlink billing",
    (p) =>
      (p.policy("project").bindings = p
        .policy("project")
        .bindings.filter((b: Json) => b.role !== "roles/billing.projectManager")),
    /^iam project: missing roles\/billing\.projectManager for serviceAccount:gitinside-killswitch@/,
  ],
  [
    "the invoker can read a secret",
    (p) =>
      p.policy("secret/worker-github-token").bindings[0].members.push(account("gitinside-invoker")),
    /^iam secret\/worker-github-token: unexpected roles\/secretmanager\.secretAccessor for serviceAccount:gitinside-invoker@/,
  ],
  [
    "the deploy account has a key",
    (p) => (p.keys.get("gitinside-deploy").keys = [{ name: "k1", keyType: "USER_MANAGED" }]),
    /^service account gitinside-deploy: user-managed keys is 1, infra\/gcp says 0$/,
  ],
  [
    "the GitHub provider admits any repository",
    (p) => (p.provider.attributeCondition = "assertion.ref == 'refs/heads/main'"),
    /^workload identity provider github\/github: attributeCondition is "assertion\.ref == 'refs\/heads\/main'"/,
  ],
  ["billing is off", (p) => (p.billing.billingEnabled = false), /^billing: is off for the project/],
  [
    "the budget is 100 USD",
    (p) => (p.budget.amount.specifiedAmount.units = "100"),
    /^budget gitinside-kill-switch: amount is "100\.0", infra\/gcp says "1\.0"$/,
  ],
  [
    "the budget leaves out credits",
    (p) => (p.budget.budgetFilter.creditTypesTreatment = "EXCLUDE_ALL_CREDITS"),
    /^budget gitinside-kill-switch: creditTypesTreatment is "EXCLUDE_ALL_CREDITS"/,
  ],
  [
    "the budget covers every project of the account",
    (p) => delete p.budget.budgetFilter.projects,
    /^budget gitinside-kill-switch: projects is "\[\]"/,
  ],
  [
    "the budget publishes nowhere",
    (p) => delete p.budget.notificationsRule.pubsubTopic,
    /^budget gitinside-kill-switch: pubsubTopic is unset/,
  ],
  [
    "there's no budget",
    (p) => (p.budgets.budgets = []),
    /^budget: budgets named gitinside-kill-switch is 0, infra\/gcp says 1$/,
  ],
  [
    "the subscription pushes somewhere else",
    (p) => (p.subscription.pushConfig.pushEndpoint = "https://example.com/budget"),
    /^subscription billing-alerts-killswitch: pushes to "https:\/\/example\.com\/budget", not the kill switch's \/budget/,
  ],
  [
    "the subscription expires after 31 days idle",
    (p) => (p.subscription.expirationPolicy = { ttl: "2678400s" }),
    /^subscription billing-alerts-killswitch: expiry is "2678400s", infra\/gcp says "never"$/,
  ],
  [
    "a Cloud NAT gateway",
    (p) =>
      (p.routers.items[`regions/${REGION}`] = {
        routers: [{ name: "router-1", nats: [{ name: "nat-1" }] }],
      }),
    /^Cloud NAT nat-1 on router router-1 \(regions\/us-east4\): billed by the hour$/,
  ],
  [
    "a global load balancer",
    (p) => (p.globalRules.items = [{ name: "lb-1", selfLink: "https://x/global/lb-1" }]),
    /^forwarding rule lb-1 \(global\): a load balancer, billed by the hour$/,
  ],
  [
    "a reserved regional IP",
    (p) =>
      (p.addresses.items[`regions/${REGION}`] = {
        addresses: [{ name: "ip-1", address: "203.0.113.7" }],
      }),
    /^reserved IP ip-1 \(regions\/us-east4, 203\.0\.113\.7\): billed while reserved$/,
  ],
  [
    "a Memorystore instance",
    (p) =>
      p.on("GET", "redis.googleapis.com", `/v1/projects/${PROJECT}/locations/-/instances`, {
        instances: [{ name: `projects/${PROJECT}/locations/${REGION}/instances/cache` }],
      }),
    /^Memorystore instance projects\/gitinside-513223\/locations\/us-east4\/instances\/cache: billed by the hour$/,
  ],
  [
    "a Serverless VPC Access connector",
    (p) => (p.connectors.connectors = [{ name: "connector-1" }]),
    /^Serverless VPC Access connector connector-1: runs VMs, billed by the hour$/,
  ],
  [
    "the registry's cleanup is a dry run",
    (p) => (p.registry.cleanupPolicyDryRun = true),
    /^registry gitinside: cleanupPolicyDryRun is true, infra\/gcp says false$/,
  ],
  [
    "the registry keeps 30 versions",
    (p) => (p.registry.cleanupPolicies["keep-recent"].mostRecentVersions.keepCount = 30),
    /^registry gitinside: cleanup policies is /,
  ],
  [
    "the registry has no cleanup policies",
    (p) => delete p.registry.cleanupPolicies,
    /^registry gitinside: cleanup policies is "\[\]"/,
  ],
  [
    "the registry is listed but can't be read",
    (p) =>
      p.on(
        "GET",
        "artifactregistry.googleapis.com",
        `/v1/${p.registry.name}`,
        googleError(403, "PERMISSION_DENIED", "denied"),
      ),
    /^registry: couldn't read it \(artifactregistry\.googleapis\.com answered 403: denied\)$/,
  ],
  [
    "the registry is past the free 0.5 GB",
    (p) => (p.registry.sizeBytes = String(FREE_REGISTRY_BYTES + 1)),
    /^registry: 500\.0 MB stored in us-east4, over the free 500 MB$/,
  ],
  [
    "a second repository from a source deploy",
    (p) =>
      p.repositories.repositories.push({
        name: `projects/${PROJECT}/locations/${REGION}/repositories/cloud-run-source-deploy`,
        sizeBytes: "1000",
      }),
    /^registry: a repository infra\/gcp doesn't have: .*cloud-run-source-deploy$/,
  ],
  [
    "the owner can't read budgets",
    (p) =>
      p.on(
        "GET",
        "billingbudgets.googleapis.com",
        `/v1/${BILLING}/budgets`,
        googleError(403, "PERMISSION_DENIED", "The caller does not have permission"),
      ),
    /^billing: couldn't read it \(billingbudgets\.googleapis\.com answered 403: The caller does not have permission\)$/,
  ],
];

describe("each setting that differs from infra/gcp is one line", () => {
  it.each(deviations)("%s", async (_, change, line) => {
    change(project);
    const { problems } = await verify();
    expect(problems).toEqual([expect.stringMatching(line)]);
  });
});

describe("what it can't read", () => {
  it("stops at once when the project itself can't be read", async () => {
    project.on(
      "GET",
      "cloudresourcemanager.googleapis.com",
      `/v1/projects/${PROJECT}`,
      googleError(403, "PERMISSION_DENIED", "denied"),
    );
    const { checks, problems } = await verify();
    expect(problems).toEqual([
      "project gitinside-513223: couldn't read it (cloudresourcemanager.googleapis.com answered 403: denied)",
    ]);
    expect(checks).toBe(1);
  });

  it("reports each part of a missing service, and goes on with the rest", async () => {
    project.routes.delete(
      `GET /${REGION}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${PROJECT}/services/gitinside-killswitch`,
    );
    const { problems } = await verify();
    expect(problems).toEqual([
      expect.stringMatching(/^service gitinside-killswitch: couldn't read it \(.* answered 404/),
      // Without the switch's URL, its subscription can't be confirmed.
      expect.stringMatching(
        /^subscription billing-alerts-killswitch: pushes to .*its URL unknown\)$/,
      ),
      expect.stringMatching(/^subscription billing-alerts-killswitch: token audience is/),
    ]);
  });

  it("never passes a check on a wrong token", async () => {
    const { problems } = await verifyGuardrails({ token: "ya29.other", base });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/answered 401/);
  });
});

describe("the CLI", () => {
  it("prints one line per mismatch and exits 1, or a summary and exits 0", async () => {
    const lines: string[] = [];
    expect(await main({ token: () => TOKEN, base, log: (line) => lines.push(line) })).toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(/^verify-guardrails: all [0-9]+ checks match infra\/gcp\.$/),
    ]);

    lines.length = 0;
    project.billing.billingEnabled = false;
    templateAnnotations(project.worker)["autoscaling.knative.dev/maxScale"] = "100";
    expect(await main({ token: () => TOKEN, base, log: (line) => lines.push(line) })).toBe(1);
    expect(lines).toEqual([
      expect.stringMatching(/^MISMATCH service gitinside-worker: autoscaling/),
      expect.stringMatching(/^MISMATCH billing: is off/),
      expect.stringMatching(/^verify-guardrails: 2 of [0-9]+ checks don't match infra\/gcp\.$/),
    ]);
  });

  it("exits 1 without a gcloud token, sending nothing", async () => {
    const lines: string[] = [];
    const token = () => {
      throw new Error("gcloud: not found");
    };
    expect(await main({ token, base, log: (line) => lines.push(line) })).toBe(1);
    expect(lines).toEqual([
      expect.stringMatching(/couldn't get a token from gcloud.*gcloud: not found/),
    ]);
    expect(requests).toEqual([]);
  });

  it("is the root's `pnpm verify-guardrails`", () => {
    expect(JSON.parse(text("package.json")).scripts["verify-guardrails"]).toBe(
      "node infra/gcp/verify.mjs",
    );
  });
});

describe("units", () => {
  it("reads durations, CPU, and memory in the units Google and gcloud write them", () => {
    expect([seconds("0s"), seconds("30s"), seconds("1h"), seconds("7d"), seconds("x")]).toEqual([
      0,
      30,
      3600,
      604800,
      undefined,
    ]);
    expect([millicores("1"), millicores("1000m"), millicores("0.5"), millicores("")]).toEqual([
      1000,
      1000,
      500,
      undefined,
    ]);
    expect(bytes("4Gi")).toBe(bytes("4096Mi"));
    expect(bytes("512Mi")).toBe(512 * 2 ** 20);
    expect(bytes("1G")).toBe(1e9);
  });

  it("reads registry.json's cleanup policies (gcloud's format) as the API returns them", () => {
    const [keep, remove] = file("registry.json").cleanupPolicies;
    const live = healthyProject().registry.cleanupPolicies;
    expect(cleanupPolicyKey(keep)).toBe(cleanupPolicyKey(live["keep-recent"]));
    expect(cleanupPolicyKey(remove)).toBe(cleanupPolicyKey(live["delete-older"]));
    expect(cleanupPolicyKey(keep)).not.toBe(cleanupPolicyKey(remove));
  });
});
