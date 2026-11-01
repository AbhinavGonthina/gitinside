import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUDGET_PATH,
  createKillSwitch,
  killSwitchConfigFromEnv,
  overBudget,
  parseBudgetPush,
  runKillSwitch,
  type BudgetNotification,
} from "./killswitch.js";
import { HEALTH_PATH } from "./http.js";

/**
 * The kill switch against a fake Google that checks what Google checks: the metadata server
 * wants `Metadata-Flavor: Google`, Cloud Billing wants the token as a bearer, and a PUT with
 * an empty `billingAccountName` unlinks the project (ADR-0169).
 */

const PROJECT = "gitinside-513223";
const TOKEN = "ya29.fake-token";

interface FakeGoogle {
  origin: string;
  billingEnabled: boolean;
  /** `METHOD path` of every request, in order. */
  requests: string[];
  /** Answer this status to every call to the named endpoint. */
  fail: Partial<Record<"token" | "get" | "put", number>>;
  close(): Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fakeGoogle(): Promise<FakeGoogle> {
  const google: FakeGoogle = {
    origin: "",
    billingEnabled: true,
    requests: [],
    fail: {},
    close: async () => undefined,
  };
  const answer = (res: import("node:http").ServerResponse, status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      google.requests.push(`${req.method} ${req.url}`);
      if (req.url === "/token") {
        if (google.fail.token) return answer(res, google.fail.token, {});
        if (req.headers["metadata-flavor"] !== "Google") return answer(res, 403, {});
        return answer(res, 200, { access_token: TOKEN, expires_in: 3599, token_type: "Bearer" });
      }
      if (req.url !== `/v1/projects/${PROJECT}/billingInfo`) return answer(res, 404, {});
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return answer(res, 401, {});
      const info = () => ({
        name: `projects/${PROJECT}/billingInfo`,
        projectId: PROJECT,
        billingAccountName: google.billingEnabled ? "billingAccounts/0X0X0X-0X0X0X-0X0X0X" : "",
        billingEnabled: google.billingEnabled,
      });
      if (req.method === "GET") {
        if (google.fail.get) return answer(res, google.fail.get, {});
        return answer(res, 200, info());
      }
      if (req.method === "PUT") {
        if (google.fail.put) return answer(res, google.fail.put, {});
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          billingAccountName?: string;
        };
        if (req.headers["content-type"] !== "application/json") return answer(res, 400, {});
        // Unlinking an unlinked project is an error at Google.
        if (!google.billingEnabled) return answer(res, 400, {});
        if (body.billingAccountName === "") google.billingEnabled = false;
        return answer(res, 200, info());
      }
      return answer(res, 405, {});
    });
  });
  google.origin = await listen(server);
  return google;
}

const notification = (overrides: Partial<BudgetNotification> = {}): BudgetNotification => ({
  budgetDisplayName: "gitinside-kill-switch",
  costAmount: 0.02,
  budgetAmount: 1,
  currencyCode: "USD",
  ...overrides,
});

/** A Pub/Sub push body around `data` as Cloud Billing publishes it. */
function push(data: object | string): Buffer {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return Buffer.from(
    JSON.stringify({
      message: {
        data: Buffer.from(text).toString("base64"),
        attributes: {
          billingAccountId: "0X0X0X-0X0X0X-0X0X0X",
          budgetId: "b",
          schemaVersion: "1.0",
        },
        messageId: "1",
        publishTime: "2026-11-01T00:00:00Z",
      },
      subscription: `projects/${PROJECT}/subscriptions/billing-alerts-killswitch`,
    }),
  );
}

function setup(google: FakeGoogle) {
  const lines: Record<string, unknown>[] = [];
  const killSwitch = createKillSwitch({
    projectId: PROJECT,
    log: (event) => void lines.push(event),
    tokenUrl: `${google.origin}/token`,
    billingOrigin: google.origin,
    timeoutMs: 2_000,
  });
  return { killSwitch, lines };
}

