import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";

/**
 * A fake of GitHub's app endpoints for tests (M8.3c1): `POST
 * /app/installations/{id}/access_tokens` and `GET /app/installations/{id}`, checking what
 * GitHub checks: an RS256 JWT signed by the app's key, issued by its App ID, not expired, and
 * living at most 10 minutes; the installation (not suspended); and that it covers every
 * repository asked for. Its answer narrows to the repositories and permissions asked, as
 * GitHub's does. Requests are matched by path, so a loopback origin works too.
 */

export interface FakeAppInstallation {
  id: number;
  owner: string;
  repos: string[];
  /** As GitHub's `suspended_at` (ISO); unset is `null`. */
  suspendedAt?: string;
  /** What the installation grants; default contents and metadata read. */
  permissions?: Record<string, string>;
}

export interface FakeApp {
  fetch: typeof fetch;
  appId: string;
  privateKey: KeyObject;
  /** Every request seen: method, path, and the JSON body of a POST. */
  requests: { method: string; path: string; body?: unknown }[];
  /** Tokens issued, newest last. */
  issued: { token: string; installationId: number; repos: string[] }[];
  /** Answer the next request with this instead (once). */
  failNext(response: Response | Error): void;
  /** Change the answer to every token request from now on (e.g. a misbehaving GitHub). */
  tamper(edit: (body: Record<string, unknown>) => Record<string, unknown>): void;
}

export const FAKE_APP_ID = "424242";

/** One RSA key pair for every test file (generating one costs tens of ms). */
export const FAKE_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** Token lifetime GitHub gives installation tokens: one hour. */
export const TOKEN_LIFETIME_MS = 3_600_000;

function jwtProblem(
  authorization: string | null,
  appId: string,
  publicKey: KeyObject,
  nowSeconds: number,
): string | undefined {
  const jwt = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(authorization ?? "");
  if (jwt === null) return "no JWT";
  const [, header, payload, signature] = jwt as unknown as [string, string, string, string];
  const head = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: string };
  if (head.alg !== "RS256") return "not RS256";
  const signed = Buffer.from(`${header}.${payload}`);
  if (!verify("sha256", signed, publicKey, Buffer.from(signature, "base64url"))) {
    return "bad signature";
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
    string,
    unknown
  >;
  const { iat, exp, iss } = claims;
  if (String(iss) !== appId) return "wrong issuer";
  if (typeof iat !== "number" || typeof exp !== "number") return "no iat or exp";
  if (exp - iat > 600) return "lives over 10 minutes";
  if (iat > nowSeconds + 60 || exp <= nowSeconds) return "not valid now";
  return undefined;
}

/** A fake GitHub holding `installations`; its clock is `now` (ms), default `Date.now`. */
export function fakeApp(
  installations: FakeAppInstallation[],
  options: { now?: () => number; appId?: string; publicKey?: KeyObject } = {},
): FakeApp {
  const appId = options.appId ?? FAKE_APP_ID;
  const publicKey = options.publicKey ?? FAKE_KEYS.publicKey;
  const now = options.now ?? Date.now;
  const requests: FakeApp["requests"] = [];
  const issued: FakeApp["issued"] = [];
  const failures: (Response | Error)[] = [];
  let edit = (body: Record<string, unknown>) => body;
  let next = 0;

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? ((await request.json()) as unknown) : undefined;
    requests.push({ method: request.method, path, ...(body !== undefined && { body }) });
    const failure = failures.shift();
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;

    const problem = jwtProblem(
      request.headers.get("authorization"),
      appId,
      publicKey,
      Math.floor(now() / 1000),
    );
    if (problem !== undefined) {
      return Response.json(
        { message: `A JSON web token could not be decoded (${problem})` },
        {
          status: 401,
        },
      );
    }
    const match = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
    const installation = installations.find((i) => String(i.id) === match?.[1]);
    if (match === null || installation === undefined) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (request.method === "GET" && match[2] === undefined) {
      return Response.json({
        id: installation.id,
        account: { login: installation.owner },
        suspended_at: installation.suspendedAt ?? null,
      });
    }
    if (request.method !== "POST" || match[2] === undefined) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (installation.suspendedAt !== undefined) {
      return Response.json({ message: "This installation has been suspended" }, { status: 403 });
    }
    const asked = body as { repositories?: string[]; permissions?: Record<string, string> };
    const repos = asked.repositories ?? installation.repos;
    const covered = repos.map((name) =>
      installation.repos.find((r) => r.toLowerCase() === name.toLowerCase()),
    );
    if (covered.some((r) => r === undefined)) {
      return Response.json(
        { message: "There is at least one repository that does not exist or is not accessible" },
        { status: 422 },
      );
    }
    const granted = installation.permissions ?? { contents: "read", metadata: "read" };
    const permissions = asked.permissions ?? granted;
    const token = `ghs_${String(++next).padStart(36, "0")}`;
    issued.push({ token, installationId: installation.id, repos: covered as string[] });
    return Response.json(
      edit({
        token,
        expires_at: new Date(now() + TOKEN_LIFETIME_MS).toISOString(),
        permissions,
        repository_selection: "selected",
        repositories: (covered as string[]).map((name) => ({
          name,
          full_name: `${installation.owner}/${name}`,
          owner: { login: installation.owner },
          private: true,
        })),
      }),
      { status: 201 },
    );
  };

  return {
    fetch: fakeFetch,
    appId,
    privateKey: FAKE_KEYS.privateKey,
    requests,
    issued,
    failNext: (r) => void failures.push(r),
    tamper: (e) => void (edit = e),
  };
}
