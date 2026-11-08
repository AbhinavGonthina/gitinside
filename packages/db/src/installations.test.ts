import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessCache,
  analyses,
  deleteInstallationData,
  findInstallation,
  findLinkedRepoIds,
  installations,
  installationSnapshotPrefix,
  LINK_CHUNK,
  linkInstallationRepos,
  pullRequests,
  repos,
  UnknownInstallationError,
  upsertInstallation,
  upsertRepo,
  users,
  type InstallationFacts,
  type RepoFacts,
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

const FACTS: RepoFacts = {
  providerRepoId: 1,
  owner: "octo-org",
  name: "r1",
  visibility: "private",
  defaultBranch: "main",
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
  await t.db.delete(users);
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

describe("findLinkedRepoIds (M8.5b2)", () => {
  it("answers only the repos linked to that installation now", async () => {
    await upsertInstallation(t.db, OCTO);
    await upsertInstallation(t.db, {
      ...OCTO,
      githubInstallationId: 42,
      accountId: 9002,
      accountLogin: "elsewhere",
    });
    const { id: linked } = await repo(1);
    const { id: unlinked } = await repo(2);
    const { id: elsewhere } = await repo(3);
    const { id: removed } = await repo(4);
    await linkInstallationRepos(t.db, 41, [1, 4]);
    await linkInstallationRepos(t.db, 42, [3]);
    await deleteInstallationData(t.db, 41, [4]);

    const asked = [removed, elsewhere, unlinked, linked, "not-a-row-id", "../41"];
    expect(await findLinkedRepoIds(t.db, 41, asked)).toEqual([linked]);
    expect(await findLinkedRepoIds(t.db, 42, asked)).toEqual([elsewhere]);
    expect(await findLinkedRepoIds(t.db, 404, asked)).toEqual([]);
    expect(await findLinkedRepoIds(t.db, 41, [])).toEqual([]);
  });

  it("answers nothing once the installation is deleted", async () => {
    await upsertInstallation(t.db, OCTO);
    const { id } = await repo(1);
    await linkInstallationRepos(t.db, 41, [1]);
    await deleteInstallationData(t.db, 41, "all");
    expect(await findLinkedRepoIds(t.db, 41, [id])).toEqual([]);
  });

  it("asks lists longer than one statement takes", async () => {
    await upsertInstallation(t.db, OCTO);
    const { id } = await repo(1);
    await linkInstallationRepos(t.db, 41, [1]);
    const many = Array.from(
      { length: LINK_CHUNK * 2 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(await findLinkedRepoIds(t.db, 41, [...many, id])).toEqual([id]);
  });
});

describe("deleteInstallationData (M8.5a)", () => {
  const SHA = "a".repeat(40);
  const SHA2 = "b".repeat(40);

  /** A repo with a `done` analysis per key, one PR record, and one access-cache row. */
  async function stocked(
    providerRepoId: number,
    visibility: "public" | "private",
    keys: (repoId: string) => string[],
    githubInstallationId?: number,
  ): Promise<string> {
    const { id } = await upsertRepo(t.db, {
      providerRepoId,
      owner: "octo-org",
      name: `r${providerRepoId}`,
      visibility,
      defaultBranch: "main",
      ...(githubInstallationId !== undefined && { githubInstallationId }),
    });
    const list = keys(id);
    for (const [i, snapshotKey] of list.entries()) {
      await t.db.insert(analyses).values({
        repoId: id,
        sha: SHA,
        analyzerVersion: `0.${i}.0`,
        status: "done",
        snapshotKey,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }
    await t.db
      .insert(pullRequests)
      .values({ repoId: id, number: 1, baseSha: SHA, headSha: SHA2, headAt: new Date() });
    const [user] = await t.db
      .insert(users)
      .values({ githubUserId: providerRepoId, login: `u${providerRepoId}` })
      .returning({ id: users.id });
    await t.db
      .insert(accessCache)
      .values({ userId: user?.id ?? "", repoId: id, allowed: true, checkedAt: new Date() });
    return id;
  }

  /** Per repo name: its installation link, snapshot keys, PR records, and access rows. */
  async function state() {
    const out: Record<
      string,
      { linked: string | null; keys: string[]; prs: number; access: number }
    > = {};
    for (const repo of await t.db.select().from(repos)) {
      const keys = (await t.db.select().from(analyses))
        .filter((a) => a.repoId === repo.id)
        .map((a) => a.snapshotKey ?? "")
        .sort();
      const prs = (await t.db.select().from(pullRequests)).filter((p) => p.repoId === repo.id);
      const access = (await t.db.select().from(accessCache)).filter((a) => a.repoId === repo.id);
      out[repo.name] = {
        linked: repo.installationId,
        keys,
        prs: prs.length,
        access: access.length,
      };
    }
    return out;
  }

  const priv =
    (installation: number, sha = SHA) =>
    (repoId: string) => [`private/${installation}/${repoId}/${sha}/0.0.0.json.gz`];

  it("deletes an uninstalled installation's private repos, and its snapshots of others", async () => {
    await upsertInstallation(t.db, OCTO);
    const other = await upsertInstallation(t.db, {
      ...OCTO,
      githubInstallationId: 42,
      accountId: 9002,
    });
    await stocked(1, "private", priv(41), 41);
    const publicKey = (name: string) => `public/octo-org/${name}/${SHA}/0.1.0.json.gz`;
    await stocked(2, "public", (id) => [...priv(41)(id), publicKey("r2")], 41);
    // Linked elsewhere now (a transfer), with a snapshot still under 41's prefix.
    const moved = await stocked(3, "private", (id) => [...priv(41)(id), ...priv(42, SHA2)(id)], 42);
    const r4 = await stocked(4, "private", priv(42), 42);
    await stocked(5, "public", () => [publicKey("r5")]);

    expect(await deleteInstallationData(t.db, 41, "all")).toEqual({
      deletedRepos: 1,
      unlinkedRepos: 1,
      installationDeleted: true,
      prefixes: ["private/41/"],
    });
    expect(await findInstallation(t.db, 41)).toBeUndefined();
    expect((await findInstallation(t.db, 42))?.id).toBe(other);
    expect(await state()).toEqual({
      r2: { linked: null, keys: [publicKey("r2")], prs: 0, access: 0 },
      r3: { linked: other, keys: priv(42, SHA2)(moved), prs: 1, access: 1 },
      r4: { linked: other, keys: priv(42)(r4), prs: 1, access: 1 },
      r5: { linked: null, keys: [publicKey("r5")], prs: 1, access: 1 },
    });
    // A redelivery deletes nothing more.
    const before = await state();
    expect(await deleteInstallationData(t.db, 41, "all")).toEqual({
      deletedRepos: 0,
      unlinkedRepos: 0,
      installationDeleted: false,
      prefixes: ["private/41/"],
    });
    expect(await state()).toEqual(before);
  });

  it("deletes only the repos removed from an installation, keeping the installation", async () => {
    const octo = await upsertInstallation(t.db, OCTO);
    await upsertInstallation(t.db, { ...OCTO, githubInstallationId: 42, accountId: 9002 });
    const r1 = await stocked(1, "private", priv(41), 41);
    const r2 = await stocked(2, "private", priv(41), 41);
    const publicKey = `public/octo-org/r3/${SHA}/0.1.0.json.gz`;
    const r3 = await stocked(3, "public", (id) => [...priv(41)(id), publicKey], 41);
    const r4 = await stocked(4, "private", priv(42), 42);

    // 4 is another installation's (only its 41-prefixed snapshots would go), 999 isn't stored.
    expect(await deleteInstallationData(t.db, 41, [1, 3, 4, 999])).toEqual({
      deletedRepos: 1,
      unlinkedRepos: 1,
      installationDeleted: false,
      prefixes: [r1, r3, r4].map((id) => `private/41/${id}/`).sort(),
    });
    expect((await findInstallation(t.db, 41))?.id).toBe(octo);
    expect(await state()).toEqual({
      r2: { linked: octo, keys: priv(41)(r2), prs: 1, access: 1 },
      r3: { linked: null, keys: [publicKey], prs: 0, access: 0 },
      r4: { linked: (await findInstallation(t.db, 42))?.id, keys: priv(42)(r4), prs: 1, access: 1 },
    });
  });

  it("deletes an unknown installation's snapshots of the repos named", async () => {
    const r1 = await stocked(1, "public", priv(41));
    expect(await deleteInstallationData(t.db, 41, [1])).toEqual({
      deletedRepos: 0,
      unlinkedRepos: 0,
      installationDeleted: false,
      prefixes: [`private/41/${r1}/`],
    });
    expect(await deleteInstallationData(t.db, 41, "all")).toMatchObject({ deletedRepos: 0 });
    expect(await state()).toEqual({ r1: { linked: null, keys: [], prs: 1, access: 1 } });
  });

  it("deletes lists longer than one statement takes", async () => {
    await upsertInstallation(t.db, OCTO);
    await stocked(1, "private", priv(41), 41);
    await stocked(LINK_CHUNK * 2 + 5, "private", priv(41), 41);
    const ids = Array.from({ length: LINK_CHUNK * 2 + 5 }, (_, i) => i + 1);
    expect(await deleteInstallationData(t.db, 41, ids)).toMatchObject({ deletedRepos: 2 });
    expect(await state()).toEqual({});
  });

  it("refuses an installation ID a key can't hold", async () => {
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => installationSnapshotPrefix(id), String(id)).toThrow(/positive integer/);
      await expect(deleteInstallationData(t.db, id, "all")).rejects.toThrow(/positive integer/);
    }
    expect(installationSnapshotPrefix(41)).toBe("private/41/");
  });
});

describe("upsertRepo with an installation (M8.3c2)", () => {
  it("links the repo to the installation it was read through", async () => {
    const id = await upsertInstallation(t.db, OCTO);
    await upsertRepo(t.db, { ...FACTS, githubInstallationId: 41 });
    expect(await linkedTo()).toEqual({ r1: id });
  });

  it("moves the link when the repo is read through another installation", async () => {
    await upsertInstallation(t.db, OCTO);
    const second = await upsertInstallation(t.db, { ...OCTO, githubInstallationId: 42 });
    await upsertRepo(t.db, { ...FACTS, githubInstallationId: 41 });
    await upsertRepo(t.db, { ...FACTS, githubInstallationId: 42 });
    expect(await linkedTo()).toEqual({ r1: second });
  });

  it("keeps the link when a job without an installation upserts the repo", async () => {
    const id = await upsertInstallation(t.db, OCTO);
    await upsertRepo(t.db, { ...FACTS, githubInstallationId: 41 });
    await upsertRepo(t.db, { ...FACTS, visibility: "public" });
    expect(await linkedTo()).toEqual({ r1: id });
  });

  it("refuses an installation that isn't stored and writes nothing", async () => {
    const error = await upsertRepo(t.db, { ...FACTS, githubInstallationId: 404 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnknownInstallationError);
    expect(await t.db.select().from(repos)).toEqual([]);
  });

  it("refuses an unknown installation without touching a stored repo", async () => {
    const id = await upsertInstallation(t.db, OCTO);
    await upsertRepo(t.db, { ...FACTS, githubInstallationId: 41 });
    await expect(
      upsertRepo(t.db, { ...FACTS, name: "renamed", githubInstallationId: 404 }),
    ).rejects.toThrow(UnknownInstallationError);
    expect(await linkedTo()).toEqual({ r1: id });
  });
});
