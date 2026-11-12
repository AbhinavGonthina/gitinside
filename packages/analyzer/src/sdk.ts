/**
 * External SDK detector (M2.6): calls made through a known third-party API client become
 * `external_call` edges to that API's `external` node. Nodes are keyed by the API's host with
 * {@link externalNode}, so `stripe.customers.create()` and `fetch("https://api.stripe.com/…")`
 * meet at one `external:ext/api.stripe.com` node.
 *
 * Patterns handled:
 * - The allowlisted packages in {@link SDK_PACKAGES} (subpath imports like `twilio/lib/x`
 *   count as the package), every `@googleapis/<api>` package, and every
 *   `@aws-sdk/client-<name>`: the listed ones by their real endpoint prefix, others as
 *   `<name>.amazonaws.com` at `heuristic`, since that host is inferred from the package name.
 * - Module values: default, named, and namespace imports, `import x = require()`, `require()`
 *   (as the default export), and destructured `require()`.
 * - Clients: `new X(…)` or `X(…)` where `X` is the default export, a listed class
 *   (`Resend`), a named export ending in `Client` (`S3Client`), or one of those read from a
 *   namespace import (`new aws.S3Client()`), or a nested path a package lists
 *   (`new calendar_v3.Calendar({ auth })`, `google.calendar({ version })`). Declarations typed
 *   with such a name (`constructor(private stripe: Stripe)`) are clients too, when how they
 *   were built isn't found (M9.7d): a declaration's initializer and, for an instance field,
 *   its `this.<name> = …` writes in the class's members, are read first. The call that builds
 *   a client is not itself a request.
 * - Values are traced like axios instances (`http.ts`): through variables, imports and
 *   workspace packages (taking the import's confidence), exports, CommonJS exports,
 *   `??`/`||`/`&&`, ternaries, `await`, and factory functions that return a client. Each
 *   branch (both sides, every `return`, every declaration, a field's initializer and every
 *   write; M9.7g) is read; clients of one package whose bases differ are one client whose
 *   base is only known at runtime (M9.7d), and so are clients of two packages, unless
 *   neither reads a base and both go to one host. A branch that is a name, member, or call
 *   not traced to an SDK (`opts.client ?? new OpenAI({ baseURL })`, a parameter) may hold any
 *   client: beside a client whose export reads a base, built with a base option or without
 *   one (`opts.client || new OpenAI()`, M9.7j), it's one built with an unseen base; beside a
 *   client that reads no base (Stripe) it changes nothing (ADR-0266, ADR-0267), until a
 *   later branch whose export reads a base joins, so the result doesn't depend on branch
 *   order (`opts.gh ?? app.octokit ?? new Octokit({ auth })`, M9.7l). A member read from
 *   the global object (`globalThis`, `global`, `window`, `self` when the repo's code doesn't
 *   declare that name) is what the same file writes at that path, joined: a write holding the
 *   read itself (`globalThis.ai ?? new OpenAI(…)` beside `globalThis.ai = ai`, a module's
 *   cache) adds nothing, an injected client (`setAI(c) { globalThis.ai = c }`) is unread,
 *   and a path the file never writes is unread (ADR-0268). A self-reference
 *   (`this.ai = this.ai || new OpenAI(…)`) adds no branch, nor does `a && b`'s left side. Two
 *   values that aren't both clients keep the first.
 * - A request is a method call on a module value or a client, at any depth:
 *   `stripe.customers.create()`, `s3.send(cmd)`, `sgMail.send()`. Its site is the method
 *   name. The owner is the innermost symbol, or the routes of an inline Express handler;
 *   top-level calls belong to their file node, like HTTP requests. A chain naming a
 *   Jest/Vitest mock method or record anywhere (`create.mockResolvedValue(…)`,
 *   `create.mock.calls.at(-1)`, {@link MOCK_METHODS}) isn't a request.
 * - Base URLs (M9.1a3e2a, ADR-0249): a client of `openai`'s `OpenAI` (and its default
 *   export), `@anthropic-ai/sdk`'s `Anthropic`, and Octokit's `Octokit` reads the `baseURL`
 *   (Octokit: `baseUrl`) in the options object it's built with (a literal or a `const`
 *   object); `AzureOpenAI` reads `baseURL`, else `endpoint` + `/openai`, else the
 *   `AZURE_OPENAI_ENDPOINT` env var the SDK reads, so it never goes to OpenAI's host. Such a
 *   client's calls aren't drawn to the default host: each is a request for the HTTP stage's
 *   matcher, its URL the base (read like a `fetch` URL: literals, consts, templates, env
 *   vars) joined with the method's path from {@link SdkPackage.paths}
 *   (`chat.completions.create` ⇒ `POST /chat/completions`, `beta.` dropped). So a literal
 *   host is an `external` node, the repo's own server (`http://localhost:3001/api/v1/openai`)
 *   is matched to its routes, and a base only known at runtime (a parameter, a function's
 *   result, a spread or an unread options value) is unresolved with its reason. A method not
 *   in the table goes to a literal external host all the same, but is unresolved
 *   (`sdkPath`) for any other base. No options, or no base option, is the default host.
 *   A client known only by its type (`constructor(private ai: OpenAI)`) may have been built
 *   with any base, and one built with different bases on different branches
 *   (`LOCAL ? new OpenAI({ baseURL }) : new OpenAI()`) has no one base: both are unresolved
 *   (M9.7d), never drawn to the default host or to one branch's.
 *
 * Patterns not handled:
 * - Other SDKs' endpoint options: Stripe's `host`/`port`, Twilio's `edge`/`region`,
 *   Mailgun's `url` (its EU host), Slack's `slackApiUrl`, SendGrid's and Postmark's
 *   clients, the Google SDKs' `baseUrl`/`rootUrl`, and AWS's `endpoint`/`region`: their
 *   calls go to the default host as before. Octokit's `App` and `Octokit.defaults(…)`
 *   aren't read either. A base option read in another call (`client.baseURL = …`, the SDK's
 *   `withOptions(…)`), and the env vars `OpenAI`/`Anthropic` read when no option is set
 *   (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`), aren't followed: such clients keep the
 *   default host. Azure's deployment segment isn't added to the path, so only its host is
 *   drawn.
 * - Methods that run locally are skipped only when listed in `local` (Stripe's `webhooks`,
 *   SendGrid's `setApiKey`, Twilio's request validators, AWS `destroy`). Other local helpers
 *   still draw an edge, which at worst over-reports a dependency the code does have.
 * - Directly called named exports that aren't clients (`import { send } from "x"; send()`),
 *   and methods on results (`(await s3.send(cmd)).Body.transformToString()`): one call
 *   per chain counts, the one on the client.
 * - Clients destructured (`const { customers } = stripe`) or stored in collections; a cache
 *   in a module variable or a `Map` (`cache.get(k) ?? new OpenAI(…)`), or on the global
 *   object written only in another file, is an unread branch, so such a client's base is
 *   unresolved. A global path is matched by its members' names only, so a computed key
 *   (`g[key] = c`) isn't a write it sees. A parameter's default
 *   (`constructor(client = new OpenAI({ baseURL }))`) is read as its one client, though a
 *   caller may pass another. Writes to a static field, a parameter property's later writes,
 *   and a variable declared without an initializer and assigned later
 *   (`let c: OpenAI; c = …`) aren't read: such clients are known by type.
 * - SDKs whose host depends on the account or project (Supabase, Firebase, Algolia,
 *   Salesforce), SMTP clients (nodemailer), and telemetry (Sentry, PostHog). They're not on
 *   the allowlist, so like any third-party package they get no edge (ADR-0024).
 */
