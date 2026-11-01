// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  apply,
  deployTarget,
  imageInputs,
  needsDeploy,
  plan,
  queueUpdateArgs,
  render,
  touchesImage,
  VARIABLES,
  type Queue,
} from "../../../infra/gcp/deploy.mjs";

/**
 * The keyless deploy (ADR-0170): `infra/gcp/deploy.mjs` against the reviewed files it deploys,
 * CI's `deploy` job, the GitHub Workload Identity provider, and the deploy account's IAM.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = (path: string) => readFileSync(join(ROOT, path), "utf8");
const read = (name: string): unknown => JSON.parse(text(`infra/gcp/${name}`));

interface Iam {
  project: string;
  serviceAccounts: { id: string }[];
  bindings: { resource: string; role: string; member: string }[];
}
interface Github {
  pool: string;
  provider: {
    id: string;
    oidc: { issuerUri: string };
    attributeMapping: Record<string, string>;
    attributeCondition: string;
  };
  serviceAccount: string;
}
interface Registry {
  repository: string;
  format: string;
  image: string;
  maxImageMB: number;
  cleanupPolicies: {
    name: string;
    action: { type: string };
    condition?: { tagState: string; olderThan: string };
    mostRecentVersions?: { packageNamePrefixes: string[]; keepCount: number };
  }[];
}

const iam = read("iam.json") as Iam;
const github = read("github.json") as Github;
const registry = read("registry.json") as Registry;
const queue = read("queue.json") as Queue;
const workflow = text(".github/workflows/ci.yml");
const target = deployTarget();
const deployer = `serviceAccount:${target.account}`;
const digest = `${target.image}@sha256:${"ab".repeat(32)}`;
const values = {
  IMAGE: digest,
  SNAPSHOTS_NAMESPACE: "axabcdefgh",
  SNAPSHOTS_REGION: "us-ashburn-1",
  SNAPSHOTS_BUCKET: "gitinside-snapshots",
  SNAPSHOTS_ACCESS_KEY_ID: "0123456789abcdef",
};
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A scratch folder removed after the test. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitinside-deploy-test-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The value of a `--name=value` flag. */
function flag(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

describe("deploy target", () => {
  it("deploys to the services' project and region, as its own declared account", () => {
    expect(target.project).toBe(iam.project);
    expect(target.region).toBe("us-east4");
    expect(iam.serviceAccounts.map((account) => account.id)).toContain(github.serviceAccount);
    expect(target.account).toBe(`gitinside-deploy@${iam.project}.iam.gserviceaccount.com`);
    expect(target.image).toBe(`us-east4-docker.pkg.dev/${iam.project}/gitinside/worker`);
  });

  it("names the Workload Identity provider from the project number, and nothing else", () => {
    expect(plan("123456789012")).toEqual({
      provider:
        "projects/123456789012/locations/global/workloadIdentityPools/github/providers/github",
      account: target.account,
    });
    for (const bad of [undefined, "", "gitinside-513223", "12/../34"]) {
      expect(() => plan(bad)).toThrow(/GCP_PROJECT_NUMBER/);
    }
  });
});

describe("render", () => {
  it("fills every placeholder of both services, changing nothing else", () => {
    for (const file of ["service.json", "killswitch.json"]) {
      const template = text(`infra/gcp/${file}`);
      const rendered = render(template, values);
      expect(rendered).not.toMatch(/\{\{|\}\}/);
      // Same document with the values in place of the placeholders.
      let expected = template;
      for (const [name, value] of Object.entries(values)) {
        expected = expected.replaceAll(`{{${name}}}`, value);
      }
      expect(JSON.parse(rendered)).toEqual(JSON.parse(expected));
    }
    const service = JSON.parse(render(text("infra/gcp/service.json"), values));
    const [container] = service.spec.template.spec.containers;
    expect(container.image).toBe(digest);
    expect(container.env.find((v: { name: string }) => v.name === "SNAPSHOTS_BUCKET").value).toBe(
      values.SNAPSHOTS_BUCKET,
    );
  });

  it("takes from the repo variables exactly the plain values service.json leaves open", () => {
    const placeholders = [...text("infra/gcp/service.json").matchAll(/\{\{([A-Z_]+)\}\}/g)].map(
      (m) => m[1],
    );
    expect([...new Set(placeholders)].sort()).toEqual(["IMAGE", ...VARIABLES].sort());
  });

  it("refuses an image that isn't this registry's worker pinned by digest", () => {
    const template = text("infra/gcp/service.json");
    for (const image of [
      `${target.image}:latest`,
      `${target.image}@sha256:${"ab".repeat(31)}`,
      `docker.io/library/node@sha256:${"ab".repeat(32)}`,
      `${target.image}x@sha256:${"ab".repeat(32)}`,
      `us-east4-docker-pkg.dev/${iam.project}/gitinside/worker@sha256:${"ab".repeat(32)}`,
    ]) {
      expect(() => render(template, { ...values, IMAGE: image }), image).toThrow(/IMAGE/);
    }
  });

  it("refuses values that aren't plain identifiers, and placeholders without a value", () => {
    const template = text("infra/gcp/service.json");
    for (const bad of ['a", "x": "y', "a b", "", "{{IMAGE}}", "a\nb"]) {
      expect(() => render(template, { ...values, SNAPSHOTS_BUCKET: bad }), bad).toThrow(
        /SNAPSHOTS_BUCKET/,
      );
    }
    const { SNAPSHOTS_REGION: _, ...missing } = values;
    expect(() => render(template, missing)).toThrow("no value for {{SNAPSHOTS_REGION}}");
  });
});

describe("queue update", () => {
  it("sets every field of queue.json, on the queue the website names", () => {
    const args = queueUpdateArgs(queue, iam.project);
    expect(args.slice(0, 4)).toEqual(["tasks", "queues", "update", "analyses"]);
    expect(flag(args, "location")).toBe(target.region);
    expect(flag(args, "project")).toBe(iam.project);
    const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const fields = { ...queue.rateLimits, ...queue.retryConfig };
    for (const [name, value] of Object.entries(fields)) {
      expect(flag(args, kebab(name)), name).toBe(String(value));
    }
    expect(flag(args, "log-sampling-ratio")).toBe(
      String(queue.stackdriverLoggingConfig.samplingRatio),
    );
    // Nothing set that queue.json doesn't hold.
    expect(args.filter((arg) => arg.startsWith("--"))).toHaveLength(Object.keys(fields).length + 4);
  });

  it("refuses a queue in another project", () => {
    expect(() => queueUpdateArgs(queue, "other-project")).toThrow(/not in other-project/);
  });
});

describe("apply", () => {
  /** A fake `exec` recording calls; docker inspect answers with the pushed digest. */
  function fakeExec(repoDigests: string[] = [digest]) {
    const calls: string[][] = [];
    const exec = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return command === "docker" && args[0] === "inspect" ? JSON.stringify(repoDigests) : "";
    };
    return { calls, exec };
  }
  const env = Object.fromEntries(
    VARIABLES.map((name) => [name, values[name as keyof typeof values]]),
  );

  it("builds and pushes the commit's image, rolls both services onto its digest, then the queue", () => {
    const out = scratch();
    const { calls, exec } = fakeExec([`other.example/x@sha256:${"cd".repeat(32)}`, digest]);
    expect(apply({ sha: SHA, env, exec, out })).toBe(digest);
    const tag = `${target.image}:${SHA}`;
    const scope = [`--region=${target.region}`, `--project=${iam.project}`, "--quiet"];
    expect(calls).toEqual([
      ["gcloud", "auth", "configure-docker", "us-east4-docker.pkg.dev", "--quiet"],
      [
        "docker",
        "build",
        "--file",
        "apps/worker/Dockerfile",
        "--platform",
        "linux/amd64",
        "--label",
        `org.opencontainers.image.revision=${SHA}`,
        "--tag",
        tag,
        ".",
      ],
      ["docker", "push", tag],
      ["docker", "inspect", "--format", "{{json .RepoDigests}}", tag],
      // The kill switch before the worker it stops.
      ["gcloud", "run", "services", "replace", join(out, "killswitch.json"), ...scope],
      ["gcloud", "run", "services", "replace", join(out, "service.json"), ...scope],
      ["gcloud", ...queueUpdateArgs(queue, iam.project)],
    ]);
    for (const file of ["killswitch.json", "service.json"]) {
      const rendered = JSON.parse(readFileSync(join(out, file), "utf8"));
      expect(rendered.spec.template.spec.containers[0].image, file).toBe(digest);
    }
  });

  it("does nothing without every repo variable or a full commit SHA", () => {
    for (const name of VARIABLES) {
      const { calls, exec } = fakeExec();
      expect(() => apply({ sha: SHA, env: { ...env, [name]: "" }, exec, out: "" })).toThrow(name);
      expect(calls).toEqual([]);
    }
    const { calls, exec } = fakeExec();
    expect(() => apply({ sha: "main", env, exec, out: "" })).toThrow(/commit SHA/);
    expect(calls).toEqual([]);
  });

  it("deploys nothing when the push left no digest for this registry", () => {
    const { calls, exec } = fakeExec([]);
    expect(() => apply({ sha: SHA, env, exec, out: scratch() })).toThrow(/no digest/);
    expect(calls.some((call) => call.includes("replace"))).toBe(false);
  });
});

