// @vitest-environment node
import { describe, expect, it } from "vitest";
import { InstallationTokenError } from "./githubApp";
import { fakeApp } from "./githubApp.testkit";
import {
  HeldCheckRunError,
  heldCheckRunText,
  postHeldCheckRun,
  type HeldCheckRunTarget,
} from "./heldCheckRun";

const UNTIL = new Date("2026-12-01T00:00:00Z");
const HEAD = "1".repeat(40);
const TARGET: HeldCheckRunTarget = {
  installationId: 41,
  owner: "octo-org",
  name: "shop",
  headSha: HEAD,
};

describe("heldCheckRunText", () => {
  it("says a paused diff resumes with the next month, neutral", () => {
    expect(heldCheckRunText({ reason: "paused", until: UNTIL }, 6)).toEqual({
      name: "GitInside",
      conclusion: "neutral",
      title: "Paused until 2026-12-01 00:00 UTC",
      summary:
        "GitInside has used 80% of this month's free compute, so it isn't diffing pull requests until the next month starts. Nothing is wrong with this pull request: push a new commit after 2026-12-01 00:00 UTC for GitInside's review.",
    });
  });

  it("says a limited diff resumes with the next hour, naming the limit", () => {
    const text = heldCheckRunText(
      { reason: "limited", until: new Date("2026-11-14T23:00:00Z") },
      6,
    );
    expect(text.title).toBe("Skipped: this repo's 6 diffs this hour are used");
    expect(text.summary).toBe(
      "GitInside diffs at most 6 pull request commits per repo an hour, and this repo's are used, so this commit wasn't diffed. Nothing is wrong with this pull request: push a new commit after 2026-11-14 23:00 UTC for GitInside's review.",
    );
    expect(text.conclusion).toBe("neutral");
  });
});

describe("postHeldCheckRun", () => {
  function github(permissions: Record<string, string>, checkStatus = 201) {
    const fake = fakeApp([{ id: 41, owner: "octo-org", repos: ["shop"], permissions }]);
    const posts: { url: string; init: RequestInit | undefined }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new Request(input, init).url;
      if (!url.endsWith("/check-runs")) return fake.fetch(input, init);
      posts.push({ url, init });
      return Response.json({ id: 77 }, { status: checkStatus });
    };
    return { fake, posts, app: { appId: fake.appId, privateKey: fake.privateKey, fetch } };
  }
  const text = heldCheckRunText({ reason: "paused", until: UNTIL }, 6);

  it("posts the Check Run with a token for the one repo that writes checks only", async () => {
    const gh = github({ checks: "write", pull_requests: "write", metadata: "read" });
    await postHeldCheckRun(gh.app, TARGET, text, Date.now());
    expect(gh.fake.requests).toEqual([
      {
        method: "POST",
        path: "/app/installations/41/access_tokens",
        body: { repositories: ["shop"], permissions: { checks: "write", metadata: "read" } },
      },
    ]);
    expect(gh.posts.map((p) => p.url)).toEqual([
      "https://api.github.com/repos/octo-org/shop/check-runs",
    ]);
    const init = gh.posts[0]?.init;
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${gh.fake.issued[0]?.token}`,
    );
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "GitInside",
      head_sha: HEAD,
      status: "completed",
      conclusion: "neutral",
      output: { title: text.title, summary: text.summary },
    });
  });

  it("throws when no token can be had or GitHub refuses the post", async () => {
    const readOnly = github({ contents: "read", metadata: "read" });
    await expect(postHeldCheckRun(readOnly.app, TARGET, text, Date.now())).rejects.toBeInstanceOf(
      InstallationTokenError,
    );
    expect(readOnly.posts).toEqual([]);
    const refused = github({ checks: "write", metadata: "read" }, 422);
    await expect(postHeldCheckRun(refused.app, TARGET, text, Date.now())).rejects.toEqual(
      new HeldCheckRunError("HTTP 422"),
    );
  });

  it("needs the full head SHA", async () => {
    const gh = github({ checks: "write", metadata: "read" });
    await expect(
      postHeldCheckRun(gh.app, { ...TARGET, headSha: "1234567" }, text, Date.now()),
    ).rejects.toThrow("full head SHA");
    expect(gh.fake.requests).toEqual([]);
  });
});
