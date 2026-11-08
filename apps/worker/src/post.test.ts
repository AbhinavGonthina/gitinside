// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http";
import { PR_COMMENT_MARKER, type CheckRunText } from "@gitinside/diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobFailure } from "./failure.js";
import { startFakeGitHub, type FakeGitHub } from "./github.testkit.js";
import {
  MAX_COMMENT_PAGES,
  MAX_POST_REDIRECTS,
  createCheckRun,
  postComment,
  type PostOptions,
} from "./post.js";

const TARGET = { owner: "acme", repo: "shop", number: 7 };
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BODY = `${PR_COMMENT_MARKER}\n### GitInside architecture check\nNo broken connections.`;
const CHECK: CheckRunText = {
  name: "GitInside",
  conclusion: "neutral",
  title: "1 broken connection",
  summary: "**1 broken connection.**",
};

interface Comment {
  id: number;
  body: string;
  user: { login: string; type: "Bot" | "User" };
}

/** What the fake API was asked, with methods and bodies. */
interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

/**
 * A fake GitHub API holding one pull request's comments and the Check Runs created: lists
 * comments in pages, edits, creates. `override` answers a request first when it returns true.
 */
function fakeApi(fake: FakeGitHub) {
  const state = {
    comments: [] as Comment[],
    checkRuns: [] as Record<string, unknown>[],
    calls: [] as Call[],
    nextId: 1000,
    override: undefined as ((call: Call, res: ServerResponse) => boolean) | undefined,
  };
  const json = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  fake.api = (req: IncomingMessage, res: ServerResponse) => {
    // No keep-alive: a pooled socket to a closed test's server would fail a later POST (which
    // fetch doesn't retry) once a new server gets the same port.
    res.setHeader("connection", "close");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const call: Call = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: text === "" ? undefined : (JSON.parse(text) as unknown),
      };
      state.calls.push(call);
      if (state.override?.(call, res) === true) return;
      const url = new URL(call.url, "http://x");
      const body = call.body as Record<string, unknown> | undefined;
      const edit = /^\/repos\/acme\/shop\/issues\/comments\/(\d+)$/.exec(url.pathname);
      if (call.method === "PATCH" && edit !== null) {
        const comment = state.comments.find((c) => c.id === Number(edit[1]));
        if (comment === undefined) return json(res, 404, { message: "Not Found" });
        comment.body = String(body?.body);
        return json(res, 200, comment);
      }
      if (url.pathname === "/repos/acme/shop/issues/7/comments") {
        if (call.method === "GET") {
          const perPage = Number(url.searchParams.get("per_page"));
          const page = Number(url.searchParams.get("page"));
          return json(res, 200, state.comments.slice((page - 1) * perPage, page * perPage));
        }
        if (call.method === "POST") {
          const comment: Comment = {
            id: state.nextId++,
            body: String(body?.body),
            user: { login: "gitinside[bot]", type: "Bot" },
          };
          state.comments.push(comment);
          return json(res, 201, comment);
        }
      }
      if (call.method === "POST" && url.pathname === "/repos/acme/shop/check-runs") {
        const run = { id: state.nextId++, ...body };
        state.checkRuns.push(run);
        return json(res, 201, run);
      }
      json(res, 418, { message: "unexpected" });
    });
  };
  return state;
}

const human = (id: number, body: string): Comment => ({
  id,
  body,
  user: { login: "octocat", type: "User" },
});
const bot = (id: number, body: string, login = "gitinside[bot]"): Comment => ({
  id,
  body,
  user: { login, type: "Bot" },
});

async function codeOf(promise: Promise<unknown>): Promise<[string, boolean]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JobFailure) return [error.code, error.retriable];
    throw error;
  }
  return ["OK", false];
}

let fake: FakeGitHub;
let api: ReturnType<typeof fakeApi>;
let options: PostOptions;

beforeEach(async () => {
  fake = await startFakeGitHub();
  api = fakeApi(fake);
  options = { token: "ghs_post", apiBase: fake.apiBase };
});
afterEach(async () => {
  await fake.close();
});

const methods = () => api.calls.map((c) => `${c.method} ${c.url}`);

