/**
 * A fake Google for tests: `fetch` answering the three calls the web app makes, with the
 * checks Google makes on them (ADR-0141).
 *
 * - `POST sts.googleapis.com/v1/token`: a JWT for the configured provider `audience` (the
 *   one `subjectToken` given) ⇒ a federated token.
 * - `POST iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<email>:
 *   generateAccessToken`: the federated token, for the one account it may impersonate ⇒ an
 *   access token expiring after `lifetimeMs`.
 * - `POST cloudtasks.googleapis.com/v2/<queue>/tasks`: that access token, an existing queue,
 *   a name under it, a dispatch deadline in [15 s, 30 min], an https URL, a POST, a base64
 *   body, an OIDC token ⇒ the task, or `409 ALREADY_EXISTS` if the name was ever used (Google
 *   keeps names up to a day; here, forever).
 *
 * Errors use Google's shape, `{ error: { code, message, status } }`.
 */

export interface FakeGoogleOptions {
  /** The provider's resource name STS accepts as `audience`. */
  audience: string;
  /** The platform OIDC token STS accepts. */
  subjectToken: string;
  /** The only account the federated identity may impersonate. */
  serviceAccount: string;
  /** Queues that exist, as `projects/<p>/locations/<l>/queues/<q>`. */
  queues: string[];
  /** Lifetime of issued access tokens. Default 1 h. */
  lifetimeMs?: number;
  /** Clock for `expireTime` and expiry checks. Default `Date.now`. */
  now?: () => number;
}

/** A task as the fake stored it. */
export interface FakeTask {
  name: string;
  dispatchDeadline: string;
  httpRequest: {
    url: string;
    httpMethod: string;
    headers: Record<string, string>;
    body: string;
    oidcToken: { serviceAccountEmail: string; audience?: string };
  };
}

export interface FakeGoogle {
  fetch: typeof fetch;
  /** Created tasks, in order. */
  tasks: FakeTask[];
  /** Every request: method and URL path, in order. */
  requests: string[];
  /** Answer the next request with this instead (once). */
  failNext(response: Response | Error): void;
}

const GENERATE = /^\/v1\/projects\/-\/serviceAccounts\/([^/]+):generateAccessToken$/;
const TASKS = /^\/v2\/(projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+)\/tasks$/;
const DEADLINE = /^([0-9]+)s$/;

function googleError(code: number, status: string, message: string): Response {
  return Response.json({ error: { code, message, status } }, { status: code });
}

export function fakeGoogle(options: FakeGoogleOptions): FakeGoogle {
  const now = options.now ?? Date.now;
  const tasks: FakeTask[] = [];
  const requests: string[] = [];
  const failures: (Response | Error)[] = [];
  const used = new Set<string>();
  const federated = new Set<string>();
  const access = new Map<string, number>();
  let counter = 0;

  async function sts(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    if (
      body.grantType !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
      body.requestedTokenType !== "urn:ietf:params:oauth:token-type:access_token" ||
      body.subjectTokenType !== "urn:ietf:params:oauth:token-type:jwt" ||
      typeof body.scope !== "string"
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (body.audience !== options.audience || body.subjectToken !== options.subjectToken) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const token = `federated-${++counter}`;
    federated.add(token);
    return Response.json({
      access_token: token,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: 3600,
    });
  }

  async function generate(request: Request, account: string): Promise<Response> {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (bearer === undefined || !federated.has(bearer)) {
      return googleError(401, "UNAUTHENTICATED", "Request had invalid credentials.");
    }
    if (decodeURIComponent(account) !== options.serviceAccount) {
      return googleError(403, "PERMISSION_DENIED", "Permission 'getAccessToken' denied.");
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (!Array.isArray(body.scope) || body.scope.length === 0) {
      return googleError(400, "INVALID_ARGUMENT", "Scope required.");
    }
    const token = `access-${++counter}`;
    const expires = now() + (options.lifetimeMs ?? 3_600_000);
    access.set(token, expires);
    return Response.json({ accessToken: token, expireTime: new Date(expires).toISOString() });
  }

  async function createTask(request: Request, queue: string): Promise<Response> {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const expires = bearer === undefined ? undefined : access.get(bearer);
    if (expires === undefined || now() >= expires) {
      return googleError(401, "UNAUTHENTICATED", "Request had invalid credentials.");
    }
    if (!options.queues.includes(queue)) {
      return googleError(404, "NOT_FOUND", "Requested entity was not found.");
    }
    const { task } = (await request.json()) as { task: FakeTask };
    const invalid = (message: string) => googleError(400, "INVALID_ARGUMENT", message);
    if (!task.name.startsWith(`${queue}/tasks/`)) return invalid("Task name not in queue.");
    const deadline = Number(DEADLINE.exec(task.dispatchDeadline)?.[1] ?? Number.NaN);
    if (!(deadline >= 15 && deadline <= 1800)) return invalid("Bad dispatch deadline.");
    const { httpRequest } = task;
    if (!httpRequest.url.startsWith("https://")) return invalid("URL must be https.");
    if (httpRequest.httpMethod !== "POST") return invalid("Body needs POST.");
    if (Buffer.from(httpRequest.body, "base64").toString("base64") !== httpRequest.body) {
      return invalid("Body is not base64.");
    }
    if (typeof httpRequest.oidcToken.serviceAccountEmail !== "string") {
      return invalid("OIDC token needs a service account.");
    }
    if (used.has(task.name)) {
      return googleError(409, "ALREADY_EXISTS", "Requested entity already exists");
    }
    used.add(task.name);
    tasks.push(task);
    return Response.json(task);
  }

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.host}${url.pathname}`);
    const failure = failures.shift();
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;
    if (request.method !== "POST") return googleError(404, "NOT_FOUND", "Not found.");

    if (url.host === "sts.googleapis.com" && url.pathname === "/v1/token") return sts(request);
    const account = GENERATE.exec(url.pathname)?.[1];
    if (url.host === "iamcredentials.googleapis.com" && account !== undefined) {
      return generate(request, account);
    }
    const queue = TASKS.exec(url.pathname)?.[1];
    if (url.host === "cloudtasks.googleapis.com" && queue !== undefined) {
      return createTask(request, queue);
    }
    return googleError(404, "NOT_FOUND", "Not found.");
  };

  return { fetch: fakeFetch, tasks, requests, failNext: (r) => void failures.push(r) };
}
