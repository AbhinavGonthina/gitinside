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
 *   order (`opts.gh ?? app.octokit ?? new Octokit({ auth })`, M9.7l). `x ??= y` and
 *   `x ||= y` are `x ?? y` and `x || y` (M9.7m). A `let` or `var` is its initializer joined
 *   with every write to it in its file, like a field; a write the matcher doesn't read
 *   (`x &&= y`, a destructuring or `for … of` target) is unread (M9.7n). A member read from
 *   the global object (`globalThis`, `global`, `window`, `self` when the repo's code doesn't
 *   declare that name), or a global `var` read by its bare name (`declare global { var ai }`,
 *   a script's top-level `var`, M9.7n), is what every file of the service writes at that
 *   path, joined (ADR-0268, ADR-0269, ADR-0270), bare-name writes included: a read of the
 *   path inside a stored value (`globalThis.ai ?? new OpenAI(…)` beside `globalThis.ai = ai`,
 *   a module's cache) is a self-reference and adds nothing, the rest of the value counts, an
 *   injected client (`setAI(c) { globalThis.ai = c }`, `Object.assign(globalThis, { ai: c })`)
 *   is unread, and so is a path no file writes, one written in a way the matcher can't read
 *   (`Object.defineProperty`, a computed key, `Object.assign` from a non-literal, a
 *   destructuring target), or one whose parent is replaced by anything but an object literal
 *   without it. Every path below an object the matcher can't follow is unread: the global
 *   object (or a path) passed to a function, held by a `let`, returned, or an operand of `??`
 *   or `?:` (`install(globalThis, c)`, M9.7n). A self-reference (`this.ai = this.ai ||
 *   new OpenAI(…)`, a getter's result written back to what it reads) adds no branch, nor does
 *   `a && b`'s left side; a result traced while something it reads was still being traced
 *   is kept only until that is done (M9.7n), so it doesn't depend on which call is traced
 *   first. Two values that aren't both clients keep the first.
 * - A client is trusted only when every value that can reach it is traced (M9.7o, ADR-0271):
 *   an SDK construction, a factory's returns, a module variable's seen writes, or a
 *   self-reference (a self-cache of the same path or variable). Anything else is unread, and
 *   unread is carried through every join, settle, factory, and object property: a join of
 *   unread values (`opts.ai ?? opts.fallback`, `flag ? opts.a : opts.b`, `(0, opts.ai)`,
 *   `on && opts.ai`, in JS and TS `any`), any form not listed as holding no client, a
 *   destructuring default (`({ ai: x = new OpenAI() } = deps)`, a field's too), any use of a
 *   `const` alias of the global object imported from another file (named, renamed, or a
 *   namespace's member), a binding pattern from the global object (`const { slots } =
 *   globalThis`), and a stored value joining the read with anything else (`g.ai = g.ai ?? c`
 *   is `c`; `g.ai = g.ai ?? new OpenAI()` stays a cache).
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
 *   in a `Map` (`cache.get(k) ?? new OpenAI(…)`) is an unread branch, so such a client's base
 *   is unresolved. Global writes made in another workspace package's program aren't read. The
 *   global object passed to anything (`jest.spyOn(window, "fetch")`), or an alias of it used
 *   in a file that imports it, makes every client read from it in that service unresolved,
 *   though most such uses write nothing (M9.7n, M9.7o). A JS field written only by a
 *   destructuring (`({ ai: this.ai = new OpenAI() } = deps)`) is never declared, so its calls
 *   draw nothing. A parameter's default (`constructor(client = new OpenAI({ baseURL }))`) is read as
 *   its one client, though a caller may pass another. Writes to a static field and a
 *   parameter property's later writes aren't read: such clients are known by type.
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
 * Names of the global object, when the repo's code doesn't declare them: a member read from
 * one is what the service's files write at its path, a write holding the read being a cache
 * (ADR-0268, M9.7m).
 */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["global", "globalThis", "self", "window"]);

/**
 * A write into an object, relative to it: `set`, a value stored at a member (`g.ai = c`,
 * `Object.assign(g, { ai: c })`); `hidden`, a member stored with a value the matcher can't
 * read (`Object.defineProperty(g, "ai", …)`); `any`, some member it can't name (`g[key] = c`,
 * `Object.assign(g, opts)`).
 */
type MemberWrite =
  | { kind: "set"; member: string; value: ts.Expression }
  | { kind: "hidden"; member: string }
  | { kind: "any" };

/** A {@link MemberWrite} to the global object, at a path from it. */
type GlobalWrite =
  | { kind: "set"; path: readonly string[]; value: ts.Expression }
  | { kind: "hidden"; path: readonly string[] }
  | { kind: "any"; path: readonly string[] };

/**
 * A memoized result: `open` while it's being computed, at a depth of the entries being
 * computed; once done, held `until` an entry lower on the stack (by depth and id) is done, and
 * only for reads at least `hops` deep when it was cut off at the hop limit.
 */
type Slot<V> =
  | { open: true; depth: number }
  | { open: false; value: V; until?: { depth: number; id: number }; hops?: number };

/** A global path as one comparable key. */
const pathKey = (path: readonly string[]): string => JSON.stringify(path);

/** True when `prefix` is a strict prefix of `path`. */
const isPrefix = (prefix: readonly string[], path: readonly string[]): boolean =>
  prefix.length < path.length && prefix.every((s, i) => s === path[i]);

/** A literal property key's text (`"ai"`, `` `ai` ``, `1`), else `undefined`. */
function literalKey(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  const key = unwrap(e);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

/**
 * The members a call writes into its first argument: `Object.assign(x, { ai: c }, …)` (each
 * object literal's plain properties; anything else, `any`), `Object.defineProperty(x, "ai",
 * …)` and `Reflect.defineProperty` (`hidden`), `Object.defineProperties` (`any`), and
 * `Reflect.set(x, "ai", c)`. A key that isn't a literal is `any`.
 */
function callWrites(
  call: ts.CallExpression,
): { target: ts.Expression; writes: MemberWrite[] } | undefined {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return undefined;
  }
  const [target, key, value, ...rest] = call.arguments;
  if (!target) return undefined;
  const named = `${callee.expression.text}.${callee.name.text}`;
  const member = literalKey(key);
  switch (named) {
    case "Object.assign":
      return { target, writes: call.arguments.slice(1).flatMap(assignedMembers) };
    case "Object.defineProperty":
    case "Reflect.defineProperty":
      return {
        target,
        writes: [member === undefined ? { kind: "any" } : { kind: "hidden", member }],
      };
    case "Object.defineProperties":
      return { target, writes: [{ kind: "any" }] };
    case "Reflect.set":
      return {
        target,
        writes: [
          member === undefined || !value || rest.length > 0
            ? { kind: "any" }
            : { kind: "set", member, value },
        ],
      };
    default:
      return undefined;
  }
}

/** The members an `Object.assign` source writes: an object literal's, else `any`. */
function assignedMembers(source: ts.Expression): MemberWrite[] {
  const e = unwrap(source);
  if (!ts.isObjectLiteralExpression(e)) return [{ kind: "any" }];
  return e.properties.map((p): MemberWrite => {
    if (ts.isShorthandPropertyAssignment(p))
      return { kind: "set", member: p.name.text, value: p.name };
    const name = p.name;
    const member =
      name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
        ? name.text
        : undefined;
    if (member === undefined) return { kind: "any" };
    return ts.isPropertyAssignment(p)
      ? { kind: "set", member, value: p.initializer }
      : { kind: "hidden", member };
  });
}

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
 * True for a file whose top-level declarations are its own: an ES module, or a JS file
 * TypeScript binds as CommonJS (`require`, `module.exports`). Anything else is a script.
 */
function moduleFile(file: ts.SourceFile): boolean {
  // `commonJsModuleIndicator` is set by TypeScript's binder but isn't in its public types.
  const commonJs = (file as { commonJsModuleIndicator?: unknown }).commonJsModuleIndicator;
  return ts.isExternalModule(file) || commonJs !== undefined;
}

/**
 * True for a `var` that is a member of the global object (M9.7n, M2): one declared in
 * `declare global { … }`, or at the top level of a script (`declare var` in a `.d.ts` too).
 * A `let` or `const` there is global by name but no member of the global object.
 */
function globalVariable(declaration: ts.Declaration): boolean {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const list = declaration.parent;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement)) return false;
  if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) return false;
  const scope = statement.parent;
  if (ts.isModuleBlock(scope)) return (scope.parent.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
  return ts.isSourceFile(scope) && !moduleFile(scope);
}

/** True for a `const` declaration. */
function isConst(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
}

/** The outermost of the parentheses and type assertions around an expression. */
function outermost(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n.parent) ||
    ts.isAsExpression(n.parent) ||
    ts.isSatisfiesExpression(n.parent) ||
    ts.isNonNullExpression(n.parent) ||
    ts.isTypeAssertionExpression(n.parent)
  ) {
    n = n.parent;
  }
  return n;
}

/**
 * True for an identifier that reads a value: not a declaration's or property's name, not part
 * of a type, an import, or a label.
 */
function valueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p)) return p.expression === id;
  if (ts.isBindingElement(p)) return false;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassLike(p) ||
      ts.isEnumMember(p) ||
      ts.isModuleDeclaration(p)) &&
    p.name === id
  ) {
    return false;
  }
  return !(
    ts.isTypeQueryNode(p) ||
    ts.isQualifiedName(p) ||
    ts.isTypeReferenceNode(p) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isLabeledStatement(p) ||
    ts.isBreakOrContinueStatement(p)
  );
}

/**
 * True when `node` is written by a destructuring assignment (`({ ai: g.ai } = deps)`,
 * `[g.ai] = list`, `({ ai } = deps)`) or a `for … of`/`for … in` head.
 */
function assignmentTarget(node: ts.Node): boolean {
  let n = node;
  for (;;) {
    const p = n.parent;
    if (ts.isPropertyAssignment(p) && p.initializer === n) n = p.parent;
    else if (ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p)) n = p.parent;
    else if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) n = p;
    else if (ts.isParenthesizedExpression(p)) n = p;
    else if (ts.isBinaryExpression(p) && p.left === n) {
      return p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    } else {
      return (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n;
    }
  }
}

/**
 * Binary operators whose result may be an operand itself (`a ?? b`, `a, b`) or that store it
 * (`x = a`): an object used there may end up anywhere. Others (comparisons, arithmetic, `in`)
 * yield a primitive.
 */
const VALUE_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

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

  /** Ids of the {@link memo} entries being computed, by depth. */
  const stack: number[] = [];
  let nextId = 0;
  /** The lowest open depth the entry being computed has seen. */
  let lowest = Infinity;
  /** Whether the entry being computed was cut off at {@link MAX_HOPS}. */
  let cut = false;

  /** True, noting the cut for {@link memo}, when a read is past the hop limit. */
  const tooDeep = (hops: number): boolean => {
    if (hops <= MAX_HOPS) return false;
    cut = true;
    return true;
  };

  /** True, noting it for {@link memo}, when `key`'s entry is being computed. */
  const isOpen = <K, V>(map: Map<K, Slot<V>>, key: K): boolean => {
    const slot = map.get(key);
    if (!slot?.open) return false;
    lowest = Math.min(lowest, slot.depth);
    return true;
  };

  /**
   * `key`'s result in `map`, computing it once (M9.7n). While it's being computed, a read of it
   * is `cycle`: a self-reference, whose other branches the open entry counts. So a result that
   * saw an entry lower on the stack open isn't final: it's kept only until that entry is done
   * (M1: a getter traced from inside the variable it reads, then read again from outside), and
   * one cut off at {@link MAX_HOPS} only for reads at least as deep (M6). `undefined` is a
   * result like any other (M5).
   */
  const memo = <K, V>(
    map: Map<K, Slot<V>>,
    key: K,
    hops: number,
    cycle: V,
    compute: () => V,
  ): V => {
    const slot = map.get(key);
    if (slot?.open) {
      lowest = Math.min(lowest, slot.depth);
      return cycle;
    }
    if (
      slot &&
      (slot.until === undefined || stack[slot.until.depth] === slot.until.id) &&
      (slot.hops === undefined || hops >= slot.hops)
    ) {
      if (slot.until) lowest = Math.min(lowest, slot.until.depth);
      if (slot.hops !== undefined) cut = true;
      return slot.value;
    }
    const outer = { lowest, cut };
    const depth = stack.length;
    stack.push(nextId++);
    map.set(key, { open: true, depth });
    lowest = Infinity;
    cut = false;
    const value = compute();
    stack.pop();
    const saw = lowest < depth ? lowest : undefined;
    const id = saw === undefined ? undefined : stack[saw];
    map.set(key, {
      open: false,
      value,
      ...(saw !== undefined && id !== undefined ? { until: { depth: saw, id } } : {}),
      ...(cut ? { hops } : {}),
    });
    lowest = Math.min(outer.lowest, saw ?? Infinity);
    cut = outer.cut || cut;
    return value;
  };

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
    // Of two packages that agree, the one whose module sorts first, so `paths` doesn't depend
    // on branch order (M9.7m, L7).
    const first = compareStrings(a.pkg.module, b.pkg.module) <= 0 ? a : b;
    const agreed = (): SdkValue => {
      const base = a.base ?? b.base;
      return base ? { ...first, confidence, base } : { ...first, confidence };
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
    const found = valueOf(sp, expression, hops);
    if (found !== undefined) return found;
    return unread(sp, expression, hops) ? UNREAD : undefined;
  };

  /**
   * True when an expression not traced to an SDK may still hold a client (M9.7o: anything not
   * positively known to hold none): a name, a member, a call (`opts.client`, `getClient()`),
   * `this`, a computed member, and any form not listed here. Literals, `null`, `undefined`,
   * templates, objects, arrays, functions, classes, unary and binary operators (whose operands
   * {@link valueOf} already joined), and `new` of a class that isn't an SDK's can't. Neither can
   * the value being traced itself (`this.ai = this.ai || new OpenAI(…)`), whose other branches
   * are already counted, nor a call of the factory being traced (M9.7n). A module variable
   * whose every value is seen and none may hold a client (`let client` written only with a
   * getter's result, while that getter is traced) is nothing, not unread (M1).
   */
  const unread = (sp: ServiceProgram, expression: ts.Expression, hops: number): boolean => {
    let e = unwrap(expression);
    while (ts.isAwaitExpression(e)) e = unwrap(e.expression);
    if (holdsNoClient(e)) return false;
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      const symbol = ts.isIdentifier(name) ? symbolAt(sp, name) : undefined;
      const fn = symbol && functionOf(resolver.checkerOf(sp), symbol);
      return !(fn && isOpen(sdkByFactory, fn));
    }
    if (ts.isIdentifier(e)) {
      if (e.text === "undefined") return false;
    } else if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) {
      return true;
    }
    const name = ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) ? e.name : undefined;
    const symbol = name && symbolAt(sp, name);
    if (!symbol) return true;
    if (isOpen(sdkBySymbol, symbol)) return false;
    return (
      !ts.isIdentifier(e) || !seenVariable(symbol) || symbolBranch(sp, symbol, hops) === UNREAD
    );
  };

  /**
   * True for a module's own `let`, `var`, or `const`: every value it holds is its initializer
   * or a write in its file ({@link assignedValues}). Imports, parameters, fields, and global
   * variables can be set where the matcher doesn't look.
   */
  const seenVariable = (symbol: ts.Symbol): boolean => {
    if (symbol.flags & ts.SymbolFlags.Alias) return false;
    const declarations = symbol.declarations ?? [];
    return (
      declarations.length > 0 &&
      declarations.every(
        (d) =>
          ts.isVariableDeclaration(d) &&
          ts.isIdentifier(d.name) &&
          ts.isVariableDeclarationList(d.parent) &&
          // A `for … of` head's variable holds the list's elements.
          ts.isVariableStatement(d.parent.parent) &&
          !d.getSourceFile().isDeclarationFile &&
          !ambient(d) &&
          !globalVariable(d),
      )
    );
  };

  /** Results by service and global path ({@link pathKey}). */
  const globalByPath = new Map<ServiceProgram, Map<string, Slot<Branch>>>();

  /**
   * For a member read from the global object (directly, through a `const` holding it, or a
   * `const` holding the read), the branch it is: every value the service's files store at
   * that path (`g.ai = …`, `g["ai"] ??= …`), joined (M9.7m: a write in any file may be the one
   * a call sees), where a read of the path itself inside a stored value (`g.ai = cached` with
   * `cached = g.ai ?? new OpenAI(…)`) is a self-reference: the module caching the client the
   * other branches build adds nothing, but anything joined beside the read counts (M9.7o, L4:
   * `g.ai = g.ai ?? c` is `c`). A path no file writes may hold a client other code put there, so
   * it's unread (M9.7j), and so is a write of a client injected from outside (`setAI(c) {
   * globalThis.ai = c }`, M9.7l), a write the matcher can't read whole (`Object.assign(
   * globalThis, …)`, `Object.defineProperty`, `Reflect.set`, a computed key), and a parent
   * path written with anything but an object literal that lacks the member (`g.slots = { ai:
   * c }`; `g.slots ??= {}` adds nothing). So is every path below one the matcher can't follow
   * (M9.7n, M3: the global object passed to a function, or held by a `let`; see
   * {@link globalWrites}). A global `var` read or written by its bare name (`declare global {
   * var ai }`, a script's top-level `var`) is its path (M2). A path read while it's being read
   * (a write reaching it through a getter) is a self-reference, like a variable's. `undefined`
   * when it's no global read.
   */
  const globalRead = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): { branch: Branch } | undefined => {
    if (tooDeep(hops)) return undefined;
    const e = unwrap(expression);
    let path: readonly string[] | undefined;
    if (ts.isIdentifier(e)) {
      path = globalVarPath(sp, e);
      if (path === undefined) {
        // A `const` holding a read; a `let`'s later writes are read with its symbol (M4).
        const declaration = symbolAt(sp, e)?.declarations?.[0];
        return declaration !== undefined &&
          ts.isVariableDeclaration(declaration) &&
          isConst(declaration) &&
          declaration.initializer !== undefined
          ? globalRead(sp, declaration.initializer, hops + 1)
          : undefined;
      }
    } else {
      if (!memberOf(e)) return undefined;
      path = globalPath(sp, e, 0);
      if (path === undefined) return undefined;
    }
    let byPath = globalByPath.get(sp);
    if (!byPath) globalByPath.set(sp, (byPath = new Map()));
    const read = path;
    const branch = memo(byPath, pathKey(read), hops, undefined, () => readGlobal(sp, read, hops));
    return { branch };
  };

  /** `[name]` for an identifier naming a {@link globalVariable} declared in the repo's code. */
  const globalVarPath = (sp: ServiceProgram, id: ts.Identifier): readonly string[] | undefined => {
    const declarations = symbolAt(sp, id)?.declarations ?? [];
    const global =
      declarations.length > 0 &&
      declarations.every(
        (d) => globalVariable(d) && !sp.program.isSourceFileDefaultLibrary(d.getSourceFile()),
      );
    return global ? [id.text] : undefined;
  };

  /** {@link globalRead} of a path, once it's known to be one. */
  const readGlobal = (sp: ServiceProgram, path: readonly string[], hops: number): Branch => {
    const key = pathKey(path);
    let seen = false;
    let branch: Branch;
    for (const write of globalWrites(sp)) {
      if (write.path.length === path.length) {
        // An `any` write at the path itself writes its members, not it.
        if (write.kind === "any" || pathKey(write.path) !== key) continue;
        if (write.kind === "hidden") return UNREAD;
        seen = true;
        // A read of the path inside the stored value is this read, still open: a
        // self-reference that adds nothing, so `g.ai = g.ai ?? new OpenAI()` is a cache and
        // `g.ai = g.ai ?? c` is `c` (M9.7o, L4).
        branch = joined(branch, branchOf(sp, write.value, hops + 1));
      } else if (isPrefix(write.path, path)) {
        const member = path[write.path.length] ?? "";
        if (write.kind !== "set" || !lacks(write.value, member)) return UNREAD;
      }
    }
    return seen ? branch : UNREAD;
  };

  /** True when `value` is an object literal with no spread, computed key, or `member`. */
  const lacks = (value: ts.Expression, member: string): boolean => {
    const e = unwrap(value);
    return (
      ts.isObjectLiteralExpression(e) &&
      e.properties.every((p) => {
        const name = p.name;
        return (
          name !== undefined &&
          (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) &&
          name.text !== member
        );
      })
    );
  };

  /**
   * The path of a member of the global object, from it (`globalThis.cache.ai` ⇒ `cache`,
   * `ai`), directly, through a `const`, or through an assignment to one (`(g.s ??= {}).ai`,
   * `const s = (g.s ??= {})`, M9.7m); `[]` for the global object itself, `[name]` for a
   * {@link globalVariable} (M9.7n, M2). A name is the global object only when it isn't
   * declared in the repo's code (a parameter `self`, or `var self = this`, is a local). A `let`
   * or `var` holding it isn't followed: what it holds later is unseen, so its initializer
   * makes the paths below unread ({@link globalWrites}).
   */
  const globalPath = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): readonly string[] | undefined => {
    if (tooDeep(hops)) return undefined;
    const e = unwrap(expression);
    const member = memberOf(e);
    if (member) {
      const object = globalPath(sp, member.object, hops + 1);
      return object === undefined ? undefined : [...object, member.name];
    }
    if (ts.isBinaryExpression(e) && ASSIGNMENTS.has(e.operatorToken.kind)) {
      return memberOf(unwrap(e.left)) ? globalPath(sp, e.left, hops + 1) : undefined;
    }
    if (!ts.isIdentifier(e)) return undefined;
    const variable = globalVarPath(sp, e);
    if (variable) return variable;
    const declarations = symbolAt(sp, e)?.declarations ?? [];
    const local = declarations.filter((d) => !d.getSourceFile().isDeclarationFile && !ambient(d));
    if (local.length === 0) return GLOBAL_OBJECTS.has(e.text) ? [] : undefined;
    const declaration = local[0];
    return declaration &&
      ts.isVariableDeclaration(declaration) &&
      isConst(declaration) &&
      declaration.initializer !== undefined
      ? globalPath(sp, declaration.initializer, hops + 1)
      : undefined;
  };

  /**
   * What a use of an expression at global path `path` may write that the matcher doesn't read
   * as a store (M9.7n, M3): nothing when it's read from (a member, a call of it, `typeof`, a
   * comparison, a condition), stored to (the walk reads that), the target of an
   * `Object.assign`-like call, or held by a `const` (followed by {@link globalPath}). A
   * destructuring or `for … of` target is `hidden` at the path; a member named by a computed
   * key, and any other use (passed to a function, held by a `let`, returned, an operand of
   * `??` or `?:`), may reach code that writes its members, so it's `any` at the path. Widening
   * "unread" this way, rather than following each new form, keeps a write the matcher can't
   * see from drawing the default host.
   */
  const escape = (node: ts.Expression, path: readonly string[]): GlobalWrite | undefined => {
    const n = outermost(node);
    const p = n.parent;
    if (
      (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
      p.expression === n
    ) {
      return memberOf(p) ? undefined : { kind: "any", path };
    }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (p.left === n && ASSIGNMENTS.has(op)) {
        // A store to a member or a global variable is read by the walk; the global object
        // itself, or a `const` holding a path, reassigned isn't.
        const e = unwrap(node);
        const stored = memberOf(e) !== undefined || (ts.isIdentifier(e) && path.length > 0);
        return stored ? undefined : { kind: "any", path };
      }
      // `g.ai &&= c` stores `c` where the matcher doesn't look.
      if (p.left === n && op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        return { kind: path.length > 0 ? "hidden" : "any", path };
      }
      // Comparisons, arithmetic, `in`, and a compound target (`g.n += 1`) yield no object;
      // a comma's left side is dropped.
      if (!VALUE_OPERATORS.has(op) || (op === ts.SyntaxKind.CommaToken && p.left === n)) {
        return undefined;
      }
    }
    if (
      ts.isTypeOfExpression(p) ||
      ts.isVoidExpression(p) ||
      ts.isDeleteExpression(p) ||
      ts.isPrefixUnaryExpression(p) ||
      ts.isPostfixUnaryExpression(p) ||
      ts.isExpressionStatement(p) ||
      ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) &&
        p.expression === n) ||
      (ts.isConditionalExpression(p) && p.condition === n) ||
      (ts.isCallExpression(p) && p.expression === n)
    ) {
      return undefined;
    }
    // A binding pattern (`const { slots } = globalThis`) holds members the walk doesn't follow
    // (M9.7o, N4).
    if (ts.isVariableDeclaration(p) && p.initializer === n && isConst(p) && ts.isIdentifier(p.name))
      return undefined;
    if (ts.isCallExpression(p) && p.arguments[0] === n && callWrites(p)) return undefined;
    return { kind: assignmentTarget(n) && path.length > 0 ? "hidden" : "any", path };
  };

  /** Every global write in each service's files ({@link GlobalWrite}), in file then walk order. */
  const globalWritesBySp = new Map<ServiceProgram, readonly GlobalWrite[]>();

  const globalWrites = (sp: ServiceProgram): readonly GlobalWrite[] => {
    const known = globalWritesBySp.get(sp);
    if (known) return known;
    const files: ts.SourceFile[] = [];
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      if (sourceFile) files.push(sourceFile);
    }
    // Names that may be the global object, a global variable, or a `const` holding a path:
    // only uses rooted at one are looked up.
    const names = new Set(GLOBAL_OBJECTS);
    // Names bound by an import or `require` (and namespaces): a use of one may be an alias of
    // the global object declared in another file (M9.7o, N3).
    const imports = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const alias =
          isConst(node) &&
          node.initializer !== undefined &&
          globalPath(sp, node.initializer, 0) !== undefined;
        if (alias || globalVariable(node)) names.add(node.name.text);
      }
      if (
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node) ||
        (ts.isImportClause(node) && node.name)
      ) {
        if (node.name) imports.add(node.name.text);
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        if (requiredModule(unwrap(node.initializer)) !== undefined) {
          const bound = ts.isIdentifier(node.name)
            ? [node.name]
            : node.name.elements.flatMap((b) =>
                ts.isBindingElement(b) && ts.isIdentifier(b.name) ? [b.name] : [],
              );
          for (const id of bound) imports.add(id.text);
        }
      }
      ts.forEachChild(node, collect);
    };
    for (const file of files) collect(file);
    const rooted = (expression: ts.Expression): boolean => {
      let e = unwrap(expression);
      for (;;) {
        if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
          e = unwrap(e.expression);
        } else if (ts.isBinaryExpression(e) && ASSIGNMENTS.has(e.operatorToken.kind)) {
          e = unwrap(e.left);
        } else {
          return ts.isIdentifier(e) && names.has(e.text);
        }
      }
    };
    /** The global path a name is, when it's a `const` alias declared in another file. */
    const importedAlias = (id: ts.Identifier): readonly string[] | undefined => {
      let symbol = symbolAt(sp, id);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = resolver.checkerOf(sp).getAliasedSymbol(symbol);
      }
      const declaration = symbol?.declarations?.[0];
      return declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        isConst(declaration) &&
        declaration.initializer !== undefined &&
        declaration.getSourceFile() !== id.getSourceFile()
        ? globalPath(sp, declaration.initializer, 0)
        : undefined;
    };
    const writes: GlobalWrite[] = [];
    const walk = (node: ts.Node): void => {
      const use = ts.isIdentifier(node)
        ? names.has(node.text) && valueReference(node)
        : (ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node) ||
            (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind))) &&
          rooted(node);
      const path = use && ts.isExpression(node) ? globalPath(sp, node, 0) : undefined;
      const escaped = path && ts.isExpression(node) ? escape(node, path) : undefined;
      if (escaped) writes.push(escaped);
      // Any use of an imported alias of the global object (`import { G }`, `globals.G`) may
      // write below it in ways the walk doesn't follow (M9.7o, N3).
      const imported =
        ts.isIdentifier(node) && imports.has(node.text) && valueReference(node)
          ? importedAlias(node)
          : ts.isPropertyAccessExpression(node) &&
              ts.isIdentifier(node.expression) &&
              ts.isIdentifier(node.name) &&
              imports.has(node.expression.text)
            ? importedAlias(node.name)
            : undefined;
      if (imported) writes.push({ kind: "any", path: imported });
      if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) {
        const left = unwrap(node.left);
        const stored = memberOf(left)
          ? globalPath(sp, left, 0)
          : ts.isIdentifier(left) && names.has(left.text)
            ? globalVarPath(sp, left)
            : undefined;
        if (stored !== undefined) writes.push({ kind: "set", path: stored, value: node.right });
      }
      const call = ts.isCallExpression(node) ? callWrites(node) : undefined;
      const object = call && globalPath(sp, call.target, 0);
      if (call && object) {
        for (const write of call.writes) {
          writes.push(
            write.kind === "any"
              ? { kind: "any", path: object }
              : write.kind === "hidden"
                ? { kind: "hidden", path: [...object, write.member] }
                : { kind: "set", path: [...object, write.member], value: write.value },
          );
        }
      }
      ts.forEachChild(node, walk);
    };
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      if (sourceFile) walk(sourceFile);
    }
    globalWritesBySp.set(sp, writes);
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
    return thisWrites(sp, cls, name.text, hops);
  };

  /**
   * The values a class's instance members write to `this.<name>`, joined ({@link fieldWrites};
   * a JS field, declared by those writes, reads them here too so a destructuring target is
   * seen, M9.7o).
   */
  const thisWrites = (
    sp: ServiceProgram,
    cls: ts.ClassLikeDeclaration,
    name: string,
    hops: number,
  ): Branch => {
    let found: Branch;
    const walk = (node: ts.Node): void => {
      if (ts.isClassLike(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
        return;
      if (
        ts.isPropertyAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.name.text === name
      ) {
        // A store the matcher reads (`=`, `??=`, `||=`) adds its value; any other (`&&=`, a
        // destructuring target or default, a `for … of` head) may store any client (M9.7o, N2).
        const n = outermost(node);
        const p = n.parent;
        if (ts.isBinaryExpression(p) && p.left === n) {
          const op = p.operatorToken.kind;
          if (ASSIGNMENTS.has(op) && !assignmentTarget(p)) {
            found = joined(found, branchOf(sp, p.right, hops + 1));
          } else if (ASSIGNMENTS.has(op) || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
            found = joined(found, UNREAD);
          }
        } else if (assignmentTarget(n)) {
          found = joined(found, UNREAD);
        }
      }
      ts.forEachChild(node, walk);
    };
    for (const member of cls.members) {
      if (!isStatic(member)) ts.forEachChild(member, walk);
    }
    return found;
  };

  /**
   * Each file's writes to a plain name, in walk order: the value stored (`x = …`, `x ??= …`,
   * `x ||= …`), or `undefined` for a store the matcher doesn't read (`x &&= …`, a
   * destructuring or `for … of` target; M9.7n).
   */
  const assignmentsByFile = new Map<
    ts.SourceFile,
    readonly { name: ts.Identifier; value: ts.Expression | undefined }[]
  >();

  /**
   * The values written to a `let` or `var` in its file ({@link assignmentsByFile}), or
   * `undefined` for a `const`, which has none; an imported binding can't be assigned.
   */
  const assignedValues = (
    sp: ServiceProgram,
    declaration: ts.VariableDeclaration,
  ): (ts.Expression | undefined)[] | undefined => {
    if (!ts.isIdentifier(declaration.name) || isConst(declaration)) return undefined;
    if (!ts.isVariableDeclarationList(declaration.parent)) return undefined;
    const symbol = symbolAt(sp, declaration.name);
    if (!symbol) return undefined;
    const file = declaration.getSourceFile();
    let assignments = assignmentsByFile.get(file);
    if (!assignments) {
      const found: { name: ts.Identifier; value: ts.Expression | undefined }[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node)) {
          const left = unwrap(node.left);
          const op = node.operatorToken.kind;
          // A destructuring default (`({ ai: x = new OpenAI() } = deps)`) stores the source's
          // value when it has one (M9.7o, N2).
          if (ts.isIdentifier(left) && ASSIGNMENTS.has(op)) {
            found.push({ name: left, value: assignmentTarget(node) ? undefined : node.right });
          }
          if (ts.isIdentifier(left) && op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
            found.push({ name: left, value: undefined });
          }
        } else if (ts.isIdentifier(node)) {
          const n = outermost(node);
          const direct = ts.isBinaryExpression(n.parent) && n.parent.left === n;
          if (!direct && assignmentTarget(n)) found.push({ name: node, value: undefined });
        }
        ts.forEachChild(node, walk);
      };
      walk(file);
      assignmentsByFile.set(file, (assignments = found));
    }
    return assignments.filter((a) => symbolAt(sp, a.name) === symbol).map((a) => a.value);
  };

  /**
   * The values written to a `let` or `var` (`client = c`, `client ??= new OpenAI()`) in its
   * file, joined (M9.7m): like a field's, they say how its client was built. A write holding
   * the variable itself (`c = c || new OpenAI()`) adds nothing, since the variable is being
   * traced; one the matcher doesn't read may hold any client (M9.7n).
   */
  const variableWrites = (
    sp: ServiceProgram,
    declaration: ts.VariableDeclaration,
    hops: number,
  ): Branch => {
    let written: Branch;
    for (const value of assignedValues(sp, declaration) ?? []) {
      written = joined(written, value ? branchOf(sp, value, hops + 1) : UNREAD);
    }
    return written;
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
  ): Branch => {
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
      // a field's writes count beside its initializer (M9.7g), and so do a variable's (M9.7m).
      const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
      const built = joined(
        init && branchOf(sp, init, hops + 1),
        ts.isPropertyDeclaration(declaration)
          ? fieldWrites(sp, declaration, hops)
          : ts.isVariableDeclaration(declaration)
            ? variableWrites(sp, declaration, hops)
            : undefined,
      );
      // An unread value stays unread, so a variable that may hold any client says so (M9.7n).
      return settled(built) ?? sdkOfType(sp, declaration.type) ?? built;
    }
    if (ts.isPropertyAssignment(declaration)) {
      return branchOf(sp, declaration.initializer, hops + 1);
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = resolver.checkerOf(sp).getShorthandAssignmentValueSymbol(declaration);
      return value ? nameBranch(sp, value, hops + 1) : UNREAD;
    }
    if (ts.isExportAssignment(declaration)) return branchOf(sp, declaration.expression, hops + 1);
    // CommonJS's `module.exports = x` and `exports.x = y`, and a JS field's `this.x = y`,
    // declare on the assignment: `traceSymbol` reads those with `assignedValue`.
    return undefined;
  };

  /**
   * Results by symbol ({@link memo}), as branches: open while a symbol is being traced, so
   * cycles stop and {@link unread} knows a self-reference.
   */
  const sdkBySymbol = new Map<ts.Symbol, Slot<Branch>>();

  /**
   * What a name may hold: its symbol's branch, or {@link UNREAD} when that's nothing but the
   * name may be set where the matcher doesn't look (a parameter, an import it can't follow;
   * not a {@link seenVariable}, nor one being traced).
   */
  const nameBranch = (sp: ServiceProgram, symbol: ts.Symbol, hops: number): Branch => {
    const found = symbolBranch(sp, symbol, hops);
    if (found !== undefined || isOpen(sdkBySymbol, symbol) || seenVariable(symbol)) return found;
    return UNREAD;
  };

  /** What a symbol may hold, {@link UNREAD} past the hop limit. */
  const symbolBranch = (sp: ServiceProgram, start: ts.Symbol, hops: number): Branch => {
    if (tooDeep(hops)) return UNREAD;
    return memo(sdkBySymbol, start, hops, undefined, () => traceSymbol(sp, start, hops));
  };

  const traceSymbol = (sp: ServiceProgram, start: ts.Symbol, hops: number): Branch => {
    let symbol = start;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      // The import itself first: an SDK has no declarations without `node_modules`.
      const own = symbol.declarations?.[0];
      const direct = own && settled(sdkOfDeclaration(sp, own, hops));
      if (direct) return direct;
      const aliased = resolver.checkerOf(sp).getAliasedSymbol(symbol);
      if ((aliased.declarations ?? []).length === 0) {
        const target = own && resolver.importTarget(sp, own);
        return target && viaImport(target, symbolBranch(target.sp, target.symbol, hops + 1));
      }
      symbol = aliased;
    }
    // Every declaration counts, joined (M9.7g): a JS field's `this.ai = …` writes each
    // declare it, and any of them may have built the client a call uses; its class's other
    // stores to it (a destructuring target) are read with them (M9.7o, N2).
    let found: Branch;
    const classes = new Set<ts.ClassLikeDeclaration>();
    for (const declaration of symbol.declarations ?? []) {
      const right = assignedValue(declaration);
      const field = right && thisField(declaration);
      if (field) {
        if (!classes.has(field.cls)) {
          classes.add(field.cls);
          found = joined(found, thisWrites(sp, field.cls, field.name, hops));
        }
        continue;
      }
      found = joined(
        found,
        right ? branchOf(sp, right, hops + 1) : sdkOfDeclaration(sp, declaration, hops),
      );
    }
    return found;
  };

  /** A value reached through a workspace-package import, at that import's confidence. */
  const viaImport = (target: { confidence: Confidence }, found: Branch): Branch =>
    found && found !== UNREAD
      ? { ...found, confidence: weaker(target.confidence, found.confidence) }
      : found;

  /**
   * Results by factory function, like {@link sdkBySymbol}: without it, factories that each
   * return several calls of the next one are traced exponentially often.
   */
  const sdkByFactory = new Map<FunctionWithBody, Slot<Branch>>();

  /**
   * What a factory function returns, every `return` joined (an unread one stays unread,
   * M9.7o), no stronger than `confidence`.
   */
  const returnedSdk = (
    sp: ServiceProgram,
    fn: FunctionWithBody,
    confidence: Confidence,
    hops: number,
  ): Branch => {
    const known = memo(sdkByFactory, fn, hops, undefined, () => {
      let found: Branch;
      for (const returned of returnedExpressions(fn)) {
        found = joined(found, branchOf(sp, returned, hops + 1));
      }
      return found;
    });
    return viaImport({ confidence }, known);
  };

  /** What an expression is when it comes from an SDK: {@link valueOf}, settled. */
  const sdkOf = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): SdkValue | undefined => settled(valueOf(sp, expression, hops));

  /**
   * What an expression is as a {@link Branch}, before {@link branchOf}'s unread fallback: an
   * unread operand stays unread through every join (M9.7o, N1: `opts.ai ?? opts.fallback`,
   * `flag ? opts.a : opts.b`, a factory returning one), so a later default-built client
   * beside it is never the only option.
   */
  const valueOf = (sp: ServiceProgram, expression: ts.Expression, hops: number): Branch => {
    if (tooDeep(hops)) return UNREAD;
    const e = unwrap(expression);
    if (ts.isAwaitExpression(e)) return branchOf(sp, e.expression, hops + 1);
    const required = requiredModule(e);
    if (required !== undefined) return moduleValue(required, "default");
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      // `x ??= y` is `x ?? (x = y)`: the left side's value as it was, or the right (M9.7m).
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        op === ts.SyntaxKind.BarBarEqualsToken
      ) {
        return joined(branchOf(sp, e.left, hops + 1), branchOf(sp, e.right, hops + 1));
      }
      // `a && b` (and `a &&= b`) is `a` only when `a` is falsy, so no client is unread on its
      // left; `a, b` and `a = b` are `b`.
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      ) {
        return joined(sdkOf(sp, e.left, hops + 1), branchOf(sp, e.right, hops + 1));
      }
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.CommaToken) {
        return branchOf(sp, e.right, hops + 1);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(e)) {
      return joined(branchOf(sp, e.whenTrue, hops + 1), branchOf(sp, e.whenFalse, hops + 1));
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
      // A global member's writes say more than its type (`g.ai.models.list()`, M9.7m), and so
      // do a global variable's (`ai.models.list()`, M9.7n).
      const global =
        ts.isPropertyAccessExpression(e) || globalVarPath(sp, e)
          ? globalRead(sp, e, hops)
          : undefined;
      const written = global && settled(global.branch);
      if (written) return written;
      const symbol = symbolAt(sp, ts.isIdentifier(e) ? e : e.name);
      const found = symbol && symbolBranch(sp, symbol, hops + 1);
      if (settled(found) || !ts.isPropertyAccessExpression(e)) return found;
      const object = unwrap(e.expression);
      // `pay.stripe` where `pay` is a namespace import of a workspace package.
      if (ts.isIdentifier(object)) {
        const declaration = symbolAt(sp, object)?.declarations?.[0];
        if (declaration && ts.isNamespaceImport(declaration)) {
          const target = resolver.importTarget(sp, declaration, e.name.text);
          const member =
            target && viaImport(target, symbolBranch(target.sp, target.symbol, hops + 1));
          if (member !== undefined) return member;
        }
      }
      // An SDK's own members have no symbols without `node_modules`: `stripe.customers`.
      const base = sdkOf(sp, object, hops + 1);
      if (!base) return found;
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

/**
 * For a JS assignment declaration `this.<name> = …` in a class's instance member (arrows
 * included, not a nested `function`), that class and name.
 */
function thisField(
  declaration: ts.Declaration,
): { cls: ts.ClassLikeDeclaration; name: string } | undefined {
  const access = ts.isBinaryExpression(declaration) ? declaration.left : declaration;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return undefined;
  }
  for (let n: ts.Node = access; n.parent; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) return undefined;
    if (ts.isClassLike(n.parent)) {
      return isStatic(n) ? undefined : { cls: n.parent, name: access.name.text };
    }
  }
  return undefined;
}

/** True for a static class member or a `static { … }` block. */
function isStatic(member: ts.Node): boolean {
  if (ts.isClassStaticBlockDeclaration(member)) return true;
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

/**
 * True for an expression that can't hold a client (M9.7o): a literal, a template, an object,
 * array, function, or class expression, `new` (of a class {@link collectSdkFacts} didn't trace
 * to an SDK), a unary operator, or a binary or conditional one, whose value-carrying operands
 * are judged on their own.
 */
function holdsNoClient(e: ts.Expression): boolean {
  switch (e.kind) {
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
      return true;
    default:
      return (
        ts.isLiteralExpression(e) ||
        ts.isNoSubstitutionTemplateLiteral(e) ||
        ts.isTemplateExpression(e) ||
        ts.isObjectLiteralExpression(e) ||
        ts.isArrayLiteralExpression(e) ||
        ts.isFunctionExpression(e) ||
        ts.isArrowFunction(e) ||
        ts.isClassExpression(e) ||
        ts.isNewExpression(e) ||
        ts.isTypeOfExpression(e) ||
        ts.isVoidExpression(e) ||
        ts.isDeleteExpression(e) ||
        ts.isPrefixUnaryExpression(e) ||
        ts.isPostfixUnaryExpression(e) ||
        ts.isBinaryExpression(e) ||
        ts.isConditionalExpression(e)
      );
  }
}

/** True for the `undefined` identifier. */
function isUndefined(expression: ts.Expression): boolean {
  const e = unwrap(expression);
  return ts.isIdentifier(e) && e.text === "undefined";
}
