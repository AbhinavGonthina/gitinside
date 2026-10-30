/**
 * Queue detector (M2.8): jobs added to and processed from BullMQ, Bull, and Bee-Queue queues
 * become `publishes` and `consumes` edges to one `queue` node per queue name,
 * `queue:infra/redis#<name>`, so a producer in one service and a worker in another meet at
 * the same node (ADR-0037).
 *
 * Patterns handled:
 * - Libraries: `bullmq` (`Queue`, `Worker`, `FlowProducer`), `bull` (the default export,
 *   called with or without `new`), and `bee-queue` (the default export). Module values are
 *   read like SDKs (`sdk.ts`): default, named, and namespace imports, `import x = require()`,
 *   `require()`, and destructured `require()`.
 * - Queue names: the first constructor argument, read with `constString` (literals, consts,
 *   imported consts, const object properties, string enums).
 * - Instances are traced like axios instances (`http.ts`): through variables, class
 *   properties, imports and workspace packages (taking the import's confidence), exports,
 *   CommonJS exports, `??`/`||`/`&&`, ternaries, `await`, and factory functions. A factory
 *   whose queue name (or processor) is one of its parameters is bound to each call's
 *   argument, or the parameter's default: `getQueue("email").add(…)` publishes to `email`.
 * - Publishing (`publishes`, from the innermost symbol, the routes of an inline Express
 *   handler, or the file for top-level code; site = the method name):
 *   - BullMQ `queue.add`, `addBulk`, `upsertJobScheduler`.
 *   - BullMQ `flow.add(flow)` / `addBulk([flows])`: every `queueName` in the flow's object
 *     literal, including nested `children`.
 *   - Bull `queue.add`, `addBulk`; Bee-Queue `queue.createJob`.
 * - Consuming (`consumes`, from the processor function's symbol when it resolves to one, an
 *   inline processor's enclosing symbol, else the caller's owners as above):
 *   - BullMQ `new Worker(name, processor)`; site = the `new` expression.
 *   - Bull and Bee-Queue `queue.process(…)`: the processor is the last argument.
 *   - Calls of a factory whose `Worker` takes its name from a parameter
 *     (`startWorker("email", handle)`), with the name and processor bound, through any number
 *     of factories passing the parameter on. The `new Worker` inside such a factory draws no
 *     edge of its own once the factory has a call; an uncalled one stays visible as
 *     unresolved. A factory whose worker has a fixed name is counted once, at its `new`.
 * - A name that can't be read (`new Queue(process.env.QUEUE)`, a queue reached only through a
 *   type like `constructor(private queue: Queue)`) gives an `unresolved` node with reason
 *   `DYNAMIC_NAME` at the name expression (or, for a typed value, the call), and an
 *   `unresolved` edge to it, so no producer or consumer is dropped.
 *
 * Patterns not handled:
 * - NestJS decorators (`@Processor`, `@Process`, `@InjectQueue`; v1 detects no NestJS), and
 *   `QueueEvents`, `QueueScheduler`, `Job` methods, and event listeners (`worker.on`).
 * - Worker factories called under another name (`import { start as boot }`, or passed
 *   around as a value): their worker stays unresolved at the factory.
 * - Queues kept in collections or caches (`queues.get(name)`), destructured, or assigned
 *   after creation without a type; subclasses (`class Mail extends Queue`); wrappers that
 *   publish (`enqueue(name, data)` calling `.add` inside) are not inlined, so their name
 *   parameter is `DYNAMIC_NAME`.
 * - Sandboxed processors given as a file path (`new Worker(name, "./processor.js")`): the
 *   edge starts at the code that creates the worker, not the processor file.
 * - The `prefix` and `connection` options: queues with one name are one node even when
 *   their prefixes or Redis servers differ, and the node isn't linked to a compose Redis.
 * - Other brokers' clients (amqplib, kafkajs, NATS, SQS); compose brokers still appear as
 *   `queue` nodes (M2.7), without edges.
 */