import ts from "typescript";
import {
  compareStrings,
  edgeId,
  type Confidence,
  type GraphEdge,
  type GraphNode,
  type HttpMethod,
  type SourceLocation,
} from "@gitinside/schema";
import type { SymbolResolver } from "./calls.js";
import { returnedExpressions, type FunctionWithBody } from "./express.js";
import { fileNodeId } from "./files.js";
import { functionOf, importBinding, locationOf, requiredModule } from "./http.js";
import { externalNode, isLoopbackHost } from "./match.js";
import { bindOwners, NO_OWNERS, ownersAt, withFallback, type Owners } from "./owners.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import {
  createUrlNormalizer,
  DYNAMIC_URL_DETAIL,
  formatUrlPattern,
  joinBaseURL,
  mergeParts,
  patternParts,
  toUrlPattern,
  type DynamicUrlDetail,
  type NormalizedUrl,
  type UrlPart,
} from "./url.js";
import {
  clip,
  CONFIDENCE_RANK,
  createValueReader,
  expressionText,
  MAX_HOPS,
  objectProperty,
  redactedText,
  weaker,
  type ProgramExpression,
} from "./values.js";
import type { HttpRequest, HttpRequestFact } from "./wrappers.js";
import { serviceForFile, type Workspace } from "./workspace.js";

/** A known API client package. */
export interface SdkPackage {
  /** The package name. */
  module: string;
  /** The API host its calls reach, as `externalHost()` would key it. */
  host: string;
  /** `exact` when the host is the SDK's documented endpoint, `heuristic` when inferred. */
  confidence: Confidence;
  /** Named exports that construct clients, besides the default and `*Client` names. */
  clients: readonly string[];
  /**
   * Export paths that construct clients, for SDKs that nest them (`calendar_v3.Calendar`,
   * `google.calendar`). Paths are export names joined by `.`.
   */
  clientPattern?: RegExp;
  /** Method or namespace names whose calls run locally and make no request. */
  local: readonly string[];
  /** Client exports whose constructor options can set a base URL, by export path (M9.1a3e2a). */
  bases?: ReadonlyMap<string, ClientBase>;
  /**
   * The request each known method makes, by method path after the client (`beta.` dropped):
   * `chat.completions.create` ⇒ `POST /chat/completions`, joined onto the client's base.
   */
  paths?: ReadonlyMap<string, readonly [HttpMethod, string]>;
}

/** An option a client's constructor reads its base URL from, and text the SDK appends to it. */
export interface BaseOption {
  name: string;
  suffix?: string;
}

/**
 * How one client export picks the base URL its requests go to (M9.1a3e2a): the first of
 * `options` its options object sets; when none is set, the env var `env` the SDK reads (with
 * its suffix), or, without `env`, the SDK's default host. `paths` says whether the package's
 * {@link SdkPackage.paths} apply (Azure's and Octokit's requests aren't listed).
 */
export interface ClientBase {
  options: readonly BaseOption[];
  env?: BaseOption;
  paths: boolean;
}

type SdkEntry = Omit<SdkPackage, "module" | "confidence">;

const entry = (
  host: string,
  clients: string[] = [],
  local: string[] = [],
  clientPattern?: RegExp,
): SdkEntry => ({ host, clients, local, ...(clientPattern ? { clientPattern } : {}) });

/** A versioned Google API class: `calendar_v3.Calendar`, `admin_directory_v1.Admin`. */
const GOOGLE_CLASS = "[a-z][a-z0-9_]*_v\\d[a-z0-9]*\\.[A-Z][A-Za-z0-9]*";

/**
 * Google's per-API packages (`@googleapis/calendar`): the versioned classes and the factory
 * named for the API (`calendar({ version, auth })`). `auth` only builds credentials.
 */
const GOOGLE_API_PACKAGE = entry(
  "www.googleapis.com",
  [],
  ["auth"],
  new RegExp(`^(?:${GOOGLE_CLASS}|(?!auth$)[a-z][a-z0-9]*)$`),
);

/** A client whose `baseURL` option replaces the default host, and whose paths are listed. */
const BASE_URL: ClientBase = { options: [{ name: "baseURL" }], paths: true };

/**
 * `AzureOpenAI`: its `baseURL`, else `endpoint` + `/openai`, else the `AZURE_OPENAI_ENDPOINT`
 * env var + `/openai`; it never uses OpenAI's host. Requests add a deployment segment the
 * table doesn't know, so only the host is drawn.
 */
const AZURE_BASE: ClientBase = {
  options: [{ name: "baseURL" }, { name: "endpoint", suffix: "/openai" }],
  env: { name: "AZURE_OPENAI_ENDPOINT", suffix: "/openai" },
  paths: false,
};

/** Octokit's `baseUrl` (GitHub Enterprise Server); its requests aren't listed. */
const OCTOKIT_BASE: ReadonlyMap<string, ClientBase> = new Map([
  ["Octokit", { options: [{ name: "baseUrl" }], paths: false }],
]);

/** The `openai` package's common requests, relative to its base (`…/v1`). */
const OPENAI_PATHS: ReadonlyMap<string, readonly [HttpMethod, string]> = new Map([
  ["audio.speech.create", ["POST", "/audio/speech"]],
  ["audio.transcriptions.create", ["POST", "/audio/transcriptions"]],
  ["audio.translations.create", ["POST", "/audio/translations"]],
  ["chat.completions.create", ["POST", "/chat/completions"]],
  ["chat.completions.parse", ["POST", "/chat/completions"]],
  ["chat.completions.stream", ["POST", "/chat/completions"]],
  ["completions.create", ["POST", "/completions"]],
  ["embeddings.create", ["POST", "/embeddings"]],
  ["images.edit", ["POST", "/images/edits"]],
  ["images.generate", ["POST", "/images/generations"]],
  ["models.list", ["GET", "/models"]],
  ["moderations.create", ["POST", "/moderations"]],
  ["responses.create", ["POST", "/responses"]],
  ["responses.stream", ["POST", "/responses"]],
  ["vectorStores.list", ["GET", "/vector_stores"]],
]);

/** `@anthropic-ai/sdk`'s common requests, relative to its base (the bare host). */
const ANTHROPIC_PATHS: ReadonlyMap<string, readonly [HttpMethod, string]> = new Map([
  ["completions.create", ["POST", "/v1/complete"]],
  ["messages.countTokens", ["POST", "/v1/messages/count_tokens"]],
  ["messages.create", ["POST", "/v1/messages"]],
  ["messages.stream", ["POST", "/v1/messages"]],
  ["models.list", ["GET", "/v1/models"]],
]);