describe("postComment", () => {
  it("creates the comment when none is stored or found, with the token and a JSON body", async () => {
    const id = await postComment(TARGET, BODY, undefined, options);
    expect(id).toBe(1000);
    expect(api.comments).toEqual([bot(1000, BODY)]);
    expect(methods()).toEqual([
      "GET /repos/acme/shop/issues/7/comments?per_page=100&page=1",
      "POST /repos/acme/shop/issues/7/comments",
    ]);
    for (const call of api.calls) expect(call.authorization).toBe("Bearer ghs_post");
    expect(api.calls[1]).toMatchObject({ contentType: "application/json", body: { body: BODY } });
  });

  it("edits the stored comment in place without listing", async () => {
    api.comments.push(bot(55, `${PR_COMMENT_MARKER}\nold`));
    expect(await postComment(TARGET, BODY, 55, options)).toBe(55);
    expect(api.comments).toEqual([bot(55, BODY)]);
    expect(methods()).toEqual(["PATCH /repos/acme/shop/issues/comments/55"]);
  });

  it("finds the bot's comment by its marker when the stored one was deleted, and edits it", async () => {
    api.comments.push(bot(60, `${PR_COMMENT_MARKER}\nold`));
    expect(await postComment(TARGET, BODY, 55, options)).toBe(60);
    expect(api.comments).toEqual([bot(60, BODY)]);
    expect(methods()).toEqual([
      "PATCH /repos/acme/shop/issues/comments/55",
      "GET /repos/acme/shop/issues/7/comments?per_page=100&page=1",
      "PATCH /repos/acme/shop/issues/comments/60",
    ]);
  });

  it("creates a new comment when the stored one was deleted and none is found", async () => {
    expect(await postComment(TARGET, BODY, 55, options)).toBe(1000);
    expect(api.comments).toEqual([bot(1000, BODY)]);
  });

  it("never edits a person's comment quoting the marker, or a bot's without it", async () => {
    api.comments.push(
      human(1, `${PR_COMMENT_MARKER}\nlook what I can do`),
      bot(2, `Thanks! ${PR_COMMENT_MARKER}`, "other[bot]"),
      bot(3, "Deployed preview", "vercel[bot]"),
    );
    expect(await postComment(TARGET, BODY, undefined, options)).toBe(1000);
    expect(api.comments.slice(0, 3).map((c) => c.body)).toEqual([
      `${PR_COMMENT_MARKER}\nlook what I can do`,
      `Thanks! ${PR_COMMENT_MARKER}`,
      "Deployed preview",
    ]);
  });

  it("reads later pages for the bot's comment, oldest first", async () => {
    for (let i = 1; i <= 150; i++) api.comments.push(human(i, `comment ${i}`));
    api.comments.push(
      bot(151, `${PR_COMMENT_MARKER}\nfirst`),
      bot(152, `${PR_COMMENT_MARKER}\ndupe`),
    );
    expect(await postComment(TARGET, BODY, undefined, options)).toBe(151);
    expect(methods()).toEqual([
      "GET /repos/acme/shop/issues/7/comments?per_page=100&page=1",
      "GET /repos/acme/shop/issues/7/comments?per_page=100&page=2",
      "PATCH /repos/acme/shop/issues/comments/151",
    ]);
  });

  it(`stops after ${MAX_COMMENT_PAGES} full pages and creates the comment`, async () => {
    for (let i = 1; i <= (MAX_COMMENT_PAGES + 1) * 100; i++) api.comments.push(human(i, "hi"));
    api.comments.push(bot(99_999, `${PR_COMMENT_MARKER}\nfar down`));
    expect(await postComment(TARGET, BODY, undefined, options)).toBe(1000);
    expect(api.calls.filter((c) => c.method === "GET")).toHaveLength(MAX_COMMENT_PAGES);
  });

  it("creates a comment when the found one is deleted before the edit", async () => {
    api.comments.push(bot(60, `${PR_COMMENT_MARKER}\nold`));
    api.override = (call, res) => {
      if (call.method !== "PATCH") return false;
      res.writeHead(404).end();
      return true;
    };
    expect(await postComment(TARGET, BODY, undefined, options)).toBe(1000);
  });

  it("refuses a body without the marker, asking nothing", async () => {
    await expect(postComment(TARGET, "hello", undefined, options)).rejects.toThrow(/marker/);
    expect(api.calls).toEqual([]);
  });
});

describe("createCheckRun", () => {
  it("creates the Check Run completed on the head commit, with its output", async () => {
    expect(await createCheckRun(TARGET, HEAD, CHECK, options)).toBe(1000);
    expect(api.calls).toEqual([
      {
        method: "POST",
        url: "/repos/acme/shop/check-runs",
        authorization: "Bearer ghs_post",
        contentType: "application/json",
        body: {
          name: "GitInside",
          head_sha: HEAD,
          status: "completed",
          conclusion: "neutral",
          output: { title: "1 broken connection", summary: "**1 broken connection.**" },
        },
      },
    ]);
  });

  it("refuses a short head SHA, asking nothing", async () => {
    await expect(createCheckRun(TARGET, "0123456", CHECK, options)).rejects.toThrow(/SHA/);
    expect(api.calls).toEqual([]);
  });
});

