import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  findInstallation,
  installations,
  LINK_CHUNK,
  linkInstallationRepos,
  repos,
  upsertInstallation,
  upsertRepo,
  type InstallationFacts,
} from "./index.js";
import { createTestDb, pgErrorCode, type TestDb } from "./testing.js";

const CHECK = "23514";

const OCTO: InstallationFacts = {
  githubInstallationId: 41,
  accountId: 9001,
  accountLogin: "octo-org",
  accountType: "Organization",
  suspendedAt: null,
};

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(repos);
  await t.db.delete(installations);
});

function repo(providerRepoId: number, name = `r${providerRepoId}`) {
  return upsertRepo(t.db, {
    providerRepoId,
    owner: "octo-org",
    name,
    visibility: "private",
    defaultBranch: "main",
  });
}

async function linkedTo(): Promise<Record<string, string | null>> {
  const rows = await t.db
    .select({ name: repos.name, installationId: repos.installationId })
    .from(repos);
  return Object.fromEntries(rows.map((r) => [r.name, r.installationId]));
}

describe("upsertInstallation", () => {
  it("stores an installation once and follows its account and suspension", async () => {
    const id = await upsertInstallation(t.db, OCTO);
    expect(await findInstallation(t.db, 41)).toEqual({ id, ...OCTO });

    const suspendedAt = new Date("2026-11-07T12:00:00.000Z");
    const renamed = { ...OCTO, accountLogin: "octo-renamed", suspendedAt };
    expect(await upsertInstallation(t.db, renamed)).toBe(id);
    expect(await findInstallation(t.db, 41)).toEqual({ id, ...renamed });

    expect(await upsertInstallation(t.db, { ...renamed, suspendedAt: null })).toBe(id);
    expect((await findInstallation(t.db, 41))?.suspendedAt).toBeNull();
    expect(await t.db.select().from(installations)).toHaveLength(1);
  });

  it("is idempotent for a delivery that arrives twice", async () => {
    const id = await upsertInstallation(t.db, OCTO);
    expect(await upsertInstallation(t.db, OCTO)).toBe(id);
    expect(await findInstallation(t.db, 41)).toEqual({ id, ...OCTO });
  });

  it("refuses an account type GitHub doesn't install on", async () => {
    const code = await pgErrorCode(
      upsertInstallation(t.db, { ...OCTO, accountType: "Enterprise" as "User" }),
    );
    expect(code).toBe(CHECK);
  });
});

describe("findInstallation", () => {
  it("answers undefined for an installation never stored", async () => {
    expect(await findInstallation(t.db, 404)).toBeUndefined();
  });
});

describe("linkInstallationRepos", () => {
  it("links the stored repos it names and nothing else", async () => {
    const id = await upsertInstallation(t.db, OCTO);
    await repo(1);
    await repo(2);
    await repo(3);
    expect(await linkInstallationRepos(t.db, 41, [1, 3, 999])).toBe(2);
    expect(await linkedTo()).toEqual({ r1: id, r2: null, r3: id });
  });

  it("moves a repo linked to another installation (a transfer)", async () => {
    const first = await upsertInstallation(t.db, OCTO);
    const second = await upsertInstallation(t.db, {
      ...OCTO,
      githubInstallationId: 42,
      accountId: 9002,
      accountLogin: "elsewhere",
    });
    await repo(1);
    await linkInstallationRepos(t.db, 41, [1]);
    expect(await linkedTo()).toEqual({ r1: first });
    await linkInstallationRepos(t.db, 42, [1]);
    expect(await linkedTo()).toEqual({ r1: second });
  });

  it("refuses an unknown installation and leaves links alone", async () => {
    const id = await upsertInstallation(t.db, OCTO);
    await repo(1);
    await linkInstallationRepos(t.db, 41, [1]);
    await expect(linkInstallationRepos(t.db, 404, [1])).rejects.toThrow(/unknown installation/);
    expect(await linkedTo()).toEqual({ r1: id });
  });

  it("links nothing for an empty list", async () => {
    await upsertInstallation(t.db, OCTO);
    await repo(1);
    expect(await linkInstallationRepos(t.db, 41, [])).toBe(0);
    expect(await linkedTo()).toEqual({ r1: null });
  });

  it("links lists longer than one statement takes", async () => {
    const id = await upsertInstallation(t.db, OCTO);
    await repo(1);
    await repo(LINK_CHUNK * 2 + 5);
    const ids = Array.from({ length: LINK_CHUNK * 2 + 5 }, (_, i) => i + 1);
    expect(await linkInstallationRepos(t.db, 41, ids)).toBe(2);
    expect(await linkedTo()).toEqual({ r1: id, [`r${LINK_CHUNK * 2 + 5}`]: id });
  });
});
