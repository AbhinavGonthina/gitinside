// @vitest-environment node
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appCredentials,
  appJwt,
  InstallationTokenError,
  JOB_PERMISSIONS,
  JWT_BACKDATE_SECONDS,
  JWT_LIFETIME_SECONDS,
  mintInstallationToken,
  POST_PERMISSIONS,
  type InstallationTokenCode,
} from "./githubApp";
import {
  FAKE_APP_ID,
  FAKE_KEYS,
  fakeApp,
  TOKEN_LIFETIME_MS,
  type FakeAppInstallation,
} from "./githubApp.testkit";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const PEM = FAKE_KEYS.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const ACME: FakeAppInstallation = { id: 41, owner: "acme", repos: ["shop", "billing"] };
const SHOP = { owner: "acme", name: "shop" };
/** What GitInside's app asks of an installation (SPEC §3). */
const BOT_GRANTS = {
  contents: "read",
  metadata: "read",
  pull_requests: "write",
  checks: "write",
};

function setup(installations: FakeAppInstallation[] = [ACME], now = () => NOW) {
  const github = fakeApp(installations, { now });
  return {
    github,
    app: { appId: github.appId, privateKey: github.privateKey, fetch: github.fetch },
  };
}

async function refusal(promise: Promise<unknown>): Promise<InstallationTokenError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InstallationTokenError);
  return error as InstallationTokenError;
}

async function code(promise: Promise<unknown>): Promise<InstallationTokenCode> {
  return (await refusal(promise)).code;
}

describe("appCredentials", () => {
  it("reads the App ID and an RSA key in PEM, PKCS#1 or PKCS#8", () => {
    expect(appCredentials(FAKE_APP_ID, PEM)?.appId).toBe(FAKE_APP_ID);
    const pkcs8 = FAKE_KEYS.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(appCredentials("5659224", pkcs8)?.privateKey.asymmetricKeyType).toBe("rsa");
  });

  it("reads a key pasted on one line with literal \\n sequences", () => {
    const oneLine = PEM.trimEnd().replaceAll("\n", "\\n");
    expect(oneLine).not.toContain("\n");
    expect(appCredentials(FAKE_APP_ID, oneLine)).toBeDefined();
  });

  it("is undefined without both values, with a malformed ID, or with a key that isn't RSA", () => {
    expect(appCredentials(undefined, PEM)).toBeUndefined();
    expect(appCredentials(FAKE_APP_ID, undefined)).toBeUndefined();
    expect(appCredentials("", PEM)).toBeUndefined();
    expect(appCredentials(FAKE_APP_ID, "")).toBeUndefined();
    for (const id of ["0", "-1", "12a", " 1", "1.5", "01"]) {
      expect(appCredentials(id, PEM), id).toBeUndefined();
    }
    expect(appCredentials(FAKE_APP_ID, "not a key")).toBeUndefined();
    const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    expect(appCredentials(FAKE_APP_ID, ed.toString())).toBeUndefined();
  });
});

describe("appJwt", () => {
  it("is RS256 over iat (backdated a minute), exp (9 minutes on), and the App ID", () => {
    const jwt = appJwt({ appId: FAKE_APP_ID, privateKey: FAKE_KEYS.privateKey }, NOW + 999);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const iat = NOW / 1000 - JWT_BACKDATE_SECONDS;
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat,
      exp: iat + JWT_LIFETIME_SECONDS,
      iss: FAKE_APP_ID,
    });
    expect(JWT_LIFETIME_SECONDS).toBeLessThanOrEqual(600); // GitHub's limit
    const signed = Buffer.from(`${header}.${payload}`);
    expect(verify("sha256", signed, FAKE_KEYS.publicKey, Buffer.from(signature, "base64url"))).toBe(
      true,
    );
  });
});