describe("when to deploy", () => {
  it("watches the worker, every workspace package it builds from, the root manifests, and infra/gcp", () => {
    expect(imageInputs()).toEqual([
      ".dockerignore",
      "apps/worker/",
      "infra/gcp/",
      "package.json",
      "packages/analyzer/",
      "packages/db/",
      "packages/diff/",
      "packages/schema/",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
    ]);
    for (const input of imageInputs()) expect(existsSync(join(ROOT, input)), input).toBe(true);
    // The build reads these from the context; the deploy watches every one.
    expect(text("apps/worker/Dockerfile")).toContain("COPY . .");
  });

  it("deploys for a change to the image's inputs, not for docs, the website, or the viewer", () => {
    expect(touchesImage(["PROGRESS.md", "docs/DECISIONS.md", "apps/web/lib/x.ts"])).toBe(false);
    expect(touchesImage(["packages/viewer/src/x.tsx", "apps/worker2/x"])).toBe(false);
    expect(touchesImage(["docs/x.md", "packages/analyzer/src/express.ts"])).toBe(true);
    expect(touchesImage(["pnpm-lock.yaml"])).toBe(true);
    expect(touchesImage(["infra/gcp/service.json"])).toBe(true);
  });

  it("reads the pushed range from git, and deploys whenever it can't tell", () => {
    const asked: string[][] = [];
    const git = (names: string) => (args: string[]) => {
      asked.push(args);
      return names;
    };
    expect(needsDeploy("a".repeat(40), SHA, git("README.md\ndocs/x.md\n"))).toBe(false);
    expect(asked).toEqual([["diff", "--name-only", "a".repeat(40), SHA]]);
    expect(needsDeploy("a".repeat(40), SHA, git("apps/worker/src/run.ts\n"))).toBe(true);
    // A new branch, a manual run, or a `before` the checkout doesn't have.
    expect(needsDeploy("0".repeat(40), SHA, git(""))).toBe(true);
    expect(needsDeploy("", SHA, git(""))).toBe(true);
    const missing = () => {
      throw new Error("bad object");
    };
    expect(needsDeploy("a".repeat(40), SHA, missing)).toBe(true);
  });
});