describe("parseBudgetPush", () => {
  it("reads a budget notification from a Pub/Sub push", () => {
    expect(
      parseBudgetPush(
        push({
          ...notification({ costAmount: 1.5 }),
          alertThresholdExceeded: 1,
          costIntervalStart: "2026-11-01T07:00:00Z",
          budgetAmountType: "SPECIFIED_AMOUNT",
        }),
      ),
    ).toEqual(notification({ costAmount: 1.5 }));
  });

  it("refuses anything else", () => {
    for (const body of [
      Buffer.from("not json"),
      Buffer.from("{}"),
      Buffer.from(JSON.stringify({ message: { data: 5 } })),
      push("not json"),
      push("null"),
      push({ budgetAmount: 1 }),
      push({ costAmount: "2", budgetAmount: 1 }),
      push({ costAmount: 2, budgetAmount: null }),
    ]) {
      expect(parseBudgetPush(body)).toBeUndefined();
    }
  });
});

describe("overBudget", () => {
  it("is true once the cost reaches a positive budget", () => {
    expect(overBudget(notification({ costAmount: 0.99 }))).toBe(false);
    expect(overBudget(notification({ costAmount: 1 }))).toBe(true);
    expect(overBudget(notification({ costAmount: 7 }))).toBe(true);
    expect(overBudget(notification({ costAmount: 0, budgetAmount: 0 }))).toBe(false);
  });
});

describe("the kill switch", () => {
  it("leaves billing alone under the budget, without calling Google", async () => {
    const google = await fakeGoogle();
    const { killSwitch, lines } = setup(google);
    expect(await killSwitch.handle(push(notification({ costAmount: 0.6 })))).toBe("under_budget");
    expect(google.requests).toEqual([]);
    expect(lines).toEqual([
      {
        event: "budget_under",
        budget: "gitinside-kill-switch",
        cost: 0.6,
        amount: 1,
        currency: "USD",
      },
    ]);
  });

  it("unlinks the project's billing account once the cost reaches the budget", async () => {
    const google = await fakeGoogle();
    const { killSwitch, lines } = setup(google);
    expect(await killSwitch.handle(push(notification({ costAmount: 1.02 })))).toBe("disabled");
    expect(google.billingEnabled).toBe(false);
    expect(google.requests).toEqual([
      "GET /token",
      `GET /v1/projects/${PROJECT}/billingInfo`,
      `PUT /v1/projects/${PROJECT}/billingInfo`,
    ]);
    expect(lines.at(-1)).toMatchObject({ event: "billing_disabled", project: PROJECT, cost: 1.02 });
  });

  it("does nothing more once billing is off (the budget keeps notifying)", async () => {
    const google = await fakeGoogle();
    google.billingEnabled = false;
    const { killSwitch } = setup(google);
    expect(await killSwitch.handle(push(notification({ costAmount: 3 })))).toBe("already_disabled");
    expect(google.requests.filter((r) => r.startsWith("PUT"))).toEqual([]);
  });

  it("fails (so Pub/Sub retries) when Google refuses, and never logs the token", async () => {
    for (const fail of [{ token: 500 }, { get: 403 }, { put: 403 }] as const) {
      const google = await fakeGoogle();
      google.fail = fail;
      const { killSwitch, lines } = setup(google);
      expect(await killSwitch.handle(push(notification({ costAmount: 2 })))).toBe("failed");
      expect(google.billingEnabled).toBe(true);
      expect(lines.at(-1)).toMatchObject({ event: "billing_disable_failed", project: PROJECT });
      expect(JSON.stringify(lines)).not.toContain(TOKEN);
    }
  });

  it("fails when Google can't be reached in time", async () => {
    const hanging = createServer(() => undefined);
    const origin = await listen(hanging);
    const lines: Record<string, unknown>[] = [];
    const killSwitch = createKillSwitch({
      projectId: PROJECT,
      log: (event) => void lines.push(event),
      tokenUrl: `${origin}/token`,
      billingOrigin: origin,
      timeoutMs: 100,
    });
    expect(await killSwitch.handle(push(notification({ costAmount: 2 })))).toBe("failed");
    expect(lines.at(-1)).toMatchObject({ message: "metadata token: TimeoutError" });
  });

  it("acknowledges what isn't a budget notification", async () => {
    const google = await fakeGoogle();
    const { killSwitch, lines } = setup(google);
    expect(await killSwitch.handle(Buffer.from("{}"))).toBe("invalid");
    expect(lines).toEqual([{ event: "budget_push_invalid" }]);
    expect(google.requests).toEqual([]);
  });
});

