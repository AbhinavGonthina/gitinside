#!/usr/bin/env node
/**
 * The keyless deploy of the worker and the billing kill switch (ADR-0111, ADR-0170), run by
 * CI's `deploy` job on a push to `main` once every other job is green. Run from the repo root:
 *
 *   node infra/gcp/deploy.mjs plan            values for the workflow's auth step ($GITHUB_OUTPUT)
 *   node infra/gcp/deploy.mjs changed <sha>   whether the image's inputs changed since what's live
 *   node infra/gcp/deploy.mjs apply <sha>     build, push, render, replace both services, queue
 *
 * Everything it deploys comes from this folder's reviewed files; the only outside values are
 * the repo variables `GCP_PROJECT_NUMBER` and `SNAPSHOTS_*` (identifiers, not secrets), the
 * commit, and the image digest it pushes ({@link WEBSITE_ORIGIN} is a constant here). It never creates or grants anything: the services, queue, registry,
 * and IAM are set up once by hand (`README.md`, "Applying it"), and the deploy account may only
 * push to the registry, replace the two services, and update the queue (`iam.json`).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GCP = dirname(fileURLToPath(import.meta.url));
const ROOT = join(GCP, "../..");
const read = (name) => JSON.parse(readFileSync(join(GCP, name), "utf8"));

/** The deploy's fixed coordinates, all read from the reviewed files. */
export function deployTarget() {
  const iam = read("iam.json");
  const service = read("service.json");
  const region = service.metadata.labels["cloud.googleapis.com/location"];
  const registry = read("registry.json");
  const github = read("github.json");
  return {
    project: iam.project,
    region,
    account: `${github.serviceAccount}@${iam.project}.iam.gserviceaccount.com`,
    image: `${region}-docker.pkg.dev/${iam.project}/${registry.repository}/${registry.image}`,
    pool: github.pool,
    provider: github.provider.id,
  };
}

/** Values the workflow's auth step needs: the provider (by project number) and the account. */
export function plan(projectNumber) {
  if (!/^[0-9]{6,20}$/.test(projectNumber ?? "")) {
    throw new Error(`GCP_PROJECT_NUMBER must be the project's number, got "${projectNumber}"`);
  }
  const target = deployTarget();
  return {
    provider: `projects/${projectNumber}/locations/global/workloadIdentityPools/${target.pool}/providers/${target.provider}`,
    account: target.account,
  };
}

/**
 * The repo paths whose content goes into the worker's image: the root manifests the build
 * reads, the Dockerfile's context rules, this folder (the services' config), and the worker's
 * package with every workspace package it depends on, directly or not.
 */