describe("CI's deploy job and the GitHub Workload Identity provider", () => {
  const job = workflow.slice(workflow.indexOf("\n  deploy:\n"));

  it("is CI's last job, after every other job, only on main, idle without the variables", () => {
    expect(job).toContain("needs: [check, worker-image, visual, web-e2e]");
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
    expect([...jobs.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1])).toEqual([
      "check",
      "worker-image",
      "visual",
      "web-e2e",
      "deploy",
    ]);
    expect(job).toContain("github.repository == 'AbhinavGonthina/gitinside'");
    expect(job).toContain("github.ref == 'refs/heads/main'");
    expect(job).toContain("vars.GCP_PROJECT_NUMBER != ''");
  });

  it("is the only job that can ask GitHub for an OIDC token", () => {
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(job).toContain("id-token: write");
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  it("passes the deploy exactly the repo variables it renders, and runs deploy.mjs", () => {
    const passed = [...job.matchAll(/^ {6}([A-Z_]+): \$\{\{ vars\.([A-Z_]+) \}\}$/gm)];
    expect(passed.every((m) => m[1] === m[2])).toBe(true);
    expect(passed.map((m) => m[1]).sort()).toEqual(["GCP_PROJECT_NUMBER", ...VARIABLES].sort());
    for (const step of [
      "deploy.mjs changed",
      "deploy.mjs plan",
      'deploy.mjs apply "$GITHUB_SHA"',
    ]) {
      expect(job).toContain(step);
    }
    expect(job).toContain("workload_identity_provider: ${{ steps.plan.outputs.provider }}");
    expect(job).toContain("service_account: ${{ steps.plan.outputs.account }}");
  });

  it("pins the actions that hold Google credentials by commit", () => {
    const google = [...job.matchAll(/uses: (google-github-actions\/[a-z-]+)@(\S+)/g)];
    expect(google.map((m) => m[1])).toEqual([
      "google-github-actions/auth",
      "google-github-actions/setup-gcloud",
    ]);
    for (const m of google) expect(m[2]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("admits only this repo's CI workflow on main, from a push or a manual run", () => {
    const condition = github.provider.attributeCondition;
    expect(github.provider.oidc.issuerUri).toBe("https://token.actions.githubusercontent.com");
    const workflowRef = /assertion\.workflow_ref == '([^']+)'/.exec(condition)?.[1];
    expect(workflowRef).toBe("AbhinavGonthina/gitinside/.github/workflows/ci.yml@refs/heads/main");
    expect(existsSync(join(ROOT, ".github/workflows/ci.yml"))).toBe(true);
    expect(condition).toContain("assertion.ref == 'refs/heads/main'");
    expect(condition).toContain("assertion.event_name in ['push', 'workflow_dispatch']");
    // IDs, not names: a deleted and re-created repo or account of the same name gets new ones.
    const repoId = /assertion\.repository_id == '([0-9]+)'/.exec(condition)?.[1];
    expect(repoId).toBeDefined();
    expect(condition).toMatch(/assertion\.repository_owner_id == '[0-9]+'/);
    // Each clause joined with &&: no `||` that could widen it.
    expect(condition).not.toContain("||");
    // The binding admits that repository's tokens, which the condition narrows further.
    const users = iam.bindings.filter(
      (b) => b.resource === `serviceAccount/${github.serviceAccount}`,
    );
    expect(users).toEqual([
      {
        resource: `serviceAccount/${github.serviceAccount}`,
        role: "roles/iam.workloadIdentityUser",
        member: `principalSet://iam.googleapis.com/projects/{{PROJECT_NUMBER}}/locations/global/workloadIdentityPools/${github.pool}/attribute.repository_id/${repoId}`,
      },
    ]);
    expect(github.provider.attributeMapping["attribute.repository_id"]).toBe(
      "assertion.repository_id",
    );
  });
});

describe("the deploy account's IAM and the registry", () => {
  it("may push the image, replace the two services, run them as their accounts, update the queue", () => {
    const granted = iam.bindings
      .filter((binding) => binding.member === deployer)
      .map((binding) => `${binding.role} ${binding.resource}`);
    expect(granted.sort()).toEqual(
      [
        `roles/artifactregistry.writer artifactregistry/repository/${registry.repository}`,
        "roles/run.developer run/service/gitinside-worker",
        "roles/run.developer run/service/gitinside-killswitch",
        "roles/iam.serviceAccountUser serviceAccount/gitinside-worker",
        "roles/iam.serviceAccountUser serviceAccount/gitinside-killswitch",
        "roles/cloudtasks.queueAdmin cloudtasks/queue/analyses",
      ].sort(),
    );
    // run.developer can't set IAM policy, so the deploy can't add an invoker; nothing
    // project-wide, nothing on the registry beyond writing.
    expect(granted.some((grant) => /admin |owner|editor/i.test(grant.split(" ")[0] ?? ""))).toBe(
      false,
    );
  });

  it("keeps a few recent images and deletes the rest, inside the free 0.5 GB", () => {
    expect(registry.format).toBe("DOCKER");
    expect(registry.image).toBe(target.image.split("/").pop());
    const [keep, remove] = registry.cleanupPolicies;
    expect(keep?.action.type).toBe("Keep");
    expect(keep?.mostRecentVersions?.packageNamePrefixes).toEqual([registry.image]);
    expect(remove?.action.type).toBe("Delete");
    expect(remove?.condition?.tagState).toBe("any");
    expect(registry.cleanupPolicies).toHaveLength(2);
    // The running image, the one before it, and one pushed by a deploy that failed half way.
    const keepCount = keep?.mostRecentVersions?.keepCount ?? 0;
    expect(keepCount).toBe(3);
    // check.mjs fails CI if the compressed image grows past maxImageMB.
    expect(keepCount * registry.maxImageMB).toBeLessThanOrEqual(500);
    expect(text("infra/gcp/check.mjs")).toContain("registry.maxImageMB");
  });
});
