import { createHash } from "node:crypto";

/**
 * A fake of GitHub's user authorization for tests (M8.2): `POST
 * github.com/login/oauth/access_token` (a code, or a refresh token, M8.2c) and `GET
 * api.github.com/user`, checking what GitHub checks: the client, the code (once), the redirect
 * URI it was issued for, the PKCE verifier against the challenge given to the authorize page,
 * and refresh tokens (once each). For the dashboard (M8.2c) it also answers `GET
 * /user/installations` and `GET /user/installations/{id}/repositories` (paged) from
 * {@link FakeOAuth.install}. Requests are matched by path, so the same fake serves calls made
 * to github.com, to api.github.com, or to a loopback origin (`e2e/github.ts`).
 */

export interface FakeAccount {
  id: number;
  login: string;
}

/** A repo an installation covers. */
export interface FakeRepo {
  owner: string;
  name: string;
  private?: boolean;
}

/** An installation of the app the fake lists for the accounts that can see it. */
export interface FakeInstallation {
  id: number;
  account: { login: string; type: "User" | "Organization" };
  selection?: "all" | "selected";
  repos: FakeRepo[];
}

export interface FakeOAuth {
  fetch: typeof fetch;
  /**
   * Issue a code for `account`, as GitHub's authorize page would after the user approves:
   * for the authorize URL the site sent the browser to (its redirect URI and challenge).
   */
  approve(authorizeUrl: string, account: FakeAccount): string;
  /** Issue tokens for `account` without a sign-in, as a past code exchange would have. */
  issue(account: FakeAccount): { accessToken: string; refreshToken: string };
  /** Let `account` see these installations (replacing what it saw). */
  install(account: FakeAccount, installations: FakeInstallation[]): void;
  /** Stop accepting `token` (an access or refresh token), as revoking the app's access does. */
  revoke(token: string): void;
  /** Every request seen, by method and URL. */
  requests: { method: string; url: string }[];
  /** Answer the next request with this instead (once). */
  failNext(response: Response | Error): void;
}

export const FAKE_CLIENT = { clientId: "Iv23liFAKE", clientSecret: "fake-client-secret" };

/** Token lifetimes GitHub gives an app's expiring user tokens: 8 hours and 6 months. */
export const EXPIRES_IN = 28_800;
export const REFRESH_EXPIRES_IN = 15_811_200;

export function fakeOAuth(options: { expiring?: boolean } = {}): FakeOAuth {
  const codes = new Map<string, { account: FakeAccount; redirectUri: string; challenge: string }>();
  const tokens = new Map<string, FakeAccount>();
  const refreshTokens = new Map<string, FakeAccount>();
  const installations = new Map<number, FakeInstallation[]>();
  const requests: FakeOAuth["requests"] = [];
  const failures: (Response | Error)[] = [];
  let next = 0;

  const issue = (account: FakeAccount) => {
    const accessToken = `ghu_${String(++next).padStart(36, "0")}`;
    const refreshToken = `ghr_${String(next).padStart(76, "0")}`;
    tokens.set(accessToken, account);
    if (options.expiring !== false) refreshTokens.set(refreshToken, account);
    return { accessToken, refreshToken };
  };

  const tokenAnswer = (account: FakeAccount) => {
    const { accessToken, refreshToken } = issue(account);
    return Response.json({
      access_token: accessToken,
      token_type: "bearer",
      scope: "",
      ...(options.expiring !== false && {
        expires_in: EXPIRES_IN,
        refresh_token: refreshToken,
        refresh_token_expires_in: REFRESH_EXPIRES_IN,
      }),
    });
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ method: request.method, url: request.url });
    const failure = failures.shift();
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(await request.text());
      if (
        form.get("client_id") !== FAKE_CLIENT.clientId ||
        form.get("client_secret") !== FAKE_CLIENT.clientSecret
      ) {
        return Response.json({ error: "incorrect_client_credentials" });
      }
      if (form.get("grant_type") === "refresh_token") {
        const refresh = form.get("refresh_token") ?? "";
        const account = refreshTokens.get(refresh);
        if (account === undefined) return Response.json({ error: "bad_refresh_token" });
        refreshTokens.delete(refresh); // single use
        return tokenAnswer(account);
      }
      const issued = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        issued === undefined ||
        issued.redirectUri !== form.get("redirect_uri") ||
        issued.challenge !== challenge
      ) {
        return Response.json({ error: "bad_verification_code" });
      }
      codes.delete(form.get("code") ?? "");
      return tokenAnswer(issued.account);
    }

    if (request.method !== "GET") return Response.json({ message: "Not Found" }, { status: 404 });
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const account = token === undefined ? undefined : tokens.get(token);
    if (account === undefined)
      return Response.json({ message: "Bad credentials" }, { status: 401 });

    if (url.pathname === "/user") {
      return Response.json({ id: account.id, login: account.login, type: "User" });
    }
    const seen = installations.get(account.id) ?? [];
    if (url.pathname === "/user/installations") {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      return Response.json({
        total_count: seen.length,
        installations: seen.slice(0, perPage).map((i) => ({
          id: i.id,
          account: { login: i.account.login, type: i.account.type },
          repository_selection: i.selection ?? "all",
        })),
      });
    }
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    const installation = seen.find((i) => String(i.id) === repos?.[1]);
    if (installation !== undefined) {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({
        total_count: installation.repos.length,
        repositories: installation.repos.slice((page - 1) * perPage, page * perPage).map((r) => ({
          name: r.name,
          full_name: `${r.owner}/${r.name}`,
          owner: { login: r.owner },
          private: r.private ?? false,
        })),
      });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };

  return {
    fetch: fakeFetch,
    requests,
    failNext: (r) => void failures.push(r),
    issue,
    install: (account, list) => void installations.set(account.id, list),
    revoke: (token) => {
      tokens.delete(token);
      refreshTokens.delete(token);
    },
    approve(authorizeUrl, account) {
      const url = new URL(authorizeUrl);
      if (url.searchParams.get("client_id") !== FAKE_CLIENT.clientId) {
        throw new Error("authorize URL for another client");
      }
      if (url.searchParams.get("code_challenge_method") !== "S256") {
        throw new Error("no S256 challenge");
      }
      const code = `code${++next}`;
      codes.set(code, {
        account,
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        challenge: url.searchParams.get("code_challenge") ?? "",
      });
      return code;
    },
  };
}
