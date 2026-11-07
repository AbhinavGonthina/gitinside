// @vitest-environment node
import { createHmac } from "node:crypto";
import {
  findInstallation,
  installations,
  repos,
  upsertInstallation,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  handleWebhook,
  MAX_WEBHOOK_BYTES,
  verifySignature,
  type WebhookDeps,
} from "./githubWebhook";

const SECRET = "w".repeat(43);
const PREVIOUS = "p".repeat(43);

let t: TestDb;
let deps: WebhookDeps;
beforeAll(async () => {
  t = await createTestDb();
  deps = { db: t.db, secrets: [SECRET] };
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(repos);
  await t.db.delete(installations);
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  onTestFinished(() => spy.mockRestore());
});

const sign = (body: string | Uint8Array, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function delivery(
  event: string,
  payload: unknown,
  { secret = SECRET, signature }: { secret?: string; signature?: string | null } = {},
): Request {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  };
  const sig = signature === undefined ? sign(body, secret) : signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return new Request("https://gitinside.test/api/github/webhook", {
    method: "POST",
    headers,
    body,
  });
}

const INSTALLATION = {
  id: 41,
  account: { id: 9001, login: "octo-org", type: "Organization" },
  repository_selection: "selected",
  suspended_at: null,
};

const installed = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  installation: INSTALLATION,
  sender: { id: 7, login: "octo" },
  ...extra,
});

async function answer(request: Request, ...d: [WebhookDeps | undefined] | []) {
  const response = await handleWebhook(request, d.length === 0 ? deps : d[0]);
  return { status: response.status, body: (await response.json()) as unknown };
}

function repo(providerRepoId: number) {
  return upsertRepo(t.db, {
    providerRepoId,
    owner: "octo-org",
    name: `r${providerRepoId}`,
    visibility: "private",
    defaultBranch: "main",
  });
}

async function linked(): Promise<Record<string, boolean>> {
  const rows = await t.db
    .select({ name: repos.name, installationId: repos.installationId })
    .from(repos);
  return Object.fromEntries(rows.map((r) => [r.name, r.installationId !== null]));
}

describe("verifySignature", () => {
  const body = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');

  it("accepts GitHub's HMAC-SHA256 of the raw bytes under any configured secret", () => {
    expect(verifySignature([SECRET], body, sign(body))).toBe(true);
    expect(verifySignature([SECRET, PREVIOUS], body, sign(body, PREVIOUS))).toBe(true);
  });

  it("refuses another secret, other bytes, and malformed headers", () => {
    expect(verifySignature([SECRET], body, sign(body, PREVIOUS))).toBe(false);
    expect(verifySignature([SECRET], body, sign(new TextEncoder().encode("{}")))).toBe(false);
    const hex = sign(body).slice("sha256=".length);
    for (const header of [
      null,
      "",
      hex,
      `sha1=${hex}`,
      `sha256=${hex.toUpperCase()}`,
      `sha256=${hex.slice(2)}`,
      `sha256=${hex}00`,
      ` sha256=${hex}`,
    ]) {
      expect(verifySignature([SECRET], body, header), String(header)).toBe(false);
    }
    expect(verifySignature([], body, sign(body))).toBe(false);
  });
});