/** The allowlist (ROADMAP M2.6), by package name. Hosts are the SDKs' default endpoints. */
export const SDK_PACKAGES: ReadonlyMap<string, SdkEntry> = new Map([
  [
    "@anthropic-ai/sdk",
    {
      ...entry("api.anthropic.com", ["Anthropic"]),
      bases: new Map([
        ["default", BASE_URL],
        ["Anthropic", BASE_URL],
      ]),
      paths: ANTHROPIC_PATHS,
    },
  ],
  ["@google/generative-ai", entry("generativelanguage.googleapis.com", ["GoogleGenerativeAI"])],
  ["@hubspot/api-client", entry("api.hubapi.com")],
  ["@octokit/core", { ...entry("api.github.com", ["Octokit"]), bases: OCTOKIT_BASE }],
  ["@octokit/rest", { ...entry("api.github.com", ["Octokit"]), bases: OCTOKIT_BASE }],
  ["@sendgrid/client", entry("api.sendgrid.com", [], ["setApiKey", "setDefaultHeader"])],
  [
    "@sendgrid/mail",
    entry(
      "api.sendgrid.com",
      ["MailService"],
      ["setApiKey", "setClient", "setSubstitutionWrappers", "setTimeout", "setTwilioEmailAuth"],
    ),
  ],
  ["@slack/web-api", entry("slack.com", ["WebClient"])],
  [
    "googleapis",
    entry(
      "www.googleapis.com",
      ["GoogleApis"],
      ["auth"],
      new RegExp(`^(?:${GOOGLE_CLASS}|google\\.(?!auth$)[a-z][a-z0-9]*)$`),
    ),
  ],
  ["mailgun.js", entry("api.mailgun.net", ["Mailgun"])],
  ["octokit", { ...entry("api.github.com", ["Octokit", "App"]), bases: OCTOKIT_BASE }],
  [
    "openai",
    {
      ...entry("api.openai.com", ["OpenAI", "AzureOpenAI"]),
      bases: new Map([
        ["default", BASE_URL],
        ["OpenAI", BASE_URL],
        ["AzureOpenAI", AZURE_BASE],
      ]),
      paths: OPENAI_PATHS,
    },
  ],
  ["postmark", entry("api.postmarkapp.com", ["ServerClient", "AccountClient"])],
  ["resend", entry("api.resend.com", ["Resend"])],
  ["stripe", entry("api.stripe.com", ["Stripe"], ["webhooks"])],
  [
    "twilio",
    entry(
      "api.twilio.com",
      ["Twilio"],
      ["validateRequest", "validateRequestWithBody", "validateExpressRequest", "webhook"],
    ),
  ],
]);

/**
 * AWS endpoint prefixes that differ from the `@aws-sdk/client-<name>` suffix, plus the
 * `lib-*` helpers that wrap a client. Other clients use the suffix, at `heuristic`.
 */
const AWS_HOSTS: ReadonlyMap<string, string> = new Map([
  ["cloudwatch", "monitoring"],
  ["cloudwatch-logs", "logs"],
  ["cognito-identity-provider", "cognito-idp"],
  ["dynamodb", "dynamodb"],
  ["eventbridge", "events"],
  ["kms", "kms"],
  ["lambda", "lambda"],
  ["lib-dynamodb", "dynamodb"],
  ["lib-storage", "s3"],
  ["s3", "s3"],
  ["secrets-manager", "secretsmanager"],
  ["ses", "email"],
  ["sesv2", "email"],
  ["sfn", "states"],
  ["sns", "sns"],
  ["sqs", "sqs"],
  ["ssm", "ssm"],
  ["sts", "sts"],
]);

/** The package a module specifier belongs to: `@a/b/c` ⇒ `@a/b`, `a/b` ⇒ `a`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** The allowlisted SDK a module specifier imports, if any. */
export function sdkPackage(specifier: string): SdkPackage | undefined {
  const module = packageOf(specifier);
  const known = SDK_PACKAGES.get(module);
  if (known) return { module, confidence: "exact", ...known };
  if (/^@googleapis\/[a-z0-9-]+$/.test(module)) {
    return { module, confidence: "exact", ...GOOGLE_API_PACKAGE };
  }
  const aws = /^@aws-sdk\/((?:client|lib)-[a-z0-9-]+)$/.exec(module)?.[1];
  if (aws === undefined) return undefined;
  const name = aws.replace(/^client-/, "");
  const prefix = AWS_HOSTS.get(name);
  if (prefix === undefined && aws.startsWith("lib-")) return undefined;
  return {
    module,
    host: `${prefix ?? name}.amazonaws.com`,
    confidence: prefix === undefined ? "heuristic" : "exact",
    clients: [],
    local: ["destroy", "middlewareStack"],
  };
}

/**
 * What an expression is when it comes from an SDK. `name` is the export it is (`default`,
 * `*` for the namespace, or a named export); `null` for clients and anything read from one.
 */
interface SdkValue {
  pkg: SdkPackage;
  name: string | null;
  confidence: Confidence;
  /** For a client of an export in {@link SdkPackage.bases}, where its requests go. */
  base?: SdkBase;
  /**
   * True when an unread branch was joined into this value (M9.7l): beside a client that reads
   * no base it changes nothing yet, but a later branch's client whose export reads a base
   * makes the join `branches`, whatever order the branches come in.
   */
  unread?: boolean;
}

/**
 * Where a client's requests go when its export reads a base URL (M9.1a3e2a): `value`, the
 * option's expression and the text the SDK appends; `env`, the env var the SDK reads when no
 * option is set; `unknown`, options a spread or an unread value could set it in; `unseen`, a
 * client known only by its type; `branches`, a client built on several branches with bases
 * that differ (M9.7d); `default`, a client built with no base option, so it goes to the SDK's
 * default host, though another client of its export may not (M9.7j). A client without one
 * reads no base at all and goes to the SDK's default host however it was built.
 */
type SdkBase =
  | { kind: "value"; value: ProgramExpression; suffix: string; paths: boolean }
  | { kind: "env"; name: string; suffix: string; paths: boolean }
  | { kind: "unknown"; options: ProgramExpression; paths: boolean }
  | { kind: "unseen"; paths: boolean }
  | { kind: "branches"; paths: boolean }
  | { kind: "default"; paths: boolean };

/** A base the HTTP stage reads: any but `default`. */
type ReadBase = Exclude<SdkBase, { kind: "default" }>;

/** True when a client's calls go to its SDK's default host: no base, or a `default` one. */
const defaultHost = (
  base: SdkBase | undefined,
): base is { kind: "default"; paths: boolean } | undefined =>
  base === undefined || base.kind === "default";

/** A branch whose value isn't traced to an SDK but may hold any client (M9.7g). */
const UNREAD = "unread";

/** One branch of a value: an SDK value, {@link UNREAD}, or nothing an SDK call is made on. */
type Branch = SdkValue | typeof UNREAD | undefined;

/** A joined value once every branch is in: an unread one alone is no SDK value. */
const settled = (branch: Branch): SdkValue | undefined => (branch === UNREAD ? undefined : branch);

