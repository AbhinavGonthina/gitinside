import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimRepoAnalysis, releaseRepoAnalysis, repos, upsertRepo } from "./index.js";
import { createTestDb, type TestDb } from "./testing.js";

let t: TestDb;
let repoId: string;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(repos);
  ({ id: repoId } = await upsertRepo(t.db, { providerRepoId: 4242, ...repoFacts("shop") }));
});

const repoFacts = (name: string) =>
  ({ owner: "acme", name, visibility: "public", defaultBranch: "main" }) as const;

const A = "a".repeat(40);
const B = "b".repeat(40);
const PERIOD = 1800;

/** Move the standing claim `seconds` into the past. */
const ageBy = (seconds: number) =>
  t.db.update(repos).set({
    analysisClaimedAt: sql`date_trunc('milliseconds', now()) - ${seconds} * interval '1 second'`,
  });

async function claimRow() {
  const [row] = await t.db
    .select({ sha: repos.analysisClaimSha, at: repos.analysisClaimedAt })
    .from(repos);
  return row;
}

describe("claimRepoAnalysis", () => {
  it("claims a repo with no claim, then refuses other commits for the period", async () => {
    const claim = await claimRepoAnalysis(t.db, repoId, A, PERIOD);
    expect(claim.status).toBe("claimed");
    const { claimedAt } = claim as { claimedAt: Date };
    expect(Math.abs(Date.now() - claimedAt.getTime())).toBeLessThan(60_000);
    expect(await claimRow()).toEqual({ sha: A, at: claimedAt });

    expect(await claimRepoAnalysis(t.db, repoId, B, PERIOD)).toEqual({
      status: "refused",
      claimedAt,
      retryAt: new Date(claimedAt.getTime() + PERIOD * 1000),
    });
    // The refusal changed nothing.
    expect(await claimRow()).toEqual({ sha: A, at: claimedAt });
  });

  it("lets the claiming commit through again without a new claim", async () => {
    const claim = await claimRepoAnalysis(t.db, repoId, A, PERIOD);
    expect(await claimRepoAnalysis(t.db, repoId, A, PERIOD)).toEqual({ status: "same-commit" });
    expect((await claimRow())?.at).toEqual((claim as { claimedAt: Date }).claimedAt);
  });

  it("frees the repo once the period has passed, not a second before", async () => {
    await claimRepoAnalysis(t.db, repoId, A, PERIOD);
    await ageBy(PERIOD - 1);
    expect((await claimRepoAnalysis(t.db, repoId, B, PERIOD)).status).toBe("refused");
    await ageBy(PERIOD);
    expect((await claimRepoAnalysis(t.db, repoId, B, PERIOD)).status).toBe("claimed");
    expect((await claimRow())?.sha).toBe(B);
    // A new claim starts a whole new period, for the old commit too.
    expect((await claimRepoAnalysis(t.db, repoId, A, PERIOD)).status).toBe("refused");
  });

  it("an expired claim for the same commit is claimed afresh", async () => {
    await claimRepoAnalysis(t.db, repoId, A, PERIOD);
    await ageBy(PERIOD);
    expect((await claimRepoAnalysis(t.db, repoId, A, PERIOD)).status).toBe("claimed");
  });

  it("gives one claim to racing requests for different commits", async () => {
    const shas = ["1", "2", "3", "4", "5", "6"].map((c) => c.repeat(40));
    const claims = await Promise.all(
      shas.map((sha) => claimRepoAnalysis(t.db, repoId, sha, PERIOD)),
    );
    expect(claims.filter((c) => c.status === "claimed")).toHaveLength(1);
    expect(claims.filter((c) => c.status === "refused")).toHaveLength(5);
  });

  it("keeps repos apart", async () => {
    const other = await upsertRepo(t.db, { providerRepoId: 7, ...repoFacts("other") });
    expect((await claimRepoAnalysis(t.db, repoId, A, PERIOD)).status).toBe("claimed");
    expect((await claimRepoAnalysis(t.db, other.id, B, PERIOD)).status).toBe("claimed");
  });

  it("throws for a repo with no row, and for a period that isn't positive and finite", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(claimRepoAnalysis(t.db, missing, A, PERIOD)).rejects.toThrow("no repo row");
    for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(claimRepoAnalysis(t.db, repoId, A, seconds)).rejects.toThrow(RangeError);
    }
  });
});

describe("releaseRepoAnalysis", () => {
  it("gives the claim back, so another commit can claim at once", async () => {
    const claim = await claimRepoAnalysis(t.db, repoId, A, PERIOD);
    await releaseRepoAnalysis(t.db, repoId, (claim as { claimedAt: Date }).claimedAt);
    expect(await claimRow()).toEqual({ sha: null, at: null });
    expect((await claimRepoAnalysis(t.db, repoId, B, PERIOD)).status).toBe("claimed");
  });

  it("leaves a newer claim alone", async () => {
    const old = await claimRepoAnalysis(t.db, repoId, A, PERIOD);
    await ageBy(PERIOD);
    const fresh = await claimRepoAnalysis(t.db, repoId, B, PERIOD);
    await releaseRepoAnalysis(t.db, repoId, (old as { claimedAt: Date }).claimedAt);
    expect(await claimRow()).toEqual({ sha: B, at: (fresh as { claimedAt: Date }).claimedAt });
  });
});
