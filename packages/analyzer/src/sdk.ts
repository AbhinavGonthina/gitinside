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
 *   with such a name (`constructor(private stripe: Stripe)`) are clients too. The call that
 *   builds a client is not itself a request.
 * - Values are traced like axios instances (`http.ts`): through variables, imports and
 *   workspace packages (taking the import's confidence), exports, CommonJS exports,
 *   `??`/`||`/`&&`, ternaries, `await`, and factory functions that return a client.
 * - A request is a method call on a module value or a client, at any depth:
 *   `stripe.customers.create()`, `s3.send(cmd)`, `sgMail.send()`. Its site is the method
 *   name. The owner is the innermost symbol, or the routes of an inline Express handler;
 *   top-level calls belong to their file node, like HTTP requests.
 *
 * Patterns not handled:
 * - Methods that run locally are skipped only when listed in `local` (Stripe's `webhooks`,
 *   SendGrid's `setApiKey`, Twilio's request validators, AWS `destroy`). Other local helpers
 *   still draw an edge, which at worst over-reports a dependency the code does have.
 * - Directly called named exports that aren't clients (`import { send } from "x"; send()`),
 *   and methods on results (`(await s3.send(cmd)).Body.transformToString()`): one call
 *   per chain counts, the one on the client.
 * - Clients destructured (`const { customers } = stripe`), stored in collections, or
 *   assigned after creation without a type (`this.stripe = new Stripe()` with an untyped
 *   property).
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
  type SourceLocation,
} from "@gitinside/schema";
import type { SymbolResolver } from "./calls.js";
import { returnedExpressions, type FunctionWithBody } from "./express.js";
import { fileNodeId } from "./files.js";
import { functionOf, importBinding, locationOf, requiredModule } from "./http.js";
import { externalNode } from "./match.js";
import { bindOwners, NO_OWNERS, ownersAt, withFallback, type Owners } from "./owners.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import { CONFIDENCE_RANK, createValueReader, MAX_HOPS, weaker } from "./values.js";
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

/** The allowlist (ROADMAP M2.6), by package name. Hosts are the SDKs' default endpoints. */
export const SDK_PACKAGES: ReadonlyMap<string, SdkEntry> = new Map([
  ["@anthropic-ai/sdk", entry("api.anthropic.com", ["Anthropic"])],
  ["@google/generative-ai", entry("generativelanguage.googleapis.com", ["GoogleGenerativeAI"])],
  ["@hubspot/api-client", entry("api.hubapi.com")],
  ["@octokit/core", entry("api.github.com", ["Octokit"])],
  ["@octokit/rest", entry("api.github.com", ["Octokit"])],
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
  ["octokit", entry("api.github.com", ["Octokit", "App"])],
  ["openai", entry("api.openai.com", ["OpenAI", "AzureOpenAI"])],
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
}

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
}

const compareLocations = (a: SourceLocation, b: SourceLocation): number =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/**
 * Find every call through an allowlisted SDK client (see the file comment) and draw an
 * `external_call` edge from its owners (or its file, for top-level code) to the API's
 * `external` node. Calls with the same source and host merge into one edge listing every
 * site, at the strongest confidence. `inlineHandlers` comes from the Express detector; it is
 * only read to bind each request's owners after the walk (ADR-0094).
 */
export function buildSdkEdges(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  workspace: Workspace,
  inlineHandlers: ReadonlyMap<string, readonly string[]> = new Map(),
): SdkEdges {
  const { symbolAt } = createValueReader(resolver);

  const moduleValue = (module: string, name: string): SdkValue | undefined => {
    const pkg = sdkPackage(module);
    return pkg && { pkg, name, confidence: pkg.confidence };
  };

  /** A client of `value` when it names a client export, else nothing. */
  const clientOf = (value: SdkValue | undefined): SdkValue | undefined =>
    value && value.name !== null && isClientExport(value.pkg, value.name)
      ? { ...value, name: null }
      : undefined;

  /** The client a type annotation names: `Stripe`, `S3Client`, or `aws.S3Client`. */
  const sdkOfType = (sp: ServiceProgram, type: ts.TypeNode | undefined): SdkValue | undefined => {
    if (!type || !ts.isTypeReferenceNode(type)) return undefined;
    const typeName = type.typeName;
    if (ts.isIdentifier(typeName)) {
      const declaration = symbolAt(sp, typeName)?.declarations?.[0];
      const binding = declaration && importBinding(declaration);
      if (!binding || binding.name === "*") return undefined;
      return clientOf(moduleValue(binding.module, binding.name));
    }
    if (!ts.isIdentifier(typeName.left)) return undefined;
    const declaration = symbolAt(sp, typeName.left)?.declarations?.[0];
    const binding = declaration && importBinding(declaration);
    if (!binding) return undefined;
    return clientOf(moduleValue(binding.module, memberPath(binding.name, typeName.right.text)));
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
      const typed = sdkOfType(sp, declaration.type);
      if (typed) return typed;
      const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
      return init && sdkOf(sp, init, hops + 1);
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

  /** The first SDK value a factory function returns, no stronger than `confidence`. */
  const returnedSdk = (
    sp: ServiceProgram,
    fn: FunctionWithBody,
    confidence: Confidence,
    hops: number,
  ): SdkValue | undefined => {
    let known = sdkByFactory.get(fn);
    if (known === undefined) {
      sdkByFactory.set(fn, null);
      known = null;
      for (const returned of returnedExpressions(fn)) {
        const found = sdkOf(sp, returned, hops + 1);
        if (found) {
          known = found;
          break;
        }
      }
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
        return sdkOf(sp, e.left, hops + 1) ?? sdkOf(sp, e.right, hops + 1);
      }
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        return sdkOf(sp, e.right, hops + 1);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(e)) {
      return sdkOf(sp, e.whenTrue, hops + 1) ?? sdkOf(sp, e.whenFalse, hops + 1);
    }
    if (ts.isNewExpression(e)) return clientOf(sdkOf(sp, e.expression, hops + 1));
    if (ts.isCallExpression(e)) {
      const callee = sdkOf(sp, e.expression, hops + 1);
      // A call on an SDK value is a request (or a factory like `twilio(sid, token)`); only
      // client factories yield a value worth following.
      if (callee) return clientOf(callee);
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
  const requestOf = (
    sp: ServiceProgram,
    call: ts.CallExpression,
  ): { value: SdkValue; names: string[]; name: ts.Node } | undefined => {
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
      return { value, names, name: callee.name };
    }
    return undefined;
  };

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

  /** The requests found, in walk order, before their owners are bound (ADR-0094). */
  const requests: {
    owners: Owners;
    external: GraphNode;
    confidence: Confidence;
    site: SourceLocation;
  }[] = [];
  for (const sp of programs) {
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
          if (
            request &&
            !builds &&
            !request.names.some((n) => request.value.pkg.local.includes(n))
          ) {
            const { pkg } = request.value;
            requests.push({
              owners: withFallback(current, fallback),
              external: externalNode(pkg.host),
              confidence: weaker(request.value.confidence, pkg.confidence),
              site: locationOf(request.name, file),
            });
          }
        }
        ts.forEachChild(node, (child) => {
          visit(child, current);
        });
      };
      visit(sourceFile, NO_OWNERS);
    }
  }

  for (const { owners, external, confidence, site } of requests) {
    const sources = bindOwners(owners, inlineHandlers);
    if (sources.length > 0 && !nodes.has(external.id)) nodes.set(external.id, external);
    for (const from of sources) addEdge(from, external.id, confidence, site);
  }

  const out = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of out) edge.sites.sort(compareLocations);
  return { nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)), edges: out };
}
