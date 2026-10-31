/**
 * A Google access token for the web app without a Google SDK or a key file (ADR-0114,
 * ADR-0141): Workload Identity Federation, in two requests.
 *
 * 1. **STS token exchange** (`POST sts.googleapis.com/v1/token`): the platform's OIDC token
 *    (Vercel's, from `subjectToken`) for a federated token. Google checks the token's issuer
 *    and audience against the pool's provider, named by `audience`.
 * 2. **Service-account impersonation** (`POST iamcredentials.googleapis.com/v1/…:
 *    generateAccessToken`): the federated token for a short-lived access token of
 *    `serviceAccount`, which may only create tasks (the pool's principal holds
 *    `roles/iam.workloadIdentityUser` on it, and nothing else).
 *
 * The access token is cached until {@link REFRESH_MARGIN_MS} before it expires, and callers
 * arriving during a refresh share it. Failures are {@link GoogleAuthError}s whose `reason`
 * names the step and status, never a token.
 */

/** Options for {@link createGoogleTokenSource}. */
export interface GoogleTokenOptions {
  /** The platform's OIDC token (a JWT), asked for at each refresh. */
  subjectToken: () => Promise<string>;
  /**
   * The provider's full resource name: `//iam.googleapis.com/projects/<number>/locations/
   * global/workloadIdentityPools/<pool>/providers/<provider>`.
   */
  audience: string;
  /** The service account to impersonate, e.g. `enqueue@<project>.iam.gserviceaccount.com`. */
  serviceAccount: string;
  /** Overrides for tests (the fake Google server). Default Google's. */
  endpoints?: { sts?: string; iamCredentials?: string };
  /** Each request gives up after this long. Default 5 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Clock for the cache (tests move it). Default `Date.now`. */
  now?: () => number;
}

/** Hands out a valid access token, refreshing it when needed. */
export interface GoogleTokenSource {
  token(): Promise<string>;
}

/** Thrown when a token can't be had; `reason` is for logs and holds no secret. */
export class GoogleAuthError extends Error {
  override name = "GoogleAuthError";
  constructor(readonly reason: string) {
    super(`google auth failed: ${reason}`);
  }
}

/** The only scope asked for; the service account's roles limit what it can do. */
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** A cached token is replaced this long before Google says it expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** Lifetime asked for the impersonated token (Google's default and maximum without an org policy). */
export const TOKEN_LIFETIME = "3600s";

const STS = "https://sts.googleapis.com/v1/token";
const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com";
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/;

/** A token source for `options.serviceAccount`. Throws at once on a malformed account. */
export function createGoogleTokenSource(options: GoogleTokenOptions): GoogleTokenSource {
  if (!SERVICE_ACCOUNT.test(options.serviceAccount)) {
    throw new Error("serviceAccount is not a service account email");
  }
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let cached: { token: string; refreshAt: number } | undefined;
  let pending: Promise<string> | undefined;

  /** POST `json` and return the parsed answer, or throw naming `step`. */
  async function post(step: string, url: string, json: object, bearer?: string) {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify(json),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GoogleAuthError(`${step} request failed`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GoogleAuthError(`${step} status ${response.status}`);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new GoogleAuthError(`${step} malformed answer`);
    }
  }

  async function refresh(): Promise<string> {
    let subject: string;
    try {
      subject = await options.subjectToken();
    } catch {
      throw new GoogleAuthError("no platform OIDC token");
    }
    const exchanged = await post("sts", options.endpoints?.sts ?? STS, {
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: options.audience,
      scope: CLOUD_PLATFORM_SCOPE,
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectToken: subject,
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    });
    const federated = stringField(exchanged, "access_token");
    if (federated === undefined) throw new GoogleAuthError("sts malformed answer");

    const base = options.endpoints?.iamCredentials ?? IAM_CREDENTIALS;
    const account = encodeURIComponent(options.serviceAccount);
    const issued = await post(
      "impersonate",
      `${base}/v1/projects/-/serviceAccounts/${account}:generateAccessToken`,
      { scope: [CLOUD_PLATFORM_SCOPE], lifetime: TOKEN_LIFETIME },
      federated,
    );
    const token = stringField(issued, "accessToken");
    const expires = Date.parse(stringField(issued, "expireTime") ?? "");
    if (token === undefined || Number.isNaN(expires)) {
      throw new GoogleAuthError("impersonate malformed answer");
    }
    cached = { token, refreshAt: expires - REFRESH_MARGIN_MS };
    return token;
  }

  return {
    async token() {
      if (cached !== undefined && now() < cached.refreshAt) return cached.token;
      pending ??= refresh().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}
