// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fakeGoogle } from "./google.testkit";
import {
  CLOUD_PLATFORM_SCOPE,
  GoogleAuthError,
  REFRESH_MARGIN_MS,
  createGoogleTokenSource,
  type GoogleTokenOptions,
} from "./googleAuth";

const AUDIENCE =
  "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel/providers/vercel";
const ACCOUNT = "enqueue@gitinside-demo.iam.gserviceaccount.com";
const OIDC = "header.vercel-oidc.signature";

function setup(overrides: Partial<GoogleTokenOptions> = {}) {
  let clock = Date.parse("2026-10-31T12:00:00Z");
  const google = fakeGoogle({
    audience: AUDIENCE,
    subjectToken: OIDC,
    serviceAccount: ACCOUNT,
    queues: [],
    now: () => clock,
  });
  let subjects = 0;
  const source = createGoogleTokenSource({
    subjectToken: async () => {
      subjects++;
      return OIDC;
    },
    audience: AUDIENCE,
    serviceAccount: ACCOUNT,
    fetch: google.fetch,
    now: () => clock,
    ...overrides,
  });
  return {
    google,
    source,
    subjects: () => subjects,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createGoogleTokenSource", () => {
  it("exchanges the platform token, then impersonates the service account", async () => {
    const { google, source } = setup();
    expect(await source.token()).toMatch(/^access-/);
    expect(google.requests).toEqual([
      "POST sts.googleapis.com/v1/token",
      `POST iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(ACCOUNT)}:generateAccessToken`,
    ]);
  });

  it("asks STS and IAM for exactly the documented fields", async () => {
    const bodies: unknown[] = [];
    const headers: (string | null)[] = [];
    const { google } = setup();
    const source = createGoogleTokenSource({
      subjectToken: async () => OIDC,
      audience: AUDIENCE,
      serviceAccount: ACCOUNT,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        bodies.push(await request.clone().json());
        headers.push(request.headers.get("authorization"));
        return google.fetch(request);
      },
    });
    await source.token();
    expect(bodies).toEqual([
      {
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: AUDIENCE,
        scope: CLOUD_PLATFORM_SCOPE,
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectToken: OIDC,
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      },
      { scope: [CLOUD_PLATFORM_SCOPE], lifetime: "3600s" },
    ]);
    // STS must get no Authorization header; IAM gets the federated token.
    expect(headers[0]).toBeNull();
    expect(headers[1]).toMatch(/^Bearer federated-/);
  });

  it("reuses the token until shortly before it expires", async () => {
    const { google, source, advance, subjects } = setup();
    const first = await source.token();
    advance(3_600_000 - REFRESH_MARGIN_MS - 1);
    expect(await source.token()).toBe(first);
    expect(google.requests).toHaveLength(2);
    advance(1);
    const second = await source.token();
    expect(second).not.toBe(first);
    expect(google.requests).toHaveLength(4);
    expect(subjects()).toBe(2);
  });

  it("callers arriving during a refresh share it", async () => {
    const { google, source } = setup();
    const tokens = await Promise.all([source.token(), source.token(), source.token()]);
    expect(new Set(tokens).size).toBe(1);
    expect(google.requests).toHaveLength(2);
  });

  it("names the failing step and status, never a token", async () => {
    const wrongAudience = setup({ audience: `${AUDIENCE}-other` });
    const error = await wrongAudience.source.token().catch((e: unknown) => e);
    expect(error).toEqual(new GoogleAuthError("sts status 400"));
    expect(String(error)).not.toContain(OIDC);

    const wrongAccount = setup({
      serviceAccount: "other-account@gitinside-demo.iam.gserviceaccount.com",
    });
    await expect(wrongAccount.source.token()).rejects.toThrow(
      new GoogleAuthError("impersonate status 403"),
    );
  });

  it("a missing platform token, a network failure, or a malformed answer fails", async () => {
    const noSubject = setup({
      subjectToken: () => Promise.reject(new Error("not on Vercel")),
    });
    await expect(noSubject.source.token()).rejects.toThrow(
      new GoogleAuthError("no platform OIDC token"),
    );

    const { google, source } = setup();
    google.failNext(new TypeError("fetch failed"));
    await expect(source.token()).rejects.toThrow(new GoogleAuthError("sts request failed"));
    google.failNext(Response.json({ token_type: "Bearer" }));
    await expect(source.token()).rejects.toThrow(new GoogleAuthError("sts malformed answer"));
    google.failNext(new Response("<html>", { status: 200 }));
    await expect(source.token()).rejects.toThrow(new GoogleAuthError("sts malformed answer"));
  });

  it("an impersonation answer without a usable expiry fails", async () => {
    const { google, source } = setup();
    const answers = [
      Response.json({ accessToken: "a" }),
      Response.json({ accessToken: "a", expireTime: "soon" }),
      Response.json({ accessToken: "", expireTime: "2026-10-31T13:00:00Z" }),
    ];
    for (const answer of answers) {
      const sts = await google.fetch("https://sts.googleapis.com/v1/token", {
        method: "POST",
        body: JSON.stringify({
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          audience: AUDIENCE,
          scope: CLOUD_PLATFORM_SCOPE,
          requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
          subjectToken: OIDC,
          subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
        }),
      });
      google.failNext(sts);
      google.failNext(answer);
      await expect(source.token()).rejects.toThrow(
        new GoogleAuthError("impersonate malformed answer"),
      );
    }
  });

  it("tries again after a failed refresh", async () => {
    const { google, source } = setup();
    google.failNext(new Response("", { status: 503 }));
    await expect(source.token()).rejects.toThrow("sts status 503");
    expect(await source.token()).toMatch(/^access-/);
  });

  it("refuses a malformed service account up front", () => {
    expect(() => setup({ serviceAccount: "enqueue@example.com" })).toThrow(
      "serviceAccount is not a service account email",
    );
  });
});