import ts from "typescript";
import {
  SYSTEM_ID,
  compareStrings,
  edgeId,
  nodeId,
  type Confidence,
  type GraphEdge,
  type GraphNode,
  type SourceLocation,
} from "@gitinside/schema";
import { calleeName, type SymbolResolver } from "./calls.js";
import {
  inlineRoutesOf,
  isFunctionWithBody,
  returnedExpressions,
  type FunctionWithBody,
} from "./express.js";
import { fileNodeId, withinService } from "./files.js";
import { functionOf, importBinding, locationOf, requiredModule } from "./http.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import {
  CONFIDENCE_RANK,
  createValueReader,
  MAX_HOPS,
  objectProperty,
  redactedText,
  weaker,
  type ProgramExpression,
} from "./values.js";
import { serviceForFile, type Workspace } from "./workspace.js";

/** What an instance of a queue library is for. */
export type QueueRole = "queue" | "worker" | "flow";

/** A known queue client package. */
export interface QueueLibrary {
  /** Export paths that construct an instance (`default` and `*` for the module itself). */
  constructors: ReadonlyMap<string, QueueRole>;
  /** Export paths that, as a type annotation, make a declaration an instance. */
  types: ReadonlyMap<string, QueueRole>;
  /** Methods that enqueue jobs, per role. */
  publish: Partial<Record<QueueRole, readonly string[]>>;
  /** Methods on a `queue` that register its processor (Bull, Bee-Queue). */
  process: readonly string[];
}

/** The supported libraries, by package name. All three keep their queues in Redis. */
export const QUEUE_LIBRARIES: ReadonlyMap<string, QueueLibrary> = new Map([
  [
    "bullmq",
    {
      constructors: new Map<string, QueueRole>([
        ["Queue", "queue"],
        ["Worker", "worker"],
        ["FlowProducer", "flow"],
      ]),
      types: new Map<string, QueueRole>([
        ["Queue", "queue"],
        ["FlowProducer", "flow"],
      ]),
      publish: { queue: ["add", "addBulk", "upsertJobScheduler"], flow: ["add", "addBulk"] },
      process: [],
    },
  ],
  [
    "bull",
    {
      constructors: new Map<string, QueueRole>([
        ["default", "queue"],
        ["*", "queue"],
      ]),
      types: new Map<string, QueueRole>([
        ["Queue", "queue"],
        ["default.Queue", "queue"],
      ]),
      publish: { queue: ["add", "addBulk"] },
      process: ["process"],
    },
  ],
  [
    "bee-queue",
    {
      constructors: new Map<string, QueueRole>([
        ["default", "queue"],
        ["*", "queue"],
      ]),
      types: new Map<string, QueueRole>([
        ["default", "queue"],
        ["*", "queue"],
      ]),
      publish: { queue: ["createJob"] },
      process: ["process"],
    },
  ],
]);

/** Every method name that publishes or registers a processor, so other calls skip tracing. */
const QUEUE_METHODS: ReadonlySet<string> = new Set(
  [...QUEUE_LIBRARIES.values()].flatMap((lib) => [
    ...Object.values(lib.publish).flat(),
    ...lib.process,
  ]),
);

