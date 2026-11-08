import { createHash } from "node:crypto";

/**
 * A fake of GitHub's user authorization for tests (M8.2): `POST
 * github.com/login/oauth/access_token` (a code, or a refresh token, M8.2c) and `GET
 * api.github.com/user`, checking what GitHub checks: the client, the code (once), the redirect
 * URI it was issued for, the PKCE verifier against the challenge given to the authorize page,
 * and refresh tokens (once each). For the dashboard (M8.2c) it also answers `GET
 * /user/installations` and `GET /user/installations/{id}/repositories` (both paged) from
 * {@link FakeOAuth.install}, and the access check (M8.4a) `GET /repositories/{id}` for a repo one
 * of them covers, with its `…/commits/HEAD` and `GET /repos/{owner}/{repo}/languages` for a
 * private page's check-on-view (M8.4c2), and `GET /repos/{owner}/{repo}` (with its
 * `…/commits/HEAD`) for a signed-in "Analyze" (M8.4c2b), and `GET
 * /repositories/{id}/contents/{path}?ref=` (raw) for a private code preview (M8.4c3). Requests are matched by path, so the same fake serves calls made
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
  /** GitHub's repo ID, for `GET /repositories/{id}` (M8.4a); without one it isn't found there. */
  id?: number;
  /**
   * The default branch's head, for `GET /repositories/{id}/commits/HEAD` (M8.4c2); without one
   * that's a 404.
   */
  sha?: string;
  /** `GET /repos/{owner}/{name}/languages`'s answer; default 50,000 bytes of TypeScript. */
  languages?: Record<string, unknown>;
  /**
   * A file's text at a commit, for `GET /repositories/{id}/contents/{path}?ref=` asked raw
   * (M8.4c3); `undefined` (or no function) is GitHub's 404.
   */
  file?: (path: string, ref: string) => string | undefined;
}

/** An installation of the app the fake lists for the accounts that can see it. */
export interface FakeInstallation {
  id: number;
  /** The account it's on; its `id` defaults to `1000 + ` the installation's. */
  account: { id?: number; login: string; type: "User" | "Organization" };
  selection?: "all" | "selected";
  /** When it was suspended (ISO), as GitHub's `suspended_at`; unset is `null`. */
  suspendedAt?: string;
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
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({
        total_count: seen.length,
        installations: seen.slice((page - 1) * perPage, page * perPage).map((i) => ({
          id: i.id,
          account: {
            id: i.account.id ?? 1000 + i.id,
            login: i.account.login,
            type: i.account.type,
          },
          repository_selection: i.selection ?? "all",
          suspended_at: i.suspendedAt ?? null,
        })),
      });
    }
    // A user's token sees a repo only where the app is installed and the user has access.
    const visible = seen.flatMap((i) => i.repos);
    const byId = /^\/repositories\/(\d+)(\/commits\/HEAD)?$/.exec(url.pathname);
    const byName = /^\/repos\/([^/]+)\/([^/]+)(\/commits\/HEAD)?$/.exec(url.pathname);
    if (byId !== null || byName !== null) {
      const [, owner = "", name = ""] = (byName ?? []).map(decodeURIComponent);
      const r = visible.find((repo) =>
        byId !== null
          ? repo.id !== undefined && String(repo.id) === byId[1]
          : repo.id !== undefined &&
            repo.owner.toLowerCase() === owner.toLowerCase() &&
            repo.name.toLowerCase() === name.toLowerCase(),
      );
      if (r === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      const head = byId !== null ? byId[2] : byName?.[3];
      if (head !== undefined) {
        return r.sha === undefined
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : new Response(r.sha, { headers: { "content-type": "application/vnd.github.sha" } });
      }
      return Response.json({
        id: r.id,
        name: r.name,
        full_name: `${r.owner}/${r.name}`,
        owner: { login: r.owner },
        private: r.private ?? false,
        default_branch: "main",
        size: 1_024,
      });
    }
    const contents = /^\/repositories\/(\d+)\/contents\/(.+)$/.exec(url.pathname);
    if (contents !== null) {
      const r = visible.find((repo) => repo.id !== undefined && String(repo.id) === contents[1]);
      const ref = url.searchParams.get("ref") ?? "";
      const path = (contents[2] ?? "").split("/").map(decodeURIComponent).join("/");
      const text = r?.file?.(path, ref);
      if (text === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      if (request.headers.get("accept") !== "application/vnd.github.raw+json") {
        return Response.json(
          { message: "Asked for JSON; the fake answers raw only" },
          { status: 415 },
        );
      }
      return new Response(text, { headers: { "content-type": "application/vnd.github.raw+json" } });
    }
    const languages = /^\/repos\/([^/]+)\/([^/]+)\/languages$/.exec(url.pathname);
    if (languages !== null) {
      const [, owner = "", name = ""] = languages.map(decodeURIComponent);
      const r = visible.find(
        (repo) =>
          repo.owner.toLowerCase() === owner.toLowerCase() &&
          repo.name.toLowerCase() === name.toLowerCase(),
      );
      if (r === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(r.languages ?? { TypeScript: 50_000 });
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