describe("the kill switch's server", () => {
  async function serve(google: FakeGoogle) {
    const { killSwitch, lines } = setup(google);
    return { origin: await listen(killSwitch.server), lines };
  }
  const post = (origin: string, body: Buffer | string, type = "application/json") =>
    fetch(`${origin}${BUDGET_PATH}`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });

  it("answers Pub/Sub 204 when done or nothing to do, 503 when it must retry", async () => {
    const google = await fakeGoogle();
    const { origin } = await serve(google);
    expect((await post(origin, push(notification()))).status).toBe(204);
    expect((await post(origin, "{}")).status).toBe(204);
    expect((await post(origin, "x", "text/plain")).status).toBe(204);
    expect((await post(origin, "a".repeat(20_000))).status).toBe(204);

    google.fail = { put: 500 };
    const failed = await post(origin, push(notification({ costAmount: 1 })));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "BILLING_DISABLE_FAILED" });
    expect(google.billingEnabled).toBe(true);

    google.fail = {};
    expect((await post(origin, push(notification({ costAmount: 1 })))).status).toBe(204);
    expect(google.billingEnabled).toBe(false);
  });

  it("serves health, and nothing else but POST /budget", async () => {
    const google = await fakeGoogle();
    const { origin } = await serve(google);
    const health = await fetch(`${origin}${HEALTH_PATH}`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await fetch(`${origin}${BUDGET_PATH}`)).status).toBe(405);
    expect((await fetch(`${origin}/run`, { method: "POST" })).status).toBe(404);
    expect(google.requests).toEqual([]);
  });
});

describe("killSwitchConfigFromEnv", () => {
  it("needs a project ID, and defaults host and port", () => {
    expect(killSwitchConfigFromEnv({ KILLSWITCH_PROJECT_ID: PROJECT })).toEqual({
      projectId: PROJECT,
      host: "127.0.0.1",
      port: 8080,
    });
    expect(
      killSwitchConfigFromEnv({ KILLSWITCH_PROJECT_ID: PROJECT, HOST: "0.0.0.0", PORT: "9090" }),
    ).toEqual({ projectId: PROJECT, host: "0.0.0.0", port: 9090 });
    expect(() => killSwitchConfigFromEnv({})).toThrow("KILLSWITCH_PROJECT_ID is not a project ID");
    expect(() => killSwitchConfigFromEnv({ KILLSWITCH_PROJECT_ID: "../x" })).toThrow(
      "KILLSWITCH_PROJECT_ID",
    );
    expect(() =>
      killSwitchConfigFromEnv({ KILLSWITCH_PROJECT_ID: PROJECT, PORT: "70000" }),
    ).toThrow("PORT is not a port number");
  });
});

describe("runKillSwitch", () => {
  it("listens on PORT, logs JSON lines, and exits 0 on SIGTERM", async () => {
    const google = await fakeGoogle();
    // A port that was free a moment ago (PORT can't be 0).
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const output: string[] = [];
    let onSignal: (() => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      void runKillSwitch({
        env: { KILLSWITCH_PROJECT_ID: PROJECT, PORT: String(port) },
        write: (line) => void output.push(line),
        onSignal: (signals, handler) => {
          expect(signals).toEqual(["SIGTERM", "SIGINT"]);
          onSignal = handler;
        },
        exit: resolve,
        options: { tokenUrl: `${google.origin}/token`, billingOrigin: google.origin },
      }).then(async (server) => {
        expect(server).toBeDefined();
        const health = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
          headers: { connection: "close" },
        });
        expect(health.status).toBe(200);
        onSignal?.();
      });
    });
    expect(await exited).toBe(0);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      event: "killswitch_ready",
      project: PROJECT,
      port,
    });
  });

  it("exits 1 on a bad config, naming the variable", async () => {
    const output: string[] = [];
    let code: number | undefined;
    await runKillSwitch({
      env: {},
      write: (line) => void output.push(line),
      onSignal: () => undefined,
      exit: (c) => void (code = c),
    });
    expect(code).toBe(1);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      event: "config_invalid",
      problems: ["KILLSWITCH_PROJECT_ID is not a project ID"],
    });
  });
});