/**
 * Names of the global object; a member read from one that its file writes is a cache, not an
 * injected client.
 */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["global", "globalThis", "self", "window"]);

/** The operators that store into a global member: `=`, `??=`, `||=`. */
const ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);

/** True for a declaration under a `declare` (`declare global { var ai: OpenAI }`). */
function ambient(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (
      ts.canHaveModifiers(n) &&
      ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      return true;
    }
  }
  return false;
}

/** The member an access names and the object it's read from: `g.ai`, `g["ai"]`. */
function memberOf(e: ts.Expression): { name: string; object: ts.Expression } | undefined {
  if (ts.isPropertyAccessExpression(e)) return { name: e.name.text, object: e.expression };
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return { name: e.argumentExpression.text, object: e.expression };
  }
  return undefined;
}

/**
 * The value a JS assignment declaration assigns (`this.ai = …`, `exports.x = …`): such a
 * declaration is the assignment, or its left side.
 */
function assignedValue(declaration: ts.Declaration): ts.Expression | undefined {
  if (ts.isBinaryExpression(declaration)) return declaration.right;
  const parent = declaration.parent as ts.Node | undefined;
  return ts.isPropertyAccessExpression(declaration) &&
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.left === declaration
    ? parent.right
    : undefined;
}

/**
 * Jest's and Vitest's mock methods (`create.mockResolvedValue(…)`) and their `mock` record
 * (`create.mock.calls.at(-1)`): a test configuring or reading a mocked client's method, not
 * a request. A chain naming any of them anywhere is skipped.
 */
const MOCK_METHODS: ReadonlySet<string> = new Set([
  "getMockName",
  "mock",
  "mockClear",
  "mockImplementation",
  "mockImplementationOnce",
  "mockName",
  "mockRejectedValue",
  "mockRejectedValueOnce",
  "mockReset",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockRestore",
  "mockReturnThis",
  "mockReturnValue",
  "mockReturnValueOnce",
  "withImplementation",
]);

/**
 * The export path of member `member` of an SDK value: `*` + `S3Client` ⇒ `S3Client`,
 * `calendar_v3` + `Calendar` ⇒ `calendar_v3.Calendar`.
 */
function memberPath(base: string, member: string): string {
  return base === "*" ? member : `${base}.${member}`;
}

/** True when export path `name` of a package constructs a client. */
function isClientExport(pkg: SdkPackage, name: string): boolean {
  return (
    name === "default" ||
    pkg.clients.includes(name) ||
    (!name.includes(".") && name.endsWith("Client")) ||
    (pkg.clientPattern?.test(name) ?? false)
  );
}

/** The graph output of the SDK detector. */
export interface SdkEdges {
  /** `external` nodes, sorted by ID. */
  nodes: GraphNode[];
  /** `external_call` edges, sorted by ID, unlabeled like `fetch` ones (ADR-0034). */
  edges: GraphEdge[];
  /**
   * Calls on clients built with a base URL, owners bound, sorted by site: the HTTP stage's
   * matcher draws them like `fetch` calls (`buildHttpEdges`, M9.1a3e2a).
   */
  requests: HttpRequest[];
}

/** One call through an SDK client, before its owners are bound (ADR-0094). Plain data. */
export interface SdkRequest {
  owners: Owners;
  /** The API host, keyed like `externalHost()`. */
  host: string;
  confidence: Confidence;
  site: SourceLocation;
}

/** What one service's program says about SDK calls, as plain data (ADR-0090, ADR-0172). */
export interface SdkFacts {
  /** Key of the service whose program found these. */
  service: string;
  /** Its requests to an SDK's default host, in walk order. */
  requests: SdkRequest[];
  /** Its requests on clients built with a base URL, in walk order (M9.1a3e2a). */
  http: HttpRequestFact[];
}

/** A method call on an SDK value: `stripe.customers.create` ⇒ `stripe`, [`customers`, `create`]. */
interface SdkCall {
  value: SdkValue;
  names: string[];
  /** The method name, the request's site. */
  name: ts.Node;
  /** The SDK value's expression (`this.ai` in `this.ai.models.list()`). */
  receiver: ts.Expression;
}

const compareLocations = (a: SourceLocation, b: SourceLocation): number =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/**
 * Find every call through an allowlisted SDK client (see the file comment) and draw an
 * `external_call` edge from its owners (or its file, for top-level code) to the API's
 * `external` node: {@link collectSdkFacts} per program, then {@link composeSdkEdges}.
 */
export function buildSdkEdges(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  workspace: Workspace,
  inlineHandlers: ReadonlyMap<string, readonly string[]> = new Map(),
): SdkEdges {
  return composeSdkEdges(
    programs.map((sp) => collectSdkFacts(sp, resolver, workspace)),
    inlineHandlers,
  );
}

/**
 * The global SDK step: bind each request's owners to Express's inline handlers
 * (`inlineHandlers`), then merge requests with the same source and host into one edge listing
 * every site, at the strongest confidence, in program then walk order.
 */
export function composeSdkEdges(
  facts: readonly SdkFacts[],
  inlineHandlers: ReadonlyMap<string, readonly string[]>,
): SdkEdges {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addEdge = (
    from: string,
    to: string,
    confidence: Confidence,
    site: SourceLocation,
  ): void => {
    const id = edgeId("external_call", from, to);
    const existing = edges.get(id);
    if (!existing) {
      edges.set(id, { id, kind: "external_call", from, to, confidence, sites: [site] });
      return;
    }
    if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = confidence;
    }
    if (!existing.sites.some((s) => compareLocations(s, site) === 0)) existing.sites.push(site);
  };

  for (const { requests } of facts) {
    for (const { owners, host, confidence, site } of requests) {
      const sources = bindOwners(owners, inlineHandlers);
      const external = externalNode(host);
      if (sources.length > 0 && !nodes.has(external.id)) nodes.set(external.id, external);
      for (const from of sources) addEdge(from, external.id, confidence, { ...site });
    }
  }

  const out = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of out) edge.sites.sort(compareLocations);
  const requests = facts
    .flatMap((f) => f.http)
    .map((request) => ({ ...request, owners: bindOwners(request.owners, inlineHandlers) }))
    .sort((a, b) => compareLocations(a.site, b.site));
  return {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: out,
    requests,
  };
}

/**
 * Collect one service's {@link SdkFacts} with its program: every call through an SDK client
 * in its root files, with owners naming inline handlers by node key (ADR-0094) and the file
 * node as the fallback for top-level code. Other programs are reached only through the
 * resolver (ADR-0091).
 */
