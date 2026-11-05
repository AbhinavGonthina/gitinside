// @vitest-environment node
import { peekRateLimit, rateLimits } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CHALLENGE_AFTER_PER_ADDRESS,
  CHALLENGE_AFTER_SITE,
  CHALLENGE_FAILED_MESSAGE,
  CHALLENGE_UNAVAILABLE_MESSAGE,
  challengeMessage,
  createTurnstile,
  passBotCheck,
  SITE_ANALYZE_KEY,
  TURNSTILE_VERIFY_URL,
  type BotCheck,
  type Verdict,
} from "./botCheck";

/** A fetch answering Cloudflare's `siteverify` with `answer`, recording each request. */
function siteverify(answer: Response | Error | (() => Promise<Response>)) {
  const seen: Request[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    seen.push(new Request(String(input), init));
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer.clone();
  };
  return { doFetch, seen };
}

const check = (doFetch: typeof fetch, timeoutMs = 5_000) =>
  createTurnstile({ siteKey: "0x4AAA", secret: "0x4BBB-secret", fetch: doFetch, timeoutMs });

describe("createTurnstile", () => {
  it("posts the secret and the token to Cloudflare's siteverify, and passes its success", async () => {
    const { doFetch, seen } = siteverify(Response.json({ success: true, action: "analyze" }));
    expect(await check(doFetch).verify("tok.en")).toBe("passed");
    expect(seen[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(seen[0]?.method).toBe("POST");
    const form = new URLSearchParams(await seen[0]!.text());
    expect(Object.fromEntries(form)).toEqual({ secret: "0x4BBB-secret", response: "tok.en" });
  });

  it("fails a token for another action, or one Cloudflare refuses", async () => {
    for (const body of [
      { success: true, action: "login" },
      { success: true },
      { success: false, "error-codes": ["invalid-input-response"] },
      { success: false, "error-codes": ["timeout-or-duplicate"] },
      { success: false },
    ]) {
      const { doFetch } = siteverify(Response.json(body));
      expect(await check(doFetch).verify("t"), JSON.stringify(body)).toBe("failed");
    }
  });

  it("is unavailable when the fault is ours or Cloudflare's, never the visitor's", async () => {
    const answers: (Response | Error)[] = [
      Response.json({ success: false, "error-codes": ["invalid-input-secret"] }),
      Response.json({ success: false, "error-codes": ["internal-error"] }),
      new Response("bad gateway", { status: 502 }),
      new Response("<html>"),
      Response.json(null),
      new TypeError("fetch failed"),
    ];
    for (const answer of answers) {
      const { doFetch } = siteverify(answer);
      expect(await check(doFetch).verify("t")).toBe("unavailable");
    }
  });

  it("gives up on a Cloudflare that doesn't answer", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    expect(await check(hanging, 20).verify("t")).toBe("unavailable");
  });
});

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(rateLimits);
});

const AT = new Date("2026-10-31T14:30:00.000Z");
const HOUR_START = new Date("2026-10-31T14:00:00.000Z");

/** A check whose verdict is fixed, recording the tokens it's asked about. */
function fakeCheck(verdict: Verdict): BotCheck & { tokens: string[] } {
  const tokens: string[] = [];
  return {
    siteKey: "0x4AAA",
    tokens,
    verify: async (token) => {
      tokens.push(token);
      return verdict;
    },
  };
}

async function counted(key: string, count: number, windowStart = HOUR_START) {
  await t.db.insert(rateLimits).values({ key, windowStart, count });
}