describe("mintInstallationToken", () => {
  it("asks for one repo with contents and metadata read, and returns GitHub's token", async () => {
    const { github, app } = setup();
    const minted = await mintInstallationToken(app, 41, SHOP, NOW);
    expect(minted).toEqual({ token: github.issued[0]?.token, expiresAt: NOW + TOKEN_LIFETIME_MS });
    expect(github.requests).toEqual([
      {
        method: "POST",
        path: "/app/installations/41/access_tokens",
        body: { repositories: ["shop"], permissions: { contents: "read", metadata: "read" } },
      },
    ]);
    expect(JOB_PERMISSIONS).toEqual({ contents: "read", metadata: "read" });
    expect(github.issued[0]?.repos).toEqual(["shop"]);
  });

  it("asks for the post's permissions alone, writing pull requests and checks (M8.6e1)", async () => {
    const { github, app } = setup([{ ...ACME, permissions: BOT_GRANTS }]);
    const minted = await mintInstallationToken(app, 41, SHOP, NOW, POST_PERMISSIONS);
    expect(minted.token).toBe(github.issued[0]?.token);
    expect(github.requests).toEqual([
      {
        method: "POST",
        path: "/app/installations/41/access_tokens",
        body: {
          repositories: ["shop"],
          permissions: { pull_requests: "write", checks: "write", metadata: "read" },
        },
      },
    ]);
    // The read token from the same installation still reads only.
    await mintInstallationToken(app, 41, SHOP, NOW);
    expect(github.requests[1]?.body).toMatchObject({ permissions: JOB_PERMISSIONS });
  });

  it("calls an installation that hasn't granted the bot's writes not installed (GitHub's 422)", async () => {
    const { app } = setup(); // contents and metadata read only
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW, POST_PERMISSIONS))).toBe(
      "REPO_NOT_INSTALLED",
    );
    const readOnlyChecks = setup([{ ...ACME, permissions: { ...BOT_GRANTS, checks: "read" } }]);
    expect(
      await code(mintInstallationToken(readOnlyChecks.app, 41, SHOP, NOW, POST_PERMISSIONS)),
    ).toBe("REPO_NOT_INSTALLED");
  });

  it.each<[string, Record<string, string>]>([
    ["contents read", { ...POST_PERMISSIONS, contents: "read" }],
    ["administration", { ...POST_PERMISSIONS, administration: "write" }],
    ["pull requests read only", { ...POST_PERMISSIONS, pull_requests: "read" }],
    ["metadata write", { ...POST_PERMISSIONS, metadata: "write" }],
  ])("refuses a post token whose answer grants %s", async (_, permissions) => {
    const { github, app } = setup([{ ...ACME, permissions: BOT_GRANTS }]);
    github.tamper((b) => ({ ...b, permissions }));
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW, POST_PERMISSIONS))).toBe(
      "GITHUB_UNAVAILABLE",
    );
  });

  it("passes GitHub's token through as an opaque string, up to 2,048 characters (M8.10g)", async () => {
    const { github, app } = setup();
    const long = `ghs_424242_${"a.b-c_".repeat(340)}`.slice(0, 2_048);
    github.tamper((b) => ({ ...b, token: long }));
    await expect(mintInstallationToken(app, 41, SHOP, NOW)).resolves.toMatchObject({
      token: long,
    });
  });

  it("matches the repo's owner and name without regard to case, as GitHub does", async () => {
    const { app } = setup();
    await expect(
      mintInstallationToken(app, 41, { owner: "ACME", name: "Shop" }, NOW),
    ).resolves.toMatchObject({ token: expect.stringMatching(/^ghs_/) });
  });

  it("asks the loopback fake GitHub when one is configured", async () => {
    const { github, app } = setup();
    const seen: string[] = [];
    const fetchVia: typeof fetch = (input, init) => {
      seen.push(new Request(input, init).url);
      return github.fetch(input, init);
    };
    await mintInstallationToken(
      { ...app, fetch: fetchVia, fakeOrigin: "http://127.0.0.1:4010" },
      41,
      SHOP,
      NOW,
    );
    expect(seen).toEqual(["http://127.0.0.1:4010/app/installations/41/access_tokens"]);
  });

  it("names a suspended installation, read from GitHub's installation after its 403", async () => {
    const { github, app } = setup([{ ...ACME, suspendedAt: "2026-11-06T10:00:00Z" }]);
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("INSTALLATION_SUSPENDED");
    expect(github.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /app/installations/41/access_tokens",
      "GET /app/installations/41",
    ]);
  });

  it("doesn't call a 403 a suspension when the installation isn't suspended", async () => {
    const { github, app } = setup();
    github.failNext(Response.json({ message: "Resource not accessible" }, { status: 403 }));
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("GITHUB_UNAVAILABLE");
  });

  it("calls a 403 whose installation is then gone not found, and a failed read unavailable", async () => {
    const { github, app } = setup();
    github.failNext(new Response("{}", { status: 403 }));
    github.failNext(new Response("{}", { status: 404 }));
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("INSTALLATION_NOT_FOUND");
    github.failNext(new Response("{}", { status: 403 }));
    github.failNext(new Response("{}", { status: 502 }));
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("GITHUB_UNAVAILABLE");
  });

  it("names an installation that doesn't exist and a repo it doesn't cover", async () => {
    const { app } = setup();
    expect(await code(mintInstallationToken(app, 99, SHOP, NOW))).toBe("INSTALLATION_NOT_FOUND");
    expect(await code(mintInstallationToken(app, 41, { owner: "acme", name: "hr" }, NOW))).toBe(
      "REPO_NOT_INSTALLED",
    );
  });

  it("names its own credentials refused: another key, another App ID, or a skewed clock", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const { app } = setup();
    expect(await code(mintInstallationToken({ ...app, privateKey: other }, 41, SHOP, NOW))).toBe(
      "APP_AUTH_FAILED",
    );
    expect(await code(mintInstallationToken({ ...app, appId: "1" }, 41, SHOP, NOW))).toBe(
      "APP_AUTH_FAILED",
    );
    // GitHub's clock 10 minutes ahead of ours: the JWT has already expired there.
    const ahead = setup([ACME], () => NOW + 10 * 60_000);
    expect(await code(mintInstallationToken(ahead.app, 41, SHOP, NOW))).toBe("APP_AUTH_FAILED");
    // 50 seconds behind is inside the backdated minute.
    const behind = setup([ACME], () => NOW - 50_000);
    await expect(mintInstallationToken(behind.app, 41, SHOP, NOW)).resolves.toBeDefined();
  });

  it("calls GitHub unavailable when it can't be reached, fails, or answers out of shape", async () => {
    const { github, app } = setup();
    github.failNext(new TypeError("fetch failed"));
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("GITHUB_UNAVAILABLE");
    github.failNext(new Response("{}", { status: 500 }));
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("GITHUB_UNAVAILABLE");
    github.failNext(new Response("{}", { status: 200 })); // not 201
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("GITHUB_UNAVAILABLE");
    github.failNext(new Response("<html>", { status: 201 }));
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("GITHUB_UNAVAILABLE");
  });

  it.each<[string, (body: Record<string, unknown>) => Record<string, unknown>]>([
    ["no token", ({ token: _, ...rest }) => rest],
    ["an empty token", (b) => ({ ...b, token: "" })],
    ["a token over 2,048 characters", (b) => ({ ...b, token: "t".repeat(2_049) })],
    ["no expiry", ({ expires_at: _, ...rest }) => rest],
    ["an expiry already past", (b) => ({ ...b, expires_at: new Date(NOW).toISOString() })],
    ["a token for every repo", ({ repositories: _, ...rest }) => rest],
    [
      "another repo",
      (b) => ({ ...b, repositories: [{ name: "billing", owner: { login: "acme" } }] }),
    ],
    [
      "another owner",
      (b) => ({ ...b, repositories: [{ name: "shop", owner: { login: "evil" } }] }),
    ],
    [
      "two repos",
      (b) => ({
        ...b,
        repositories: [
          { name: "shop", owner: { login: "acme" } },
          { name: "billing", owner: { login: "acme" } },
        ],
      }),
    ],
    ["write access", (b) => ({ ...b, permissions: { contents: "write", metadata: "read" } })],
    ["another permission", (b) => ({ ...b, permissions: { contents: "read", issues: "read" } })],
    ["no permissions", (b) => ({ ...b, permissions: {} })],
    ["permissions as a list", (b) => ({ ...b, permissions: ["contents"] })],
  ])("refuses an answer with %s", async (_, edit) => {
    const { github, app } = setup();
    github.tamper(edit);
    expect(await code(mintInstallationToken(app, 41, SHOP, NOW))).toBe("GITHUB_UNAVAILABLE");
  });

  it("logs reasons without the token or the repo's name", async () => {
    const { github, app } = setup();
    github.tamper((b) => ({ ...b, permissions: { contents: "write" } }));
    const error = await refusal(mintInstallationToken(app, 41, SHOP, NOW));
    const issued = github.issued[0]?.token ?? "missing";
    for (const text of [error.message, error.reason]) {
      expect(text).not.toContain(issued);
      expect(text).not.toContain("shop");
      expect(text).not.toContain("acme");
    }
  });

  it("refuses a malformed installation ID or repo before asking GitHub", async () => {
    const { github, app } = setup();
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(mintInstallationToken(app, id, SHOP, NOW), String(id)).rejects.toThrow(
        "installationId",
      );
    }
    for (const repo of [
      { owner: "-acme", name: "shop" },
      { owner: "acme", name: "a/b" },
      { owner: "acme", name: "" },
      { owner: "acme", name: ".." },
    ]) {
      await expect(mintInstallationToken(app, 41, repo, NOW)).rejects.toThrow("repo");
    }
    expect(github.requests).toEqual([]);
  });
});
