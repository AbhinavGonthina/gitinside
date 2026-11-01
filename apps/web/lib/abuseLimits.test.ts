// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPUTE_ALLOWANCE, COMPUTE_PAUSE_RATIO, WORKER_MEMORY_GB } from "@gitinside/db";
import { MAX_ATTEMPTS, QUOTA_ALARM_RATIO, QUOTA_LIMITS, RETENTION_POLICY } from "@gitinside/worker";
import { describe, expect, it } from "vitest";
import { REPO_ANALYSIS_MINUTES } from "./analyze";
import { CHALLENGE_AFTER_PER_ADDRESS, CHALLENGE_AFTER_SITE } from "./botCheck";
import { MAX_GITHUB_CODE_BYTES } from "./codeSize";
import { RECHECKS_PER_HOUR } from "./repoView";
import { SIGNED_OUT_HOURLY_LIMIT } from "./serverDeps";
import { SIZE_HOLD_DAYS } from "./sizeHold";

/**
 * docs/SECURITY.md's "T9 in numbers" table against the code and `infra/gcp` (M5.18f): a limit
 * changed on one side only fails here, so the threat model never quotes a stale number.
 * Each row is matched by its first two cells, `| what | value |`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const security = readFileSync(join(ROOT, "docs/SECURITY.md"), "utf8");
const gcp = (name: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, "infra/gcp", name), "utf8"));

const service = gcp("service.json") as {
  spec: {
    template: {
      metadata: { annotations: Record<string, string> };
      spec: {
        containerConcurrency: number;
        timeoutSeconds: number;
        containers: { resources: { limits: { cpu: string; memory: string } } }[];
      };
    };
  };
};
const queue = gcp("queue.json") as {
  rateLimits: { maxDispatchesPerSecond: number; maxConcurrentDispatches: number };
  retryConfig: { maxAttempts: number };
};
const template = service.spec.template;
const limits = template.spec.containers[0]?.resources.limits;

const n = (value: number) => value.toLocaleString("en-US");
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const GB = 1_000_000_000;

/** Instance-seconds a month before the pause, on the binding meter (memory, ADR-0156). */
const pauseInstanceSeconds =
  (COMPUTE_PAUSE_RATIO * COMPUTE_ALLOWANCE.memoryGbSeconds) / WORKER_MEMORY_GB;

const rows: [string, string][] = [
  ["New analyses per address, signed out", `${SIGNED_OUT_HOURLY_LIMIT} per hour (IPv6 per /64)`],
  [
    "Bot check (Turnstile), one address",
    `after ${CHALLENGE_AFTER_PER_ADDRESS} new analyses in an hour`,
  ],
  [
    "Bot check (Turnstile), whole site",
    `after ${CHALLENGE_AFTER_SITE} requests for new analyses in an hour, for everyone`,
  ],
  ["New analyses per repo", `1 per ${REPO_ANALYSIS_MINUTES} minutes, whoever asks`],
  [
    "Re-analysis on view (pages, README images)",
    `${RECHECKS_PER_HOUR} new commits per repo per hour`,
  ],
  [
    "Too much code, before any download",
    `over ${MAX_GITHUB_CODE_BYTES / 2 ** 20} MiB of TypeScript + JavaScript by GitHub's count`,
  ],
  [
    "After a `LIMIT_*` failure",
    `the repo is refused for ${SIZE_HOLD_DAYS} days, unless it shrinks by half`,
  ],
  [
    "Worker instances",
    `at most ${template.metadata.annotations["autoscaling.knative.dev/maxScale"]}, ${template.metadata.annotations["autoscaling.knative.dev/minScale"]} when idle`,
  ],
  [
    "Each instance",
    `${limits?.cpu} vCPU / ${limits?.memory?.replace("Gi", " GiB")}, ${template.spec.containerConcurrency} job, ${template.spec.timeoutSeconds} s per request`,
  ],
  [
    "Queue (Cloud Tasks)",
    `${queue.rateLimits.maxConcurrentDispatches} at once, ${queue.rateLimits.maxDispatchesPerSecond} dispatch per second, ${MAX_ATTEMPTS} attempts`,
  ],
  [
    "Free compute counted a month",
    `${n(COMPUTE_ALLOWANCE.vcpuSeconds)} vCPU-s, ${n(COMPUTE_ALLOWANCE.memoryGbSeconds)} GB-s, ${n(COMPUTE_ALLOWANCE.runRequests)} Cloud Run requests, ${n(COMPUTE_ALLOWANCE.taskOperations)} Cloud Tasks operations`,
  ],
  [
    "Compute pause",
    `new analyses stop at ${percent(COMPUTE_PAUSE_RATIO)} of any meter until the next UTC month: ≈ ${(pauseInstanceSeconds / 3600).toFixed(1)} h of instance time (memory runs out first)`,
  ],
  ["Quota alarm", `\`quota_alarm\` at ${percent(QUOTA_ALARM_RATIO)} of any free limit`],
  [
    "Snapshot bucket",
    `${QUOTA_LIMITS.bucketBytes / GB} GB; retention keeps the latest ${RETENTION_POLICY.keepPerRepo} per repo and evicts the oldest past ${RETENTION_POLICY.budgetBytes / GB} GB`,
  ],
  ["Bucket requests", `${n(QUOTA_LIMITS.monthlyRequests)} a month`],
  ["Postgres storage", `${QUOTA_LIMITS.databaseBytes / GB} GB`],
];

/** The section's table rows as `[what, value]`, from `| what | value | where |`. */
const quoted: [string, string][] = (
  security.split("### T9 in numbers")[1]?.split(/\n#{2,3} /)[0] ?? ""
)
  .split(/\r?\n/)
  .filter((line) => line.startsWith("| ") && !line.startsWith("| Limit |"))
  .map((line) => {
    const [what = "", value = ""] = line.slice(2).split(" | ");
    return [what, value];
  });

describe("docs/SECURITY.md T9 in numbers", () => {
  it.each(rows)("quotes %s as the code has it", (what, value) => {
    expect(quoted.find(([row]) => row === what)?.[1]).toBe(value);
  });

  it("uses the queue's own attempts, not a second figure", () => {
    expect(queue.retryConfig.maxAttempts).toBe(MAX_ATTEMPTS);
  });

  it("has no row the test doesn't check, besides the ones not yet in code", () => {
    const unchecked = quoted.filter(([what]) => !rows.some(([row]) => row === what));
    expect(unchecked.map(([what]) => what)).toEqual([
      "New analyses per user, signed in",
      "Billing",
    ]);
  });
});