/** A quoted library name; files without one can't start a queue trace. */
const LIBRARY_MENTION = /["'`](?:bullmq|bull|bee-queue)["'`]/;

/** The engine every supported library's queues run on. */
const ENGINE = "redis";

/** Details shown on `DYNAMIC_NAME` nodes. */
export const DYNAMIC_NAME_DETAIL = {
  computed: "the queue name is computed at runtime",
  typed: "the queue comes from a typed value, so its name is unknown",
  empty: "the queue name is an empty string",
} as const;

/** A queue's name: read, or not readable (with where it was computed, when known). */
type QueueName =
  | { kind: "known"; name: string; at: ProgramExpression }
  | { kind: "dynamic"; at?: ProgramExpression; detail: string };

/** What an expression is when it comes from a queue library. */
type QueueValue =
  | { kind: "module"; lib: QueueLibrary; path: string; confidence: Confidence }
  | QueueInstance;

/** A queue, worker, or flow producer. */
interface QueueInstance {
  kind: "instance";
  lib: QueueLibrary;
  role: QueueRole;
  queue: QueueName;
  /** A worker's processor argument. */
  processor?: ProgramExpression;
  confidence: Confidence;
}

/** The `queue` node for a queue name. */
export function queueNode(name: string, source: SourceLocation): GraphNode {
  return {
    id: nodeId("queue", "infra", `${ENGINE}#${name}`),
    kind: "queue",
    label: name,
    parentId: SYSTEM_ID,
    layer: "infra",
    engine: ENGINE,
    name,
    source,
  };
}

/** The graph output of the queue detector. */
export interface QueueEdges {
  /** `queue` and `unresolved` nodes, sorted by ID. */
  nodes: GraphNode[];
  /** `publishes` and `consumes` edges, sorted by ID. */
  edges: GraphEdge[];
}

/** One producer or consumer found in the code. */
interface QueueEvent {
  kind: "publishes" | "consumes";
  queue: QueueName;
  /** Where the edge starts. */
  sources: readonly string[];
  confidence: Confidence;
  site: SourceLocation;
  /** Source text for an unresolved node with no name expression. */
  text: ts.Node;
  /** The function whose parameter the name still reads, when the event sits inside it. */
  within?: FunctionWithBody;
}

const compareLocations = (a: SourceLocation, b: SourceLocation): number =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/**
 * The names a function is called by: its own name, or the variable, property, or method it
 * is assigned to (`const startWorker = (…) => …`).
 */
function functionNames(fn: FunctionWithBody): string[] {
  const names: string[] = [];
  if (fn.name && ts.isIdentifier(fn.name)) names.push(fn.name.text);
  const parent = fn.parent as ts.Node | undefined;
  if (
    parent &&
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.initializer === fn &&
    ts.isIdentifier(parent.name)
  ) {
    names.push(parent.name.text);
  }
  return names;
}

/** True when `inner` lies inside `outer`'s source span. */
const contains = (outer: ts.Node, inner: ts.Node): boolean =>
  outer.getSourceFile() === inner.getSourceFile() &&
  inner.pos >= outer.pos &&
  inner.end <= outer.end;

/**
 * Find every queue producer and consumer (see the file comment) and draw `publishes` and
 * `consumes` edges to the queue's node. Events with the same kind, source, and queue merge
 * into one edge listing every site, at the strongest confidence. `inlineHandlers` comes from
 * the Express detector.
 */
export function buildQueueEdges(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  workspace: Workspace,
  inlineHandlers: ReadonlyMap<string, readonly string[]> = new Map(),
): QueueEdges {
  const { symbolAt, constString } = createValueReader(resolver);

  const moduleValue = (module: string, path: string): QueueValue | undefined => {
    const lib = QUEUE_LIBRARIES.get(module);
    return lib && { kind: "module", lib, path, confidence: "exact" };
  };

  const memberPath = (base: string, member: string): string =>
    base === "*" ? member : `${base}.${member}`;

  const nameOf = (at: ProgramExpression | undefined): QueueName => {
    const name = at && constString(at.sp, at.expression, 0);
    if (name === "" && at) return { kind: "dynamic", at, detail: DYNAMIC_NAME_DETAIL.empty };
    return name !== undefined && at
      ? { kind: "known", name, at }
      : { kind: "dynamic", ...(at ? { at } : {}), detail: DYNAMIC_NAME_DETAIL.computed };
  };

  /** The instance a constructor call builds, when its callee is a library constructor. */
  const constructed = (
    sp: ServiceProgram,
    call: ts.NewExpression | ts.CallExpression,
    hops: number,
  ): QueueInstance | undefined => {
    const callee = valueOf(sp, call.expression, hops + 1);
    if (callee?.kind !== "module") return undefined;
    const role = callee.lib.constructors.get(callee.path);
    if (role === undefined) return undefined;
    const args = call.arguments ?? [];
    const first = args[0];
    const processor = role === "worker" ? args[1] : undefined;
    return {
      kind: "instance",
      lib: callee.lib,
      role,
      queue: nameOf(first && { sp, expression: first }),
      ...(processor ? { processor: { sp, expression: processor } } : {}),
      confidence: callee.confidence,
    };
  };

  /** An instance a type annotation names: `Queue`, `Bull.Queue`, `BeeQueue`. */
  const typedInstance = (
    sp: ServiceProgram,
    type: ts.TypeNode | undefined,
  ): QueueInstance | undefined => {
    if (!type || !ts.isTypeReferenceNode(type)) return undefined;
    const typeName = type.typeName;
    const head = ts.isIdentifier(typeName) ? typeName : typeName.left;
    if (!ts.isIdentifier(head)) return undefined;
    const declaration = symbolAt(sp, head)?.declarations?.[0];
    const binding = declaration && importBinding(declaration);
    const lib = binding && QUEUE_LIBRARIES.get(binding.module);
    if (!binding || !lib) return undefined;
    const path = ts.isIdentifier(typeName)
      ? binding.name
      : memberPath(binding.name, typeName.right.text);
    const role = lib.types.get(path);
    return role === undefined
      ? undefined
      : {
          kind: "instance",
          lib,
          role,
          queue: { kind: "dynamic", detail: DYNAMIC_NAME_DETAIL.typed },
          confidence: "exact",
        };
  };

  /** `value` with `fn`'s parameters replaced by `call`'s arguments (or their defaults). */
  const bindParameter = (
    fn: FunctionWithBody,
    call: ts.CallExpression,
    callSp: ServiceProgram,
    value: ProgramExpression,
  ): ProgramExpression => {
    const e = unwrap(value.expression);
    if (!ts.isIdentifier(e)) return value;
    const declaration = symbolAt(value.sp, e)?.valueDeclaration;
    if (
      !declaration ||
      !ts.isParameter(declaration) ||
      declaration.parent !== fn ||
      !ts.isIdentifier(declaration.name) ||
      declaration.dotDotDotToken
    ) {
      return value;
    }
    const arg = call.arguments[fn.parameters.indexOf(declaration)];
    if (arg) return { sp: callSp, expression: arg };
    return declaration.initializer ? { sp: value.sp, expression: declaration.initializer } : value;
  };

  const bind = (
    instance: QueueInstance,
    fn: FunctionWithBody,
    call: ts.CallExpression,
    callSp: ServiceProgram,
  ): QueueInstance => {
    const at = instance.queue.kind === "dynamic" ? instance.queue.at : undefined;
    const bound = at && bindParameter(fn, call, callSp, at);
    const processor = instance.processor && bindParameter(fn, call, callSp, instance.processor);
    return {
      ...instance,
      ...(bound && bound !== at ? { queue: nameOf(bound) } : {}),
      ...(processor ? { processor } : {}),
    };
  };

  /** The instance a call to a factory function returns, with the factory. */
  const factoryCall = (
    sp: ServiceProgram,
    call: ts.CallExpression,
    hops: number,
  ): { fn: FunctionWithBody; instance: QueueInstance } | undefined => {
    const name = calleeName(call.expression);
    const symbol = name && symbolAt(sp, name);
    if (!symbol) return undefined;
    let fn = functionOf(resolver.checkerOf(sp), symbol);
    let fnSp = sp;
    let confidence: Confidence = "exact";
    if (!fn) {
      // A factory exported from a workspace package TypeScript couldn't resolve.
      const own = symbol.flags & ts.SymbolFlags.Alias ? symbol.declarations?.[0] : undefined;
      const target = own && resolver.importTarget(sp, own);
      fn = target && functionOf(resolver.checkerOf(target.sp), target.symbol);
      if (!fn || !target) return undefined;
      fnSp = target.sp;
      confidence = target.confidence;
    }
    const found = returnedInstance(fnSp, fn, hops);
    if (!found) return undefined;
    const instance = bind(found, fn, call, sp);
    return { fn, instance: { ...instance, confidence: weaker(confidence, found.confidence) } };
  };

  /** Unbound results by factory; `null` while one is being traced or when it returns none. */
  const byFactory = new Map<FunctionWithBody, QueueInstance | null>();

  /** The first instance a function returns, before its parameters are bound. */
  const returnedInstance = (
    sp: ServiceProgram,
    fn: FunctionWithBody,
    hops: number,
  ): QueueInstance | undefined => {
    const known = byFactory.get(fn);
    if (known !== undefined) return known ?? undefined;
    byFactory.set(fn, null);
    let result: QueueInstance | undefined;
    for (const returned of returnedExpressions(fn)) {
      const found = valueOf(sp, returned, hops + 1);
      if (found?.kind === "instance") {
        result = found;
        break;
      }
    }
    byFactory.set(fn, result ?? null);
    return result;
  };

  const ofDeclaration = (
    sp: ServiceProgram,
    declaration: ts.Declaration,
    hops: number,
  ): QueueValue | undefined => {
    const binding = importBinding(declaration);
    if (binding) return moduleValue(binding.module, binding.name);
    // `const { Queue } = require("bullmq")`.
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
      const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
      return (
        (init && valueOf(sp, init, hops + 1)) ?? typedInstance(sp, declaration.type) ?? undefined
      );
    }
    if (ts.isPropertyAssignment(declaration)) return valueOf(sp, declaration.initializer, hops + 1);
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = resolver.checkerOf(sp).getShorthandAssignmentValueSymbol(declaration);
      return value && ofSymbol(sp, value, hops + 1);
    }
    if (ts.isExportAssignment(declaration)) return valueOf(sp, declaration.expression, hops + 1);
    // CommonJS: `module.exports = x` and `exports.x = y` declare on the assignment.
    if (ts.isBinaryExpression(declaration)) return valueOf(sp, declaration.right, hops + 1);
    const parent = declaration.parent as ts.Node | undefined;
    if (
      ts.isPropertyAccessExpression(declaration) &&
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === declaration
    ) {
      return valueOf(sp, parent.right, hops + 1);
    }
    return undefined;
  };

  /** Results by symbol; `null` while a symbol is being traced, so cycles stop. */
  const bySymbol = new Map<ts.Symbol, QueueValue | null>();

  const ofSymbol = (sp: ServiceProgram, start: ts.Symbol, hops: number): QueueValue | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const known = bySymbol.get(start);
    if (known !== undefined) return known ?? undefined;
    bySymbol.set(start, null);
    const result = traceSymbol(sp, start, hops);
    bySymbol.set(start, result ?? null);
    return result;
  };

  const traceSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): QueueValue | undefined => {
    let symbol = start;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      // The import itself first: a library has no declarations without `node_modules`.
      const own = symbol.declarations?.[0];
      const direct = own && ofDeclaration(sp, own, hops);
      if (direct) return direct;
      const aliased = resolver.checkerOf(sp).getAliasedSymbol(symbol);
      if ((aliased.declarations ?? []).length === 0) {
        const target = own && resolver.importTarget(sp, own);
        const found = target && ofSymbol(target.sp, target.symbol, hops + 1);
        return found && target
          ? { ...found, confidence: weaker(target.confidence, found.confidence) }
          : undefined;
      }
      symbol = aliased;
    }
    for (const declaration of symbol.declarations ?? []) {
      const found = ofDeclaration(sp, declaration, hops);
      if (found) return found;
    }
    return undefined;
  };

  /** What an expression is when it comes from a queue library. */
  const valueOf = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): QueueValue | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isAwaitExpression(e)) return valueOf(sp, e.expression, hops + 1);
    const required = requiredModule(e);
    if (required !== undefined) return moduleValue(required, "default");
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return valueOf(sp, e.left, hops + 1) ?? valueOf(sp, e.right, hops + 1);
      }
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        return valueOf(sp, e.right, hops + 1);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(e)) {
      return valueOf(sp, e.whenTrue, hops + 1) ?? valueOf(sp, e.whenFalse, hops + 1);
    }
    if (ts.isNewExpression(e)) return constructed(sp, e, hops);
    if (ts.isCallExpression(e)) {
      // Bull's default export also works without `new`.
      return constructed(sp, e, hops) ?? factoryCall(sp, e, hops)?.instance;
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const symbol = symbolAt(sp, ts.isIdentifier(e) ? e : e.name);
      const found = symbol && ofSymbol(sp, symbol, hops + 1);
      if (found || !ts.isPropertyAccessExpression(e)) return found;
      const object = unwrap(e.expression);
      // `jobs.mailQueue` where `jobs` is a namespace import of a workspace package.
      if (ts.isIdentifier(object)) {
        const declaration = symbolAt(sp, object)?.declarations?.[0];
        if (declaration && ts.isNamespaceImport(declaration)) {
          const target = resolver.importTarget(sp, declaration, e.name.text);
          const member = target && ofSymbol(target.sp, target.symbol, hops + 1);
          if (member && target) {
            return { ...member, confidence: weaker(target.confidence, member.confidence) };
          }
        }
      }
      // A library's own members have no symbols without `node_modules`: `bullmq.Queue`.
      const base = valueOf(sp, object, hops + 1);
      return base?.kind === "module"
        ? { ...base, path: memberPath(base.path, e.name.text) }
        : undefined;
    }
    return undefined;
  };

  /** The queue names a BullMQ flow (or array of flows) names in `queueName`, with children. */
  const flowNames = (sp: ServiceProgram, expression: ts.Expression, out: QueueName[]): void => {
    const e = unwrap(expression);
    if (ts.isArrayLiteralExpression(e)) {
      for (const element of e.elements) flowNames(sp, element, out);
      return;
    }
    if (!ts.isObjectLiteralExpression(e)) {
      out.push(nameOf({ sp, expression: e }));
      return;
    }
    const queueName = objectProperty(sp, e, "queueName");
    out.push(nameOf(queueName ?? { sp, expression: e }));
    const children = objectProperty(sp, e, "children");
    if (children) flowNames(children.sp, children.expression, out);
  };

  /** The symbol (or owners) a processor expression stands for, and how surely. */
  const processorSources = (
    processor: ProgramExpression | undefined,
    owners: readonly string[],
  ): { sources: readonly string[]; confidence: Confidence } => {
    if (!processor) return { sources: owners, confidence: "exact" };
    const e = unwrap(processor.expression);
    if (isFunctionWithBody(e)) {
      const inner = enclosingOwners(processor.sp, e);
      return { sources: inner ?? owners, confidence: "exact" };
    }
    const target = resolver.resolve(processor.sp, e);
    return target
      ? { sources: [target.id], confidence: target.confidence }
      : { sources: owners, confidence: "exact" };
  };

  /** The owners of the code around a node: the innermost symbol or inline handler's routes. */
  const enclosingOwners = (sp: ServiceProgram, node: ts.Node): readonly string[] | undefined => {
    const byNode = resolver.callers.get(node.getSourceFile());
    const file = sp.toRepoPath(node.getSourceFile().fileName);
    // Inline handlers are found in root files only, as the symbols in `byNode` are.
    const rootFile = byNode ? file : undefined;
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      const routes =
        rootFile === undefined ? undefined : inlineRoutesOf(inlineHandlers, rootFile, n);
      if (routes) return routes;
      const symbol = byNode?.get(n);
      if (symbol !== undefined) return [symbol];
    }
    const service = file === undefined ? undefined : serviceForFile(workspace, file);
    return service && file !== undefined ? [fileNodeId(service, file)] : undefined;
  };

  /** The function whose parameter a dynamic name reads, when `node` sits inside it. */
  const parameterOwner = (queue: QueueName, node: ts.Node): FunctionWithBody | undefined => {
    if (queue.kind !== "dynamic" || !queue.at) return undefined;
    const e = unwrap(queue.at.expression);
    if (!ts.isIdentifier(e)) return undefined;
    const declaration = symbolAt(queue.at.sp, e)?.valueDeclaration;
    const fn = declaration && ts.isParameter(declaration) ? declaration.parent : undefined;
    return fn && isFunctionWithBody(fn) && contains(fn, node) ? fn : undefined;
  };

  const events: QueueEvent[] = [];
  /** Factories with at least one call that yields a worker. */
  const calledFactories = new Set<FunctionWithBody>();
  /** The first site naming each known queue, for its node's `source`. */
  const declared = new Map<string, SourceLocation>();

  const declare = (queue: QueueName): void => {
    if (queue.kind !== "known") return;
    const file = queue.at.sp.toRepoPath(queue.at.expression.getSourceFile().fileName);
    if (file === undefined) return;
    const site = locationOf(queue.at.expression, file);
    const seen = declared.get(queue.name);
    if (!seen || compareLocations(site, seen) < 0) declared.set(queue.name, site);
  };

  const consume = (
    instance: QueueInstance,
    processor: ProgramExpression | undefined,
    owners: readonly string[],
    site: SourceLocation,
    node: ts.Node,
  ): void => {
    const { sources, confidence } = processorSources(processor, owners);
    const within = parameterOwner(instance.queue, node);
    events.push({
      kind: "consumes",
      queue: instance.queue,
      sources,
      confidence: weaker(instance.confidence, confidence),
      site,
      text: node,
      ...(within ? { within } : {}),
    });
  };

  // Every queue starts at a library import, so a repo that names none has no queues.
  const usesLibrary = programs.some((sp) =>
    sp.rootFiles.some((file) =>
      LIBRARY_MENTION.test(sp.program.getSourceFile(sp.toAbsolute(file))?.text ?? ""),
    ),
  );

  /** Visit every call and `new` in the repo with its sources (owners, else the file). */
  const walk = (
    onCall: (
      sp: ServiceProgram,
      file: string,
      node: ts.CallExpression | ts.NewExpression,
      sources: readonly string[],
    ) => void,
  ): void => {
    for (const sp of usesLibrary ? programs : []) {
      for (const file of sp.rootFiles) {
        const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
        const byNode = sourceFile && resolver.callers.get(sourceFile);
        if (!sourceFile || !byNode) continue;
        const service = serviceForFile(workspace, file);
        const visit = (node: ts.Node, owners: readonly string[]): void => {
          const symbol = byNode.get(node);
          const current =
            inlineRoutesOf(inlineHandlers, file, node) ??
            (symbol !== undefined ? [symbol] : owners);
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const sources =
              current.length > 0 ? current : service ? [fileNodeId(service, file)] : [];
            onCall(sp, file, node, sources);
          }
          ts.forEachChild(node, (child) => {
            visit(child, current);
          });
        };
        visit(sourceFile, []);
      }
    }
  };

  // Constructions and calls on instances.
  walk((sp, file, node, sources) => {
    // Bull's default export also works without `new`; other constructors need it.
    const built =
      ts.isNewExpression(node) || ts.isIdentifier(unwrap(node.expression))
        ? constructed(sp, node, 0)
        : undefined;
    if (built) declare(built.queue);
    if (built?.role === "worker") {
      consume(built, built.processor, sources, locationOf(node, file), node);
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const receiver =
        ts.isPropertyAccessExpression(callee) && QUEUE_METHODS.has(callee.name.text)
          ? valueOf(sp, callee.expression, 0)
          : undefined;
      if (receiver?.kind === "instance" && ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const site = locationOf(callee.name, file);
        if (receiver.lib.publish[receiver.role]?.includes(method)) {
          const names: QueueName[] = [];
          if (receiver.role === "flow") {
            for (const arg of node.arguments.slice(0, 1)) flowNames(sp, arg, names);
          } else {
            names.push(receiver.queue);
          }
          for (const queue of names) {
            declare(queue);
            const within = parameterOwner(queue, node);
            events.push({
              kind: "publishes",
              queue,
              sources,
              confidence: receiver.confidence,
              site,
              text: node,
              ...(within ? { within } : {}),
            });
          }
        } else if (receiver.role === "queue" && receiver.lib.process.includes(method)) {
          const last = node.arguments[node.arguments.length - 1];
          consume(receiver, last && { sp, expression: last }, sources, site, node);
        }
      }
    }
  });

  // Calls of worker factories: functions whose own worker takes its name from a parameter.
  // Only calls naming such a function are traced, which keeps this cheap. A caller that
  // passes its own parameter on is a factory too, found in the next round.
  const searched = new Set<FunctionWithBody>();
  for (let round = 0; round < MAX_HOPS; round++) {
    const fresh = new Set(
      events.flatMap((e) =>
        e.kind === "consumes" && e.within && !searched.has(e.within) ? [e.within] : [],
      ),
    );
    if (fresh.size === 0) break;
    for (const fn of fresh) searched.add(fn);
    const names = new Set([...fresh].flatMap((fn) => functionNames(fn)));
    walk((sp, file, node, sources) => {
      if (!ts.isCallExpression(node)) return;
      const name = calleeName(node.expression);
      const text = name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : "";
      if (!names.has(text)) return;
      const factory = factoryCall(sp, node, 0);
      if (!factory || !fresh.has(factory.fn) || factory.instance.role !== "worker") return;
      calledFactories.add(factory.fn);
      const { instance } = factory;
      consume(instance, instance.processor, sources, locationOf(name ?? node, file), node);
    });
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addEdge = (event: QueueEvent, from: string, to: string, confidence: Confidence): void => {
    const id = edgeId(event.kind, from, to);
    const existing = edges.get(id);
    if (!existing) {
      edges.set(id, {
        id,
        kind: event.kind,
        from,
        to,
        confidence,
        ...(confidence === "unresolved" ? { reason: "DYNAMIC_NAME" as const } : {}),
        sites: [event.site],
      });
      return;
    }
    if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = confidence;
    }
    if (!existing.sites.some((s) => compareLocations(s, event.site) === 0)) {
      existing.sites.push(event.site);
    }
  };

  /** The unresolved node of a dynamic name: at its expression, else at the event. */
  const unresolvedNode = (
    queue: Extract<QueueName, { kind: "dynamic" }>,
    event: QueueEvent,
  ): GraphNode | undefined => {
    const anchor = queue.at ? unwrap(queue.at.expression) : event.text;
    const file = queue.at
      ? queue.at.sp.toRepoPath(anchor.getSourceFile().fileName)
      : event.site.file;
    const service = file === undefined ? undefined : serviceForFile(workspace, file);
    if (!service || file === undefined) return undefined;
    const source = queue.at ? locationOf(anchor, file) : event.site;
    // Only a name expression's own strings are shown: a whole call or flow object can hold
    // job data, so its strings are masked (ADR-0038).
    const shown = redactedText(
      anchor,
      queue.at && !ts.isObjectLiteralExpression(anchor) ? [anchor] : [],
    );
    const id = nodeId(
      "unresolved",
      service.key,
      `${withinService(service, file)}:${source.line}:${source.column}`,
    );
    return {
      id,
      kind: "unresolved",
      label: `queue ${shown}`,
      parentId: nodeId("service", service.key, ""),
      reason: "DYNAMIC_NAME",
      expression: shown,
      detail: queue.detail,
      source,
    };
  };

  for (const event of events) {
    // A called factory's own worker is replaced by one per call; its publishes stay.
    if (event.kind === "consumes" && event.within && calledFactories.has(event.within)) continue;
    let to: string;
    let confidence = event.confidence;
    if (event.queue.kind === "known") {
      const source = declared.get(event.queue.name) ?? event.site;
      const node = queueNode(event.queue.name, source);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      to = node.id;
    } else {
      const node = unresolvedNode(event.queue, event);
      if (!node) continue;
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      to = node.id;
      confidence = "unresolved";
    }
    for (const from of event.sources) addEdge(event, from, to, confidence);
  }
  // Queues that are created but never used still exist.
  for (const [name, source] of declared) {
    const node = queueNode(name, source);
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }

  const out = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of out) edge.sites.sort(compareLocations);
  return { nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)), edges: out };
}