export function imageInputs() {
  const packages = new Map();
  for (const parent of ["apps", "packages"]) {
    for (const name of readdirSync(join(ROOT, parent))) {
      try {
        const manifest = JSON.parse(readFileSync(join(ROOT, parent, name, "package.json"), "utf8"));
        packages.set(manifest.name, { dir: `${parent}/${name}/`, manifest });
      } catch {
        // Not a package (no package.json).
      }
    }
  }
  const dirs = new Set();
  const visit = (name) => {
    const found = packages.get(name);
    if (!found || dirs.has(found.dir)) return;
    dirs.add(found.dir);
    const { dependencies = {}, devDependencies = {} } = found.manifest;
    for (const [dependency, version] of Object.entries({ ...dependencies, ...devDependencies })) {
      if (String(version).startsWith("workspace:")) visit(dependency);
    }
  };
  visit("@gitinside/worker");
  return [
    ".dockerignore",
    "infra/gcp/",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    ...dirs,
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Whether any changed path is one of `imageInputs()` (a folder ends in `/`). */
export function touchesImage(paths, inputs = imageInputs()) {
  return paths.some((path) =>
    inputs.some((input) => (input.endsWith("/") ? path.startsWith(input) : path === input)),
  );
}

const ZERO_SHA = /^0{40}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The revision label carrying the commit a deploy built from (`{{COMMIT}}` in both services'
 * templates), so the next deploy can compare with what's live rather than with the last push.
 */
export const COMMIT_LABEL = "gitinside-commit";

/** The services the deploy replaces, in its order: the kill switch before the worker it stops. */
const SERVICE_FILES = ["killswitch.json", "service.json"];

/**
 * Whether going from the deployed commit `deployed` to `after` needs a deploy. Deploys when
 * it can't tell (nothing known to be deployed, or a commit missing from the checkout's
 * history), so a change is never skipped.
 */
export function needsDeploy(deployed, after, git = gitOutput) {
  if (!deployed || ZERO_SHA.test(deployed)) return true;
  let names;
  try {
    names = git(["diff", "--name-only", deployed, after]);
  } catch {
    return true;
  }
  return touchesImage(names.split("\n").filter((line) => line !== ""));
}

/**
 * The commit a service (as `gcloud run services describe --format=json` answers) runs, or
 * `undefined` unless that's certain: its latest spec is rolled out (observed), its newest
 * revision is the ready one, the service is Ready, and that revision serves all traffic. A
 * revision that failed its startup probe leaves traffic on an older one, so it isn't deployed.
 */
export function deployedCommit(service) {
  const status = service?.status ?? {};
  const generation = service?.metadata?.generation;
  if (generation === undefined || status.observedGeneration !== generation) return undefined;
  const ready = (status.conditions ?? []).find((condition) => condition.type === "Ready");
  if (ready?.status !== "True") return undefined;
  const latest = status.latestReadyRevisionName;
  if (!latest || status.latestCreatedRevisionName !== latest) return undefined;
  const serving = (status.traffic ?? []).filter((route) => (route.percent ?? 0) > 0);
  if (serving.length === 0 || serving.some((route) => route.revisionName !== latest)) {
    return undefined;
  }
  const commit = service.spec?.template?.metadata?.labels?.[COMMIT_LABEL];
  return COMMIT_SHA.test(commit ?? "") ? commit : undefined;
}

/**
 * Whether `after` needs a deploy: unless `always` (a manual run), it reads both services from
 * Cloud Run and deploys if either doesn't certainly run a commit from which the image's inputs
 * are unchanged. A run that failed, was cancelled, or never reached the deploy is so shipped by
 * the next one (R3, second M5 review).
 */
export function deployNeeded({ after, exec, git = gitOutput, always = false }) {
  if (always) return true;
  const target = deployTarget();
  for (const file of SERVICE_FILES) {
    let service;
    try {
      const answer = exec("gcloud", [
        "run",
        "services",
        "describe",
        read(file).metadata.name,
        `--region=${target.region}`,
        `--project=${target.project}`,
        "--format=json",
      ]);
      service = JSON.parse(answer);
    } catch {
      return true;
    }
    if (needsDeploy(deployedCommit(service), after, git)) return true;
  }
  return false;
}

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;
// Identifiers only (a namespace, region, bucket, or key ID): nothing that needs quoting.
const PLAIN_VALUE = /^[A-Za-z0-9._-]{1,128}$/;
// An `https://` origin: a host name, no port, path, or credentials.
const ORIGIN_VALUE = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * The website the worker asks for private jobs' installation tokens (`WEBSITE_ORIGIN`,
 * M8.3c3b, ADR-0228): a reviewed constant, not a repo variable, so a deploy can't point the
 * worker's signed requests anywhere else.
 */
export const WEBSITE_ORIGIN = "https://gitinside.abhinavgonthina.dev";

/**
 * A service file with its `{{NAME}}` placeholders filled in. Rendering works on the parsed
 * JSON, string by string, so a value can never change the document's structure; every
 * placeholder must have a value, `IMAGE` must be this registry's image pinned by digest,
 * `WEBSITE_ORIGIN` an `https://` host, and every other value an identifier.
 */
export function render(text, values, target = deployTarget()) {
  const image = new RegExp(`^${target.image.replace(/[.]/g, "\\.")}@sha256:[0-9a-f]{64}$`);
  for (const [name, value] of Object.entries(values)) {
    const ok =
      name === "IMAGE"
        ? image.test(value)
        : name === "WEBSITE_ORIGIN"
          ? ORIGIN_VALUE.test(value)
          : PLAIN_VALUE.test(value);
    if (!ok) throw new Error(`${name} has an unexpected value: "${value}"`);
  }
  const fill = (node) => {
    if (typeof node === "string") {
      return node.replace(PLACEHOLDER, (_, name) => {
        const value = values[name];
        if (value === undefined) throw new Error(`no value for {{${name}}}`);
        return value;
      });
    }
    if (Array.isArray(node)) return node.map(fill);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, fill(child)]));
    }
    return node;
  };
  return `${JSON.stringify(fill(JSON.parse(text)), null, 2)}\n`;
}