describe("handleWebhook", () => {
  it("is unavailable without its configuration, and reads nothing", async () => {
    const request = delivery("installation", installed("created"));
    expect(await answer(request, undefined)).toEqual({
      status: 503,
      body: { error: "UNAVAILABLE" },
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses a delivery without a valid signature before parsing it", async () => {
    for (const signature of [null, sign("{}"), sign("x", PREVIOUS)]) {
      expect(await answer(delivery("installation", installed("created"), { signature }))).toEqual({
        status: 401,
        body: { error: "BAD_SIGNATURE" },
      });
    }
    const request = new Request("https://gitinside.test/api/github/webhook", {
      method: "POST",
      headers: { "x-github-event": "installation", "x-hub-signature-256": sign("not json") },
      body: "not json",
    });
    expect((await answer(request)).status).toBe(400); // signed garbage is parsed, then refused
    expect(await t.db.select().from(installations)).toEqual([]);
  });

  it("accepts the previous secret during a rotation", async () => {
    const rotating = { ...deps, secrets: [SECRET, PREVIOUS] };
    const request = delivery("installation", installed("created"), { secret: PREVIOUS });
    expect(await answer(request, rotating)).toEqual({ status: 200, body: { status: "ok" } });
    expect(await answer(delivery("ping", {}, { secret: PREVIOUS }))).toEqual({
      status: 401,
      body: { error: "BAD_SIGNATURE" },
    });
  });

  it("refuses a body over the limit", async () => {
    const big = new Request("https://gitinside.test/api/github/webhook", {
      method: "POST",
      headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1) },
      body: "{}",
    });
    expect(await answer(big)).toEqual({ status: 413, body: { error: "BODY_TOO_LARGE" } });
  });

  it("answers ping", async () => {
    expect(await answer(delivery("ping", { zen: "Design for failure.", hook_id: 1 }))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
  });

  it("stores a new installation and links the stored repos it lists", async () => {
    await repo(1);
    await repo(2);
    const payload = installed("created", {
      repositories: [
        { id: 1, name: "r1", full_name: "octo-org/r1", private: true },
        { id: 3, name: "r3", full_name: "octo-org/r3", private: true },
      ],
    });
    expect(await answer(delivery("installation", payload))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect(await findInstallation(t.db, 41)).toMatchObject({
      accountId: 9001,
      accountLogin: "octo-org",
      accountType: "Organization",
      suspendedAt: null,
    });
    expect(await linked()).toEqual({ r1: true, r2: false });
    // A redelivery changes nothing.
    expect((await answer(delivery("installation", payload))).status).toBe(200);
    expect(await t.db.select().from(installations)).toHaveLength(1);
    expect(await linked()).toEqual({ r1: true, r2: false });
  });

  it("follows suspension, unsuspension, and a renamed account", async () => {
    await answer(delivery("installation", installed("created")));
    const suspendedAt = "2026-11-07T12:00:00Z";
    const suspended = {
      ...installed("suspend"),
      installation: { ...INSTALLATION, suspended_at: suspendedAt },
    };
    expect((await answer(delivery("installation", suspended))).status).toBe(200);
    expect((await findInstallation(t.db, 41))?.suspendedAt).toEqual(new Date(suspendedAt));

    const back = {
      ...installed("unsuspend"),
      installation: { ...INSTALLATION, account: { ...INSTALLATION.account, login: "renamed" } },
    };
    expect((await answer(delivery("installation", back))).status).toBe(200);
    expect(await findInstallation(t.db, 41)).toMatchObject({
      accountLogin: "renamed",
      suspendedAt: null,
    });
    expect(
      (await answer(delivery("installation", installed("new_permissions_accepted")))).status,
    ).toBe(200);
  });

  it("links repos added to an installation, storing it if it's new", async () => {
    await repo(5);
    await repo(6);
    const payload = installed("added", {
      repository_selection: "selected",
      repositories_added: [{ id: 6, name: "r6", full_name: "octo-org/r6", private: true }],
      repositories_removed: [],
    });
    expect(await answer(delivery("installation_repositories", payload))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect(await findInstallation(t.db, 41)).toBeDefined();
    expect(await linked()).toEqual({ r5: false, r6: true });
  });

  it("defers deletions to M8.5 and changes nothing", async () => {
    const id = await upsertInstallation(t.db, {
      githubInstallationId: 41,
      accountId: 9001,
      accountLogin: "octo-org",
      accountType: "Organization",
      suspendedAt: null,
    });
    await repo(1);
    await answer(
      delivery(
        "installation_repositories",
        installed("added", { repositories_added: [{ id: 1 }] }),
      ),
    );
    for (const [event, payload] of [
      ["installation", installed("deleted")],
      ["installation_repositories", installed("removed", { repositories_removed: [{ id: 1 }] })],
    ] as const) {
      expect(await answer(delivery(event, payload)), event).toEqual({
        status: 202,
        body: { status: "deferred" },
      });
    }
    expect((await findInstallation(t.db, 41))?.id).toBe(id);
    expect(await linked()).toEqual({ r1: true });
  });

  it("ignores other events and actions", async () => {
    for (const [event, payload] of [
      ["push", { ref: "refs/heads/main" }],
      ["pull_request", { action: "opened" }],
      ["installation", installed("some_new_action")],
      ["installation", installed("constructor")],
      ["installation_repositories", installed("toString")],
    ] as const) {
      expect(await answer(delivery(event, payload)), `${event}`).toEqual({
        status: 202,
        body: { status: "ignored" },
      });
    }
    expect(await t.db.select().from(installations)).toEqual([]);
  });

  it("refuses a signed payload out of shape and writes nothing", async () => {
    const bad = [
      { ...installed("created"), action: 1 },
      { ...installed("created"), installation: undefined },
      { ...installed("created"), installation: { ...INSTALLATION, id: "41" } },
      { ...installed("created"), installation: { ...INSTALLATION, id: 0 } },
      {
        ...installed("created"),
        installation: { ...INSTALLATION, account: { ...INSTALLATION.account, login: "../x" } },
      },
      {
        ...installed("created"),
        installation: { ...INSTALLATION, account: { ...INSTALLATION.account, type: "Enterprise" } },
      },
      {
        ...installed("created"),
        installation: { ...INSTALLATION, account: { ...INSTALLATION.account, id: -1 } },
      },
      { ...installed("suspend"), installation: { ...INSTALLATION, suspended_at: "yesterday" } },
      { ...installed("suspend"), installation: { ...INSTALLATION, suspended_at: 5 } },
      installed("created", { repositories: "all" }),
      installed("created", { repositories: [{ id: 1 }, { name: "no-id" }] }),
    ];
    for (const payload of bad) {
      expect(await answer(delivery("installation", payload)), JSON.stringify(payload)).toEqual({
        status: 400,
        body: { error: "INVALID_PAYLOAD" },
      });
    }
    expect(await answer(delivery("Installation", installed("created")))).toEqual({
      status: 400,
      body: { error: "BAD_EVENT" },
    });
    expect(await t.db.select().from(installations)).toEqual([]);
  });

  it("answers 500 on a database failure, logging the error's name only", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => errors.mockRestore());
    const broken: WebhookDeps = {
      ...deps,
      db: {
        transaction: () => Promise.reject(new Error("postgres://user:secret@host")),
      } as unknown as WebhookDeps["db"],
    };
    expect(await answer(delivery("installation", installed("created")), broken)).toEqual({
      status: 500,
      body: { error: "INTERNAL" },
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).not.toContain("secret");
  });
});