describe("passBotCheck", () => {
  it("asks nobody below both thresholds, and counts the request site-wide", async () => {
    await counted(SITE_ANALYZE_KEY, CHALLENGE_AFTER_SITE - 1);
    const bot = fakeCheck("failed");
    const started = CHALLENGE_AFTER_PER_ADDRESS - 1;
    expect(await passBotCheck(bot, t.db, started, undefined, AT)).toBeUndefined();
    expect(bot.tokens).toEqual([]);
    expect(await peekRateLimit(t.db, SITE_ANALYZE_KEY, AT)).toBe(CHALLENGE_AFTER_SITE);
  });

  it("asks an address that started enough analyses this hour, saying why", async () => {
    const started = CHALLENGE_AFTER_PER_ADDRESS;
    expect(await passBotCheck(fakeCheck("passed"), t.db, started, undefined, AT)).toEqual({
      status: 403,
      body: {
        error: "CHALLENGE_REQUIRED",
        message: challengeMessage("address"),
        siteKey: "0x4AAA",
      },
    });
    expect(challengeMessage("address")).toMatch(/^You've started several analyses this hour/);
    // Not counted site-wide until it's let through.
    expect(await peekRateLimit(t.db, SITE_ANALYZE_KEY, AT)).toBe(0);
  });

  it("asks everyone once the site has had enough requests this hour", async () => {
    await counted(SITE_ANALYZE_KEY, CHALLENGE_AFTER_SITE);
    expect(await passBotCheck(fakeCheck("passed"), t.db, 0, undefined, AT)).toMatchObject({
      status: 403,
      body: { error: "CHALLENGE_REQUIRED", message: challengeMessage("site") },
    });
    expect(challengeMessage("site")).toMatch(/^GitInside is busier than usual/);
    // Counted to decide, then given back: refused requests don't add up.
    expect(await peekRateLimit(t.db, SITE_ANALYZE_KEY, AT)).toBe(CHALLENGE_AFTER_SITE);
  });

  it("counts a parallel burst before deciding: only the ones under the threshold pass (R6)", async () => {
    await counted(SITE_ANALYZE_KEY, CHALLENGE_AFTER_SITE - 2);
    const answers = await Promise.all(
      [1, 2, 3, 4].map(() => passBotCheck(fakeCheck("passed"), t.db, 0, undefined, AT)),
    );
    expect(answers.map((a) => a?.body.error ?? "passed").sort()).toEqual([
      "CHALLENGE_REQUIRED",
      "CHALLENGE_REQUIRED",
      "passed",
      "passed",
    ]);
    expect(await peekRateLimit(t.db, SITE_ANALYZE_KEY, AT)).toBe(CHALLENGE_AFTER_SITE);
  });

  it("an earlier hour's site count doesn't carry over", async () => {
    await counted(SITE_ANALYZE_KEY, 500, new Date("2026-10-31T13:00:00.000Z"));
    expect(await passBotCheck(fakeCheck("failed"), t.db, 0, undefined, AT)).toBeUndefined();
  });

  it("lets a token that passes through, and counts it", async () => {
    const bot = fakeCheck("passed");
    const started = CHALLENGE_AFTER_PER_ADDRESS;
    expect(await passBotCheck(bot, t.db, started, "tok.en", AT)).toBeUndefined();
    expect(bot.tokens).toEqual(["tok.en"]);
    expect(await peekRateLimit(t.db, SITE_ANALYZE_KEY, AT)).toBe(1);
    // The site's check passed the same way, counted once.
    await counted(SITE_ANALYZE_KEY, CHALLENGE_AFTER_SITE, new Date("2026-10-31T15:00:00.000Z"));
    const later = new Date("2026-10-31T15:30:00.000Z");
    expect(await passBotCheck(bot, t.db, 0, "tok.en2", later)).toBeUndefined();
    expect(await peekRateLimit(t.db, SITE_ANALYZE_KEY, later)).toBe(CHALLENGE_AFTER_SITE + 1);
  });

  it("refuses a token that doesn't pass, and says so when Cloudflare can't be asked", async () => {
    const started = CHALLENGE_AFTER_PER_ADDRESS;
    expect(await passBotCheck(fakeCheck("failed"), t.db, started, "t", AT)).toEqual({
      status: 403,
      body: { error: "CHALLENGE_FAILED", message: CHALLENGE_FAILED_MESSAGE, siteKey: "0x4AAA" },
    });
    expect(await passBotCheck(fakeCheck("unavailable"), t.db, started, "t", AT)).toEqual({
      status: 503,
      body: { error: "CHALLENGE_UNAVAILABLE", message: CHALLENGE_UNAVAILABLE_MESSAGE },
    });
    expect(await peekRateLimit(t.db, SITE_ANALYZE_KEY, AT)).toBe(0);
  });

  it("doesn't check a token nobody asked for", async () => {
    const bot = fakeCheck("failed");
    expect(await passBotCheck(bot, t.db, 0, "stale", AT)).toBeUndefined();
    expect(bot.tokens).toEqual([]);
  });
});
