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
 *   were built isn't found (M9.7d): a declaration's initializer, or for an instance field
 *   without one, its `this.<name> = …` writes in the class's members, is read first. The
 *   call that builds a client is not itself a request.
 * - Values are traced like axios instances (`http.ts`): through variables, imports and
 *   workspace packages (taking the import's confidence), exports, CommonJS exports,
 *   `??`/`||`/`&&`, ternaries, `await`, and factory functions that return a client. Each
 *   branch (both sides, every `return`, every field write) is read; clients of one package
 *   whose bases differ are one client whose base is only known at runtime (M9.7d).
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
 * - Clients destructured (`const { customers } = stripe`) or stored in collections. A JS
 *   field assigned in several places (`this.openai = …` in two methods) is read from its
 *   first write only; a TypeScript field's writes are all read. Writes to a static field,
 *   a parameter property's later writes, and a variable declared without an initializer and
 *   assigned later (`let c: OpenAI; c = …`) aren't read: such clients are known by type.
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
}

/**
 * Where a client's requests go when its export reads a base URL (M9.1a3e2a): `value`, the
 * option's expression and the text the SDK appends; `env`, the env var the SDK reads when no
 * option is set; `unknown`, options a spread or an unread value could set it in; `unseen`, a
 * client known only by its type; `branches`, a client built on several branches with bases
 * that differ (M9.7d). A client without one goes to the SDK's default host.
 */
type SdkBase =
  | { kind: "value"; value: ProgramExpression; suffix: string; paths: boolean }
  | { kind: "env"; name: string; suffix: string; paths: boolean }
  | { kind: "unknown"; options: ProgramExpression; paths: boolean }
  | { kind: "unseen"; paths: boolean }
  | { kind: "branches"; paths: boolean };

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
  ): SdkBase | undefined => {
    const { paths } = config;
    const fallback: SdkBase | undefined = config.env && {
      kind: "env",
      name: config.env.name,
      suffix: config.env.suffix ?? "",
      paths,
    };
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
   * when they aren't both clients of one package. Clients whose bases differ are `branches`:
   * which one a call uses is only known at runtime.
   */
  const merged = (a: SdkValue | undefined, b: SdkValue | undefined): SdkValue | undefined => {
    if (!a || !b) return a ?? b;
    if (a.name !== null || b.name !== null || a.pkg.module !== b.pkg.module) return a;
    const confidence = weaker(a.confidence, b.confidence);
    if (sameBase(a.base, b.base)) return { ...a, confidence };
    const paths = (a.base?.paths ?? true) && (b.base?.paths ?? true);
    return { ...a, confidence, base: { kind: "branches", paths } };
  };

  /** True when two clients' bases are the same: one env var, or values read to one URL. */
  const sameBase = (a: SdkBase | undefined, b: SdkBase | undefined): boolean => {
    if (!a || !b) return a === b;
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
   * class's members, merged (M9.7d): a TypeScript field declared without an initializer is
   * set this way, and only its writes say how its client was built. Nested classes and
   * `function`s have their own `this`, so their writes aren't counted.
   */
  const fieldWrites = (
    sp: ServiceProgram,
    declaration: ts.PropertyDeclaration,
    hops: number,
  ): SdkValue | undefined => {
    const name = declaration.name;
    const cls = declaration.parent;
    if (!ts.isIdentifier(name) || !ts.isClassLike(cls) || isStatic(declaration)) return undefined;
    let found: SdkValue | undefined;
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
          found = merged(found, sdkOf(sp, node.right, hops + 1));
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
      // How the value was built says more than its type, which can't name a base (M9.7d).
      const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
      const built = init
        ? sdkOf(sp, init, hops + 1)
        : ts.isPropertyDeclaration(declaration)
          ? fieldWrites(sp, declaration, hops)
          : undefined;
      return built ?? sdkOfType(sp, declaration.type);
    }
    if (ts.isPropertyAssignment(declaration)) return sdkOf(sp, declaration.initializer, hops + 1);
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = resolver.checkerOf(sp).getShorthandAssignmentValueSymbol(declaration);
      return value && sdkOfSymbol(sp, value, hops + 1);
    }
    if (ts.isExportAssignment(declaration)) return sdkOf(sp, declaration.expression, hops + 1);
    // CommonJS: `module.exports = x` and `exports.x = y` declare on the assignment.
    if (ts.isBinaryExpression(declaration)) return sdkOf(sp, declaration.right, hops + 1);
    const parent = declaration.parent as ts.Node | undefined;
    if (
      ts.isPropertyAccessExpression(declaration) &&
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === declaration
    ) {
      return sdkOf(sp, parent.right, hops + 1);
    }
    return undefined;
  };

  /** Results by symbol; `null` while a symbol is being traced, so cycles stop. */
  const sdkBySymbol = new Map<ts.Symbol, SdkValue | null>();

  const sdkOfSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): SdkValue | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const known = sdkBySymbol.get(start);
    if (known !== undefined) return known ?? undefined;
    sdkBySymbol.set(start, null);
    const result = traceSymbol(sp, start, hops);
    sdkBySymbol.set(start, result ?? null);
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
    for (const declaration of symbol.declarations ?? []) {
      const found = sdkOfDeclaration(sp, declaration, hops);
      if (found) return found;
    }
    return undefined;
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
      let found: SdkValue | undefined;
      for (const returned of returnedExpressions(fn)) {
        found = merged(found, sdkOf(sp, returned, hops + 1));
      }
      known = found ?? null;
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
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return merged(sdkOf(sp, e.left, hops + 1), sdkOf(sp, e.right, hops + 1));
      }
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        return sdkOf(sp, e.right, hops + 1);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(e)) {
      return merged(sdkOf(sp, e.whenTrue, hops + 1), sdkOf(sp, e.whenFalse, hops + 1));
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
    base: SdkBase,
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
    base: SdkBase,
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
          if (base) {
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