describe("posting failures", () => {
  const answer = (status: number, headers: Record<string, string> = {}, body = "{}") => {
    api.override = (_call, res) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body);
      return true;
    };
  };

  it.each([
    [500, {}, "POST_FAILED", true],
    [502, {}, "POST_FAILED", true],
    [408, {}, "POST_FAILED", true],
    [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED", true],
    [403, { "retry-after": "60" }, "GITHUB_RATE_LIMITED", true],
    [429, { "retry-after": "60" }, "GITHUB_RATE_LIMITED", true],
    [403, {}, "POST_REFUSED", false],
    [404, {}, "POST_REFUSED", false],
    [422, {}, "POST_REFUSED", false],
    [401, {}, "POST_REFUSED", false],
  ] as const)("maps %i %j to %s (retriable: %s)", async (status, headers, code, retriable) => {
    answer(status, headers);
    expect(await codeOf(createCheckRun(TARGET, HEAD, CHECK, options))).toEqual([code, retriable]);
    expect(await codeOf(postComment(TARGET, BODY, undefined, options))).toEqual([code, retriable]);
  });

  it("maps a non-404 refusal of the stored comment's edit, without looking further", async () => {
    answer(403);
    expect(await codeOf(postComment(TARGET, BODY, 55, options))).toEqual(["POST_REFUSED", false]);
    expect(methods()).toEqual(["PATCH /repos/acme/shop/issues/comments/55"]);
  });

  it.each([
    ["no ID", 201, "{}"],
    ["a zero ID", 201, '{"id":0}'],
    ["a string ID", 201, '{"id":"5"}'],
    ["not JSON", 201, "<html>"],
  ])("refuses a created answer with %s", async (_, status, body) => {
    answer(status, {}, body);
    expect(await codeOf(createCheckRun(TARGET, HEAD, CHECK, options))).toEqual([
      "POST_REFUSED",
      false,
    ]);
  });

  it("refuses an edit answering another comment's ID, and a comment list that isn't one", async () => {
    api.override = (call, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(call.method === "PATCH" ? '{"id":56}' : '{"comments":[]}');
      return true;
    };
    expect(await codeOf(postComment(TARGET, BODY, 55, options))).toEqual(["POST_REFUSED", false]);
    expect(await codeOf(postComment(TARGET, BODY, undefined, options))).toEqual([
      "POST_REFUSED",
      false,
    ]);
  });

  it("is the retriable POST_FAILED when GitHub can't be reached", async () => {
    const down = { ...options, apiBase: "http://127.0.0.1:1" };
    expect(await codeOf(createCheckRun(TARGET, HEAD, CHECK, down))).toEqual(["POST_FAILED", true]);
  });

  it("rethrows the signal's reason when it fires", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(
      createCheckRun(TARGET, HEAD, CHECK, { ...options, signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

describe("posting redirects", () => {
  it("follows a 307 inside the API with the method, body, and token", async () => {
    let moved = false;
    api.override = (call, res) => {
      if (moved) return false;
      moved = true;
      res.writeHead(307, { location: call.url }).end();
      return true;
    };
    expect(await createCheckRun(TARGET, HEAD, CHECK, options)).toBe(1000);
    expect(
      api.calls.map((c) => [c.method, c.authorization, (c.body as { name: string }).name]),
    ).toEqual([
      ["POST", "Bearer ghs_post", "GitInside"],
      ["POST", "Bearer ghs_post", "GitInside"],
    ]);
  });

  it("refuses a redirect to another origin, never sending the token there", async () => {
    const elsewhere = await startFakeGitHub();
    try {
      api.override = (_call, res) => {
        res.writeHead(307, { location: `${elsewhere.apiBase}/repos/acme/shop/check-runs` }).end();
        return true;
      };
      expect(await codeOf(createCheckRun(TARGET, HEAD, CHECK, options))).toEqual([
        "POST_REFUSED",
        false,
      ]);
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it("refuses a 301 for a write (it would turn into a GET) and a redirect loop", async () => {
    api.override = (call, res) => {
      res.writeHead(301, { location: call.url }).end();
      return true;
    };
    expect(await codeOf(createCheckRun(TARGET, HEAD, CHECK, options))).toEqual([
      "POST_REFUSED",
      false,
    ]);
    api.calls.length = 0;
    api.override = (call, res) => {
      res.writeHead(307, { location: call.url }).end();
      return true;
    };
    expect(await codeOf(createCheckRun(TARGET, HEAD, CHECK, options))).toEqual([
      "POST_REFUSED",
      false,
    ]);
    expect(api.calls).toHaveLength(MAX_POST_REDIRECTS + 1);
  });

  it("follows a 301 for the comment list", async () => {
    let moved = false;
    api.override = (call, res) => {
      if (moved || call.method !== "GET") return false;
      moved = true;
      res.writeHead(301, { location: call.url }).end();
      return true;
    };
    expect(await postComment(TARGET, BODY, undefined, options)).toBe(1000);
  });
});
