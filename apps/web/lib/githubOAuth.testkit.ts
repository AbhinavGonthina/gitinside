import { createHash } from "node:crypto";

/**
 * A fake of GitHub's user authorization for tests (M8.2): `POST
 * github.com/login/oauth/access_token` and `GET api.github.com/user`, checking what GitHub
 * checks: the client, the code (once), the redirect URI it was issued for, and the PKCE
 * verifier against the challenge given to the authorize page.
 */

export interface FakeAccount {
  id: number;
  login: string;
}

export interface FakeOAuth {
  fetch: typeof fetch;
  /**
   * Issue a code for `account`, as GitHub's authorize page would after the user approves:
   * for the authorize URL the site sent the browser to (its redirect URI and challenge).
   */
  approve(authorizeUrl: string, account: FakeAccount): string;
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
  const requests: FakeOAuth["requests"] = [];
  const failures: (Response | Error)[] = [];
  let next = 0;

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ method: request.method, url: request.url });
    const failure = failures.shift();
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;
    const url = new URL(request.url);

    if (request.method === "POST" && url.href === "https://github.com/login/oauth/access_token") {
      const form = new URLSearchParams(await request.text());
      const issued = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        form.get("client_id") !== FAKE_CLIENT.clientId ||
        form.get("client_secret") !== FAKE_CLIENT.clientSecret
      ) {
        return Response.json({ error: "incorrect_client_credentials" });
      }
      if (
        issued === undefined ||
        issued.redirectUri !== form.get("redirect_uri") ||
        issued.challenge !== challenge
      ) {
        return Response.json({ error: "bad_verification_code" });
      }
      codes.delete(form.get("code") ?? "");
      const token = `ghu_${String(++next).padStart(36, "0")}`;
      tokens.set(token, issued.account);
      return Response.json({
        access_token: token,
        token_type: "bearer",
        scope: "",
        ...(options.expiring !== false && {
          expires_in: EXPIRES_IN,
          refresh_token: `ghr_${String(next).padStart(76, "0")}`,
          refresh_token_expires_in: REFRESH_EXPIRES_IN,
        }),
      });
    }

    if (request.method === "GET" && url.href === "https://api.github.com/user") {
      const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const account = token === undefined ? undefined : tokens.get(token);
      if (account === undefined) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      return Response.json({ id: account.id, login: account.login, type: "User" });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };

  return {
    fetch: fakeFetch,
    requests,
    failNext: (r) => void failures.push(r),
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