/** `gcloud tasks queues update` arguments that set every field of `queue.json`. */
export function queueUpdateArgs(queue, project) {
  const match = /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/.exec(queue.name);
  if (!match || match[1] !== project) throw new Error(`queue not in ${project}: ${queue.name}`);
  const { rateLimits: rate, retryConfig: retry } = queue;
  return [
    "tasks",
    "queues",
    "update",
    match[3],
    `--location=${match[2]}`,
    `--project=${project}`,
    `--max-dispatches-per-second=${rate.maxDispatchesPerSecond}`,
    `--max-concurrent-dispatches=${rate.maxConcurrentDispatches}`,
    `--max-attempts=${retry.maxAttempts}`,
    `--max-retry-duration=${retry.maxRetryDuration}`,
    `--min-backoff=${retry.minBackoff}`,
    `--max-backoff=${retry.maxBackoff}`,
    `--max-doublings=${retry.maxDoublings}`,
    `--log-sampling-ratio=${queue.stackdriverLoggingConfig.samplingRatio}`,
    "--quiet",
  ];
}

/** The plain variables `service.json` takes from the repo's Actions variables. */
export const VARIABLES = [
  "SNAPSHOTS_ACCESS_KEY_ID",
  "SNAPSHOTS_BUCKET",
  "SNAPSHOTS_NAMESPACE",
  "SNAPSHOTS_REGION",
];

/**
 * Build the image for commit `sha`, push it, and roll both services onto its digest, then
 * bring the queue in line with `queue.json`. `exec(command, args)` runs a command and returns
 * its stdout; `out` is a folder for the rendered files.
 */
export function apply({ sha, env, exec, out }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`not a commit SHA: "${sha}"`);
  const target = deployTarget();
  const values = {};
  for (const name of VARIABLES) {
    const value = env[name];
    if (!value) throw new Error(`the repo variable ${name} isn't set`);
    values[name] = value;
  }
  const registryHost = target.image.split("/")[0];
  const tag = `${target.image}:${sha}`;
  exec("gcloud", ["auth", "configure-docker", registryHost, "--quiet"]);
  exec("docker", [
    "build",
    "--file",
    "apps/worker/Dockerfile",
    "--platform",
    "linux/amd64",
    "--label",
    `org.opencontainers.image.revision=${sha}`,
    "--tag",
    tag,
    ".",
  ]);
  exec("docker", ["push", tag]);
  const pushed = exec("docker", ["inspect", "--format", "{{json .RepoDigests}}", tag]);
  const digest = JSON.parse(pushed).find((reference) => reference.startsWith(`${target.image}@`));
  if (!digest) throw new Error(`no digest for ${tag} in ${pushed.trim()}`);
  values.IMAGE = digest;
  values.COMMIT = sha;
  values.WEBSITE_ORIGIN = WEBSITE_ORIGIN;
  // The kill switch first: the stop must never lag behind the worker it stops.
  for (const file of SERVICE_FILES) {
    const rendered = join(out, file);
    writeFileSync(rendered, render(readFileSync(join(GCP, file), "utf8"), values, target));
    exec("gcloud", [
      "run",
      "services",
      "replace",
      rendered,
      `--region=${target.region}`,
      `--project=${target.project}`,
      "--quiet",
    ]);
  }
  exec("gcloud", queueUpdateArgs(read("queue.json"), target.project));
  return digest;
}

function gitOutput(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** Run a command with its output shown, returning stdout. */
function execShown(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Lines `name=value` for GitHub Actions' step outputs (stdout when not in Actions). */
function output(values) {
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join(""));
  else process.stdout.write(lines.join(""));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    output(plan(process.env.GCP_PROJECT_NUMBER));
  } else if (command === "changed") {
    if (!COMMIT_SHA.test(args[0] ?? "")) throw new Error(`not a commit SHA: "${args[0]}"`);
    const always = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
    output({ deploy: String(deployNeeded({ after: args[0], exec: execShown, always })) });
  } else if (command === "apply") {
    const out = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "gitinside-deploy-"));
    const digest = apply({ sha: args[0], env: process.env, exec: execShown, out });
    console.log(`deployed ${digest}`);
  } else {
    console.error("usage: deploy.mjs plan | changed <sha> | apply <sha>");
    process.exit(2);
  }
}