export function collectSdkFacts(
  sp: ServiceProgram,
  resolver: SymbolResolver,
  workspace: Workspace,
): SdkFacts {
  const { symbolAt, constObject } = createValueReader(resolver);
  const normalizer = createUrlNormalizer(resolver);

  const moduleValue = (module: string, name: string): SdkValue | undefined => {
    const pkg = sdkPackage(module);
    return pkg && { pkg, name, confidence: pkg.confidence };
  };

  /** A client of `value` when it names a client export, else nothing. */
  const clientOf = (value: SdkValue | undefined): SdkValue | undefined =>
    value && value.name !== null && isClientExport(value.pkg, value.name)
      ? { ...value, name: null }
      : undefined;

  /**
   * The base a client built from `value` with options `options` (its first argument) sends
   * its requests to, when its export reads one (see {@link SdkBase}).
   */
  const baseOf = (
    sp: ServiceProgram,
    config: ClientBase,
    options: ts.Expression | undefined,
  ): SdkBase => {
    const { paths } = config;
    const fallback: SdkBase = config.env
      ? { kind: "env", name: config.env.name, suffix: config.env.suffix ?? "", paths }
      : { kind: "default", paths };
    if (!options) return fallback;
    const unknown: SdkBase = { kind: "unknown", options: { sp, expression: options }, paths };
    const e = unwrap(options);
    const object = ts.isObjectLiteralExpression(e)
      ? { sp, expression: e }
      : constObject(sp, options, 0);
    if (!object) return unknown;
    for (const option of config.options) {
      const value = objectProperty(object.sp, object.expression, option.name);
      if (value === null) return unknown;
      // An option left `undefined` keeps the SDK's default.
      if (value === undefined || isUndefined(value.expression)) continue;
      return { kind: "value", value, suffix: option.suffix ?? "", paths };
    }
    return fallback;
  };

  /** A client built from `value` (`new X(options)` or `X(options)`), with its base. */
  const constructed = (
    sp: ServiceProgram,
    value: SdkValue | undefined,
    args: readonly ts.Expression[] | undefined,
  ): SdkValue | undefined => {
    const client = clientOf(value);
    const config = value?.name ? value.pkg.bases?.get(value.name) : undefined;
    const base = client && config && baseOf(sp, config, args?.[0]);
    return base ? { ...client, base } : client;
  };

  /** A client known only by its type: built somewhere unseen, so with an unseen base. */
  const typedClient = (value: SdkValue | undefined): SdkValue | undefined => {
    const client = clientOf(value);
    const config = value?.name ? value.pkg.bases?.get(value.name) : undefined;
    return client && config ? { ...client, base: { kind: "unseen", paths: config.paths } } : client;
  };

  /**
   * Two SDK values an expression may be, one per branch (`a ?? b`, `c ? a : b`, a factory's
   * returns, a field's writes; M9.7d): either when the other isn't an SDK's, and the first
   * when they aren't both clients. Clients whose bases differ are `branches`: which one a call
   * uses is only known at runtime. So are clients of two packages (M9.7g), unless neither
   * reads a base and both go to one host (`@octokit/rest` and `octokit`); their method paths
   * differ, so none is listed.
   */
  const merged = (a: SdkValue | undefined, b: SdkValue | undefined): SdkValue | undefined => {
    const value = mergedValues(a, b);
    return value && (a?.unread || b?.unread) ? withUnread(value) : value;
  };

  /**
   * {@link merged} without the unread fact. Bases that agree keep whichever is set, so a
   * `default` one beside a client of an export that reads none (`app.octokit ??
   * new Octokit({ auth })`) stays `default` in either order (M9.7l).
   */
  const mergedValues = (a: SdkValue | undefined, b: SdkValue | undefined): SdkValue | undefined => {
    if (!a || !b) return a ?? b;
    if (a.name !== null || b.name !== null) return a;
    const confidence = weaker(a.confidence, b.confidence);
    const agreed = (): SdkValue => {
      const base = a.base ?? b.base;
      return base ? { ...a, confidence, base } : { ...a, confidence };
    };
    if (a.pkg.module !== b.pkg.module) {
      if (defaultHost(a.base) && defaultHost(b.base) && a.pkg.host === b.pkg.host) {
        return agreed();
      }
      return { ...a, confidence, base: { kind: "branches", paths: false } };
    }
    if (sameBase(a.base, b.base)) return agreed();
    const paths = (a.base?.paths ?? true) && (b.base?.paths ?? true);
    return { ...a, confidence, base: { kind: "branches", paths } };
  };

  /**
   * A client joined with an unread branch, which may hold a client built with any base: one
   * whose export reads a base is then `branches` (an unseen base beside its own, unless that
   * is already unseen); one that reads none keeps its SDK's host, but carries the fact so a
   * later branch that reads a base is `branches` too.
   */
  const withUnread = (value: SdkValue): SdkValue => {
    if (value.name !== null) return value;
    const { base } = value;
    if (!base) return { ...value, unread: true };
    const kind = base.kind === "unseen" ? "unseen" : "branches";
    return { ...value, base: { kind, paths: base.paths }, unread: true };
  };

  /**
   * Two branches merged like {@link merged}, where a branch may be {@link UNREAD}: a value
   * that isn't traced to an SDK but may hold any client (`opts.client` in
   * `opts.client ?? new OpenAI({ baseURL })`, M9.7g). Beside a client whose export reads a
   * base, built with one or not (`opts.client || new OpenAI()`, M9.7j), it's a client built
   * with an unseen base, so the two are `branches`; beside a client that reads no base it
   * changes nothing, since that client's calls go to its SDK's host however it was built,
   * until a branch that reads a base joins (M9.7l: `opts.gh ?? app.octokit ??
   * new Octokit({ auth })` in any order).
   */
  const joined = (a: Branch, b: Branch): Branch => {
    if (a !== UNREAD && b !== UNREAD) return merged(a, b);
    const other = a === UNREAD ? b : a;
    if (other === undefined || other === UNREAD) return UNREAD;
    return withUnread(other);
  };

  /**
   * What one branch is: an SDK value, {@link UNREAD}, or nothing an SDK call can be made on.
   * A member read from the global object (`globalThis.ai ?? new OpenAI(…)`, also through a
   * `const` holding `globalThis as …`) is what its file writes there ({@link globalRead}).
   */
  const branchOf = (sp: ServiceProgram, expression: ts.Expression, hops: number): Branch => {
    const global = globalRead(sp, expression, hops);
    if (global) return global.branch;
    const found = sdkOf(sp, expression, hops);
    if (found) return found;
    return unread(sp, expression) ? UNREAD : undefined;
  };

  /**
   * True when an expression not traced to an SDK may still hold a client: a name, a member, or
   * a call (`opts.client`, `getClient()`). Literals, `null`, `undefined`, objects, functions,
   * and `new` of a class that isn't an SDK's can't. Neither can the value being traced itself
   * (`this.ai = this.ai || new OpenAI(…)`), whose other branches are already counted.
   */
  const unread = (sp: ServiceProgram, expression: ts.Expression): boolean => {
    let e = unwrap(expression);
    while (ts.isAwaitExpression(e)) e = unwrap(e.expression);
    if (ts.isIdentifier(e)) {
      if (e.text === "undefined") return false;
    } else if (
      !ts.isPropertyAccessExpression(e) &&
      !ts.isElementAccessExpression(e) &&
      !ts.isCallExpression(e)
    ) {
      return false;
    }
    const name = ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) ? e.name : undefined;
    const symbol = name && symbolAt(sp, name);
    return !(symbol && sdkBySymbol.get(symbol) === null);
  };

  /**
   * For a member read from the global object (directly, through a `const` holding it, or a
   * `const` holding the read), the branch it is: every value its file stores at that path
   * (`g.ai = …`, `g["ai"] ??= …`), joined, where a value holding the read itself (`g.ai =
   * cached` with `cached = g.ai ?? new OpenAI(…)`) is the module caching the client the other
   * branches build and adds nothing. A path the file never writes may hold a client other
   * code put there, so it's unread (M9.7j), and so is a write of a client injected from
   * outside (`setAI(c) { globalThis.ai = c }`, M9.7l). `undefined` when it's no global read.
   */
  const globalRead = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): { branch: Branch } | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isIdentifier(e)) {
      const declaration = symbolAt(sp, e)?.declarations?.[0];
      return declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
        ? globalRead(sp, declaration.initializer, hops + 1)
        : undefined;
    }
    if (!memberOf(e)) return undefined;
    const path = globalPath(sp, e, 0);
    if (path === undefined) return undefined;
    const writes = globalWrites(sp, e.getSourceFile()).filter((w) => w.path === path);
    if (writes.length === 0) return { branch: UNREAD };
    let branch: Branch;
    for (const { value } of writes) {
      if (!holds(sp, value, e, 0)) branch = joined(branch, branchOf(sp, value, hops + 1));
    }
    return { branch };
  };

  /**
   * True when `expression`, or a variable's initializer it names (at any depth), contains the
   * node `read`.
   */
  const holds = (sp: ServiceProgram, expression: ts.Node, read: ts.Node, hops: number): boolean => {
    if (hops > MAX_HOPS) return false;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (node === read) {
        found = true;
        return;
      }
      if (ts.isIdentifier(node)) {
        const declaration = symbolAt(sp, node)?.declarations?.[0];
        found =
          declaration !== undefined &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          holds(sp, declaration.initializer, read, hops + 1);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
  };

  /**
   * The path of a member of the global object, from it (`globalThis.cache.ai` ⇒ `cache` then
   * `ai`, as one key), directly or through a `const`; `""` for the global object itself. A
   * name is the global object only when it isn't declared in the repo's code (a parameter
   * `self`, or `var self = this`, is a local).
   */
  const globalPath = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): string | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    const member = memberOf(e);
    if (member) {
      const object = globalPath(sp, member.object, hops + 1);
      return object === undefined ? undefined : `${object}/${JSON.stringify(member.name)}`;
    }
    if (!ts.isIdentifier(e)) return undefined;
    const declarations = symbolAt(sp, e)?.declarations ?? [];
    const local = declarations.filter((d) => !d.getSourceFile().isDeclarationFile && !ambient(d));
    if (local.length === 0) return GLOBAL_OBJECTS.has(e.text) ? "" : undefined;
    const declaration = local[0];
    return declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
      ? globalPath(sp, declaration.initializer, hops + 1)
      : undefined;
  };

  /** The values each file stores at a path of the global object (`=`, `??=`, `||=`), by file. */
  const globalWritesByFile = new Map<
    ts.SourceFile,
    readonly { path: string; value: ts.Expression }[]
  >();

  const globalWrites = (
    sp: ServiceProgram,
    file: ts.SourceFile,
  ): readonly { path: string; value: ts.Expression }[] => {
    const known = globalWritesByFile.get(file);
    if (known) return known;
    const writes: { path: string; value: ts.Expression }[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) {
        const left = unwrap(node.left);
        const path = memberOf(left) ? globalPath(sp, left, 0) : undefined;
        if (path !== undefined) writes.push({ path, value: node.right });
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
    globalWritesByFile.set(file, writes);
    return writes;
  };

  /**
   * True when two clients' bases are the same: the default host (an export of one package
   * that reads no base beside one built without it, `App` and `Octokit`), one env var, or
   * values read to one URL.
   */
  const sameBase = (a: SdkBase | undefined, b: SdkBase | undefined): boolean => {
    if (defaultHost(a) || defaultHost(b)) return defaultHost(a) && defaultHost(b);
    if (a.paths !== b.paths) return false;
    switch (a.kind) {
      case "env":
        return b.kind === "env" && a.name === b.name && a.suffix === b.suffix;
      case "value": {
        if (b.kind !== "value" || a.suffix !== b.suffix) return false;
        if (a.value.expression === b.value.expression) return true;
        const x = normalizer.normalize({ url: a.value, baseURL: undefined });
        const y = normalizer.normalize({ url: b.value, baseURL: undefined });
        return x.resolved && y.resolved && x.text === y.text && x.confidence === y.confidence;
      }
      case "unknown":
        return b.kind === "unknown" && a.options.expression === b.options.expression;
      case "unseen":
      case "branches":
        return b.kind === a.kind;
    }
  };

  /**
   * The values written to instance field `declaration` (`this.<name> = …`, `??=` too) in its
   * class's members, joined (M9.7d): they say how its client was built, and a write beside an
   * initializer can replace the client it built (M9.7g). Nested classes and `function`s have
   * their own `this`, so their writes aren't counted.
   */
  const fieldWrites = (
    sp: ServiceProgram,
    declaration: ts.PropertyDeclaration,
    hops: number,
  ): Branch => {
    const name = declaration.name;
    const cls = declaration.parent;
    if (!ts.isIdentifier(name) || !ts.isClassLike(cls) || isStatic(declaration)) return undefined;
    let found: Branch;
    const walk = (node: ts.Node): void => {
      if (ts.isClassLike(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
        return;
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
      ) {
        const left = unwrap(node.left);
        if (
          ts.isPropertyAccessExpression(left) &&
          left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          left.name.text === name.text
        ) {
          found = joined(found, branchOf(sp, node.right, hops + 1));
        }
      }
      ts.forEachChild(node, walk);
    };
    for (const member of cls.members) {
      if (!isStatic(member)) ts.forEachChild(member, walk);
    }
    return found;
  };

  /** The client a type annotation names: `Stripe`, `S3Client`, or `aws.S3Client`. */
  const sdkOfType = (sp: ServiceProgram, type: ts.TypeNode | undefined): SdkValue | undefined => {
    if (!type || !ts.isTypeReferenceNode(type)) return undefined;
    const typeName = type.typeName;
    if (ts.isIdentifier(typeName)) {
      const declaration = symbolAt(sp, typeName)?.declarations?.[0];
      const binding = declaration && importBinding(declaration);
      if (!binding || binding.name === "*") return undefined;
      return typedClient(moduleValue(binding.module, binding.name));
    }
    if (!ts.isIdentifier(typeName.left)) return undefined;
    const declaration = symbolAt(sp, typeName.left)?.declarations?.[0];
    const binding = declaration && importBinding(declaration);
    if (!binding) return undefined;
    return typedClient(moduleValue(binding.module, memberPath(binding.name, typeName.right.text)));
  };

  const sdkOfDeclaration = (
    sp: ServiceProgram,
    declaration: ts.Declaration,
    hops: number,
  ): SdkValue | undefined => {
    const binding = importBinding(declaration);
    if (binding) return moduleValue(binding.module, binding.name);
    // `const { S3Client } = require("@aws-sdk/client-s3")`.
    if (ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      const variable = pattern.parent;
      if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(variable)) {
        return undefined;
      }
      const module = variable.initializer && requiredModule(variable.initializer);
      const key = declaration.propertyName ?? declaration.name;
      if (module === undefined || !ts.isIdentifier(key)) return undefined;
      return moduleValue(module, key.text);
    }
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isParameter(declaration)
    ) {
      // How the value was built says more than its type, which can't name a base (M9.7d);
      // a field's writes count beside its initializer (M9.7g).
      const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
      const built = joined(
        init && branchOf(sp, init, hops + 1),
        ts.isPropertyDeclaration(declaration) ? fieldWrites(sp, declaration, hops) : undefined,
      );
      return settled(built) ?? sdkOfType(sp, declaration.type);
    }
    if (ts.isPropertyAssignment(declaration)) return sdkOf(sp, declaration.initializer, hops + 1);
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = resolver.checkerOf(sp).getShorthandAssignmentValueSymbol(declaration);
      return value && sdkOfSymbol(sp, value, hops + 1);
    }
    if (ts.isExportAssignment(declaration)) return sdkOf(sp, declaration.expression, hops + 1);
    // CommonJS's `module.exports = x` and `exports.x = y`, and a JS field's `this.x = y`,
    // declare on the assignment: `traceSymbol` reads those with `assignedValue`.
    return undefined;
  };

  /**
   * Results by symbol: `null` while a symbol is being traced, so cycles stop (and
   * {@link unread} knows a self-reference), `false` for one traced to no SDK value.
   */
  const sdkBySymbol = new Map<ts.Symbol, SdkValue | null | false>();

  const sdkOfSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): SdkValue | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const known = sdkBySymbol.get(start);
    if (known !== undefined) return known === null || known === false ? undefined : known;
    sdkBySymbol.set(start, null);
    const result = traceSymbol(sp, start, hops);
    sdkBySymbol.set(start, result ?? false);
    return result;
  };

  const traceSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): SdkValue | undefined => {
    let symbol = start;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      // The import itself first: an SDK has no declarations without `node_modules`.
      const own = symbol.declarations?.[0];
      const direct = own && sdkOfDeclaration(sp, own, hops);
      if (direct) return direct;
      const aliased = resolver.checkerOf(sp).getAliasedSymbol(symbol);
      if ((aliased.declarations ?? []).length === 0) {
        const target = own && resolver.importTarget(sp, own);
        return target && viaImport(target, sdkOfSymbol(target.sp, target.symbol, hops + 1));
      }
      symbol = aliased;
    }
    // Every declaration counts, joined (M9.7g): a JS field's `this.ai = …` writes each
    // declare it, and any of them may have built the client a call uses.
    let found: Branch;
    for (const declaration of symbol.declarations ?? []) {
      const right = assignedValue(declaration);
      found = joined(
        found,
        right ? branchOf(sp, right, hops + 1) : sdkOfDeclaration(sp, declaration, hops),
      );
    }
    return settled(found);
  };

  /** A value reached through a workspace-package import, at that import's confidence. */
  const viaImport = (
    target: { confidence: Confidence },
    found: SdkValue | undefined,
  ): SdkValue | undefined =>
    found && { ...found, confidence: weaker(target.confidence, found.confidence) };

  /**
   * Results by factory function, like {@link sdkBySymbol}: without it, factories that each
   * return several calls of the next one are traced exponentially often.
   */
  const sdkByFactory = new Map<FunctionWithBody, SdkValue | null>();

  /** The SDK values a factory function returns, merged, no stronger than `confidence`. */
  const returnedSdk = (
    sp: ServiceProgram,
    fn: FunctionWithBody,
    confidence: Confidence,
    hops: number,
  ): SdkValue | undefined => {
    let known = sdkByFactory.get(fn);
    if (known === undefined) {
      sdkByFactory.set(fn, null);
      let found: Branch;
      for (const returned of returnedExpressions(fn)) {
        found = joined(found, branchOf(sp, returned, hops + 1));
      }
      known = settled(found) ?? null;
      sdkByFactory.set(fn, known);
    }
    return viaImport({ confidence }, known ?? undefined);
  };

  /** What an expression is when it comes from an SDK. */
  const sdkOf = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): SdkValue | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isAwaitExpression(e)) return sdkOf(sp, e.expression, hops + 1);
    const required = requiredModule(e);
    if (required !== undefined) return moduleValue(required, "default");
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        return settled(joined(branchOf(sp, e.left, hops + 1), branchOf(sp, e.right, hops + 1)));
      }
      // `a && b` is `a` only when `a` is falsy, so no client is unread on its left.
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        return merged(sdkOf(sp, e.left, hops + 1), sdkOf(sp, e.right, hops + 1));
      }
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        return sdkOf(sp, e.right, hops + 1);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(e)) {
      return settled(
        joined(branchOf(sp, e.whenTrue, hops + 1), branchOf(sp, e.whenFalse, hops + 1)),
      );
    }
    if (ts.isNewExpression(e))
      return constructed(sp, sdkOf(sp, e.expression, hops + 1), e.arguments);
    if (ts.isCallExpression(e)) {
      const callee = sdkOf(sp, e.expression, hops + 1);
      // A call on an SDK value is a request (or a factory like `twilio(sid, token)`); only
      // client factories yield a value worth following.
      if (callee) return constructed(sp, callee, e.arguments);
      const name = ts.isIdentifier(e.expression)
        ? e.expression
        : ts.isPropertyAccessExpression(e.expression)
          ? e.expression.name
          : undefined;
      const symbol = name && symbolAt(sp, name);
      if (!symbol) return undefined;
      const local = functionOf(resolver.checkerOf(sp), symbol);
      if (local) return returnedSdk(sp, local, "exact", hops);
      // A factory exported from a workspace package TypeScript couldn't resolve.
      const own = symbol.flags & ts.SymbolFlags.Alias ? symbol.declarations?.[0] : undefined;
      const target = own && resolver.importTarget(sp, own);
      const fn = target && functionOf(resolver.checkerOf(target.sp), target.symbol);
      return fn && target ? returnedSdk(target.sp, fn, target.confidence, hops) : undefined;
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const symbol = symbolAt(sp, ts.isIdentifier(e) ? e : e.name);
      const found = symbol && sdkOfSymbol(sp, symbol, hops + 1);
      if (found || !ts.isPropertyAccessExpression(e)) return found;
      const object = unwrap(e.expression);
      // `pay.stripe` where `pay` is a namespace import of a workspace package.
      if (ts.isIdentifier(object)) {
        const declaration = symbolAt(sp, object)?.declarations?.[0];
        if (declaration && ts.isNamespaceImport(declaration)) {
          const target = resolver.importTarget(sp, declaration, e.name.text);
          const member =
            target && viaImport(target, sdkOfSymbol(target.sp, target.symbol, hops + 1));
          if (member) return member;
        }
      }
      // An SDK's own members have no symbols without `node_modules`: `stripe.customers`.
      const base = sdkOf(sp, object, hops + 1);
      if (!base) return undefined;
      // A member of a client (`name` `null`) is still the SDK's, but never a client export.
      return { ...base, name: base.name === null ? null : memberPath(base.name, e.name.text) };
    }
    return undefined;
  };

  /**
   * The SDK value a method call is made on, with the method names after it
   * (`stripe.customers.create` ⇒ `stripe`, [`customers`, `create`]). The shortest SDK prefix
   * of the callee counts, and at least one name must follow it.
   */
  const requestOf = (sp: ServiceProgram, call: ts.CallExpression): SdkCall | undefined => {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const chain: ts.PropertyAccessExpression[] = [];
    let e: ts.Expression = callee;
    while (ts.isPropertyAccessExpression(e)) {
      chain.unshift(e);
      e = unwrap(e.expression);
    }
    // chain[0] is the innermost access; try `base`, then `base.a`, `base.a.b`, … .
    const prefixes = [e, ...chain.slice(0, -1)];
    for (const [i, prefix] of prefixes.entries()) {
      const value = sdkOf(sp, prefix, 0);
      if (!value) continue;
      const names = chain.slice(i).map((p) => p.name.text);
      return { value, names, name: callee.name, receiver: prefix };
    }
    return undefined;
  };

  const dynamic = (detail: DynamicUrlDetail): NormalizedUrl => ({
    resolved: false,
    reason: "DYNAMIC_URL",
    detail,
  });

  /**
   * The URL a request on a client with base `base` goes to: the base read like a `fetch`
   * URL, the SDK's suffix, then the method's `path` joined as axios joins a `baseURL`. With
   * no known path, a literal host outside the machine is still an external call, but any
   * other base isn't matched to a route on the base alone. A client known only by its type,
   * or built with different bases on different branches, has no one base (M9.7d). `shown` is
   * what an unresolved node's label shows for the base: the client's own expression when its
   * base has none.
   */
  const sdkUrl = (
    base: ReadBase,
    path: string | undefined,
    receiver: ts.Expression,
  ): { url: NormalizedUrl; shown: string } => {
    if (base.kind === "unseen" || base.kind === "branches") {
      return {
        url: dynamic(
          base.kind === "unseen"
            ? DYNAMIC_URL_DETAIL.sdkBaseUnseen
            : DYNAMIC_URL_DETAIL.sdkBaseBranches,
        ),
        shown: redactedText(receiver, []),
      };
    }
    if (base.kind === "unknown") {
      return {
        url: dynamic(DYNAMIC_URL_DETAIL.sdkBase),
        shown: redactedText(base.options.expression, []),
      };
    }
    let parts: UrlPart[];
    let shown: string;
    let confidence: Confidence = "exact";
    if (base.kind === "env") {
      parts = [{ kind: "env", name: base.name }];
      shown = base.name;
    } else {
      const node = base.value.expression;
      shown = redactedText(node, [node]);
      const read = normalizer.normalize({ url: base.value, baseURL: undefined });
      if (!read.resolved) {
        const leading = read.detail === DYNAMIC_URL_DETAIL.leadingHole;
        return { url: leading ? dynamic(DYNAMIC_URL_DETAIL.sdkBaseLeadingHole) : read, shown };
      }
      parts = patternParts(read.pattern);
      confidence = read.confidence;
    }
    if (base.suffix !== "") parts = mergeParts([...parts, { kind: "text", text: base.suffix }]);
    const own = toUrlPattern(parts);
    if ("detail" in own) return { url: dynamic(own.detail), shown };
    shown = formatUrlPattern(own.pattern);
    let pattern = own.pattern;
    if (path === undefined) {
      const outside = pattern.base.kind === "host" && !isLoopbackHost(pattern.base.host);
      if (!outside) return { url: dynamic(DYNAMIC_URL_DETAIL.sdkPath), shown };
    } else {
      const joined = toUrlPattern(joinBaseURL(parts, [{ kind: "text", text: path }]));
      if ("detail" in joined) return { url: dynamic(joined.detail), shown };
      pattern = joined.pattern;
    }
    return { url: { resolved: true, pattern, text: formatUrlPattern(pattern), confidence }, shown };
  };

  /** A request on a client built with a base URL, as the HTTP stage reads requests. */
  const httpRequestOf = (
    call: ts.CallExpression,
    request: SdkCall,
    base: ReadBase,
    owners: Owners,
    file: string,
  ): HttpRequestFact => {
    const { value, names } = request;
    const key = (names[0] === "beta" ? names.slice(1) : names).join(".");
    const known = base.paths ? value.pkg.paths?.get(key) : undefined;
    const method = known?.[0] ?? null;
    const { url, shown } = sdkUrl(base, known?.[1], request.receiver);
    const site = locationOf(request.name, file);
    const confidence = weaker(value.confidence, value.pkg.confidence);
    const label = url.resolved
      ? `${method ?? "?"} ${url.text}`
      : `${method ?? "?"} ${shown}${known ? ` ${known[1]}` : ""}`;
    return {
      call: { client: "sdk", file, site },
      file,
      site,
      owners,
      method,
      url,
      confidence: url.resolved ? weaker(confidence, url.confidence) : confidence,
      label: clip(label),
      expression: expressionText(call.expression),
    };
  };

  const requests: SdkRequest[] = [];
  const http: HttpRequestFact[] = [];
  for (const file of sp.rootFiles) {
    const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
    const byNode = sourceFile && resolver.callers.get(sourceFile);
    if (!sourceFile || !byNode) continue;
    const service = serviceForFile(workspace, file);
    const fallback = service ? [fileNodeId(service, file)] : [];

    const visit = (node: ts.Node, owners: Owners): void => {
      const current = ownersAt(file, node, byNode.get(node), owners);
      if (ts.isCallExpression(node)) {
        const request = requestOf(sp, node);
        // `google.calendar({ auth })` builds a client locally; calls on it are requests.
        const builds = request !== undefined && sdkOf(sp, node, 0) !== undefined;
        const skipped =
          request === undefined ||
          builds ||
          request.names.some((n) => request.value.pkg.local.includes(n) || MOCK_METHODS.has(n));
        if (request && !skipped) {
          const { pkg, base } = request.value;
          if (!defaultHost(base)) {
            http.push(httpRequestOf(node, request, base, current, file));
          } else {
            requests.push({
              owners: withFallback(current, fallback),
              host: pkg.host,
              confidence: weaker(request.value.confidence, pkg.confidence),
              site: locationOf(request.name, file),
            });
          }
        }
      }
      ts.forEachChild(node, (child) => {
        visit(child, current);
      });
    };
    visit(sourceFile, NO_OWNERS);
  }
  return { service: sp.service.key, requests, http };
}

/** True for a static class member or a `static { … }` block. */
function isStatic(member: ts.Node): boolean {
  if (ts.isClassStaticBlockDeclaration(member)) return true;
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

/** True for the `undefined` identifier. */
function isUndefined(expression: ts.Expression): boolean {
  const e = unwrap(expression);
  return ts.isIdentifier(e) && e.text === "undefined";
}
