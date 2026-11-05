// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_MEMORY_GB, WORKER_VCPUS, computeUsage, computeUsageThisMonth } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SECRET_READS_PER_START,
  SHUTDOWN_ALLOWANCE_MS,
  billedMs,
  createUsageMeter,
} from "./compute.js";
import { SHUTDOWN_TIMEOUT_MS } from "./main.js";

let t: TestDb;
let lines: Record<string, unknown>[];
const log = (line: Record<string, unknown>) => {
  lines.push(line);
};
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  lines = [];
  await t.db.delete(computeUsage);
});

describe("billedMs", () => {
  it("rounds up to whole 100 ms steps, at least one", () => {
    expect(billedMs(0)).toBe(100);
    expect(billedMs(-5)).toBe(100);
    expect(billedMs(1)).toBe(100);
    expect(billedMs(100)).toBe(100);
    expect(billedMs(100.01)).toBe(200);
    expect(billedMs(61_234.5)).toBe(61_300);
    expect(billedMs(Number.NaN)).toBe(100);
  });
});

describe("createUsageMeter", () => {
  it("counts a push as its billed time, one Cloud Run request, and one Cloud Tasks delivery", async () => {
    const meter = createUsageMeter({ db: t.db, log });
    await meter.push(61_234.5);
    await meter.push(12);
    expect(await computeUsageThisMonth(t.db)).toMatchObject({
      instanceMs: 61_400,
      runRequests: 2,
      taskOperations: 2,
    });
    expect(lines).toEqual([]);
  });

  it("counts startup with the shutdown's allowance up front, and no request", async () => {
    await createUsageMeter({ db: t.db, log }).startup(1_234);
    expect(await computeUsageThisMonth(t.db)).toMatchObject({
      instanceMs: 1_300 + SHUTDOWN_ALLOWANCE_MS,
      runRequests: 0,
      taskOperations: 0,
    });
  });

  it("counts the secrets Cloud Run read for the instance as Secret Manager accesses, and nothing else", async () => {
    await createUsageMeter({ db: t.db, log }).secretReads();
    expect(await computeUsageThisMonth(t.db)).toMatchObject({
      instanceMs: 0,
      runRequests: 0,
      taskOperations: 0,
      secretAccesses: SECRET_READS_PER_START,
    });
  });

  it("allows for the longest shutdown Cloud Run bills (SIGKILL 10 s after SIGTERM)", () => {
    expect(SHUTDOWN_ALLOWANCE_MS).toBe(10_000);
    expect(SHUTDOWN_TIMEOUT_MS).toBeLessThan(SHUTDOWN_ALLOWANCE_MS);
  });

  it("logs a count that fails, and never rejects", async () => {
    const broken = {
      insert: () => {
        throw new Error("db down");
      },
    } as unknown as TestDb["db"];
    const meter = createUsageMeter({ db: broken, log });
    await expect(meter.push(10)).resolves.toBeUndefined();
    await expect(meter.startup(10)).resolves.toBeUndefined();
    await expect(meter.secretReads()).resolves.toBeUndefined();
    expect(lines).toEqual([
      { event: "compute_count_failed", what: "push", message: "db down" },
      { event: "compute_count_failed", what: "startup", message: "db down" },
      { event: "compute_count_failed", what: "secrets", message: "db down" },
    ]);
  });
});

describe("the counted instance", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const service = JSON.parse(
    readFileSync(join(here, "..", "..", "..", "infra", "gcp", "service.json"), "utf8"),
  ) as {
    spec: {
      template: {
        spec: {
          containers: {
            resources: { limits: Record<string, string> };
            env: { name: string; valueFrom?: { secretKeyRef: unknown } }[];
          }[];
        };
      };
    };
  };

  it("reads as many secrets at each start as the Cloud Run service mounts (infra/gcp/service.json)", () => {
    const secrets = service.spec.template.spec.containers.flatMap((container) =>
      container.env.filter((variable) => variable.valueFrom?.secretKeyRef !== undefined),
    );
    expect(secrets).toHaveLength(SECRET_READS_PER_START);
  });

  it("is the Cloud Run service's size: 1 vCPU and 4 GiB (infra/gcp/service.json)", () => {
    const [container] = service.spec.template.spec.containers;
    expect(container?.resources.limits).toEqual({ cpu: String(WORKER_VCPUS), memory: "4Gi" });
    expect(WORKER_MEMORY_GB).toBeCloseTo((4 * 2 ** 30) / 1e9, 9);
  });
});
