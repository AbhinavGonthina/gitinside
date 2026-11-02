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
import { calleeName, nodeKey, type SymbolResolver } from "./calls.js";
import { isFunctionWithBody, returnedExpressions, type FunctionWithBody } from "./express.js";
import { fileNodeId, withinService } from "./files.js";
import { functionOf, importBinding, locationOf, requiredModule } from "./http.js";
import {
  bindOwners,
  handlerKey,
  NO_OWNERS,
  ownersAt,
  withFallback,
  type Owners,
} from "./owners.js";
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

/**
 * A worker factory: a function whose own worker reads its queue name from one of its
 * parameters. `key` identifies the function node within one program (the program's service
 * key, then `nodeKey`), as node identity did before facts (ADR-0172).
 */
export interface FactoryRef {
  key: string;
  /** The names it is called by (see {@link functionNames}). */
  names: string[];
}

/** One producer or consumer found in the code, as plain data (ADR-0172). */
export interface QueueEventFact {
  kind: "publishes" | "consumes";
  /**
   * The queue's name, or, when it can't be read, the `unresolved` node standing for it (none
   * when that node's file is in no service, so the event draws nothing).
   */
  queue: { kind: "known"; name: string } | { kind: "dynamic"; node?: GraphNode };
  /** Where the edge starts, bound to IDs once Express is composed (ADR-0094). */
  sources: Owners;
  confidence: Confidence;
  site: SourceLocation;
  /** For a consumer: the worker factory whose parameter its name still reads, if inside one. */
  within?: FactoryRef;
}

/**
 * A call that would consume through a worker factory, if that factory turns out to be one
 * (some consumer is `within` it): the global step decides, in rounds (ADR-0172).
 */
export interface FactoryCallFact {
  /** The called function's {@link FactoryRef.key}. */
  factory: string;
  /** The callee's name as written; it must be a name of a factory searched in that round. */
  name: string;
  /** The consumer it makes, with the factory's parameters bound to the call's arguments. */
  event: QueueEventFact;
}

/** What one service's program says about queues, as plain data (ADR-0090, ADR-0172). */
export interface QueueFacts {
  /** Key of the service whose program found these. */
  service: string;
  /**
   * False when no file in the repo names a queue library, so nothing was looked for. Facts
   * collected that way are stale once one does.
   */
  scanned: boolean;
  /** The first site naming each known queue, in the order first named. */
  declared: { name: string; site: SourceLocation }[];
  /** Producers and consumers found directly, in walk order. */
  events: QueueEventFact[];
  /** Calls of functions that return a worker, in walk order. */
  factoryCalls: FactoryCallFact[];
}

/** One producer or consumer while walking, with the TypeScript nodes it still needs. */
interface QueueEvent {
  kind: "publishes" | "consumes";
  queue: QueueName;
  sources: Owners;
  confidence: Confidence;
  site: SourceLocation;
  /** Source text for an unresolved node with no name expression. */
  text: ts.Node;
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
 * True when some root file of some program names a queue library in quotes. Every queue
 * starts at a library import, so a repo that names none has no queues and isn't walked.
 */
export function usesQueueLibrary(programs: readonly ServiceProgram[]): boolean {
  return programs.some((sp) =>
    sp.rootFiles.some((file) =>
      LIBRARY_MENTION.test(sp.program.getSourceFile(sp.toAbsolute(file))?.text ?? ""),
    ),
  );
}

/**
 * Find every queue producer and consumer (see the file comment) and draw `publishes` and
 * `consumes` edges to the queue's node: {@link collectQueueFacts} per program, then
 * {@link composeQueueEdges}.
 */
export function buildQueueEdges(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  workspace: Workspace,
  inlineHandlers: ReadonlyMap<string, readonly string[]> = new Map(),
): QueueEdges {
  const scanned = usesQueueLibrary(programs);
  return composeQueueEdges(
    programs.map((sp) => collectQueueFacts(sp, resolver, workspace, scanned)),
    inlineHandlers,
  );
}

/**
 * The global queue step. Worker factories are found in rounds, as the one-pass detector did:
 * the factories some consumer is `within` and that weren't searched yet, then the calls (in
 * program then walk order) naming one of them and resolving to one, each adding a consumer
 * that may be `within` a further factory. A called factory's own consumer is dropped. Then
 * every event, in that order, becomes an edge from its owners (inline handlers bound to
 * Express's routes in `inlineHandlers`) to its queue's node, whose `source` is the first site
 * naming it anywhere. Events with the same kind, source, and queue merge into one edge
 * listing every site, at the strongest confidence. Facts that weren't `scanned` contribute
 * nothing.
 */
export function composeQueueEdges(
  facts: readonly QueueFacts[],
  inlineHandlers: ReadonlyMap<string, readonly string[]>,
): QueueEdges {
  const scanned = facts.filter((f) => f.scanned);
  const declared = new Map<string, SourceLocation>();
  const events: QueueEventFact[] = [];
  for (const f of scanned) {
    for (const { name, site } of f.declared) {
      const seen = declared.get(name);
      if (!seen || compareLocations(site, seen) < 0) declared.set(name, site);
    }
    events.push(...f.events);
  }

  // Calls of worker factories. A caller that passes its own parameter on is a factory too,
  // found in the next round.
  const calledFactories = new Set<string>();
  const searched = new Set<string>();
  for (let round = 0; round < MAX_HOPS; round++) {
    const fresh = new Map<string, readonly string[]>();
    for (const { kind, within } of events) {
      if (kind === "consumes" && within && !searched.has(within.key)) {
        fresh.set(within.key, within.names);
      }
    }
    if (fresh.size === 0) break;
    for (const key of fresh.keys()) searched.add(key);
    const names = new Set([...fresh.values()].flat());
    for (const f of scanned) {
      for (const call of f.factoryCalls) {
        if (!names.has(call.name) || !fresh.has(call.factory)) continue;
        calledFactories.add(call.factory);
        events.push(call.event);
      }
    }
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addEdge = (
    event: QueueEventFact,
    from: string,
    to: string,
    confidence: Confidence,
  ): void => {
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
        sites: [{ ...event.site }],
      });
      return;
    }
    if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = confidence;
    }
    if (!existing.sites.some((s) => compareLocations(s, event.site) === 0)) {
      existing.sites.push({ ...event.site });
    }
  };

  for (const event of events) {
    // A called factory's own worker is replaced by one per call; its publishes stay.
    if (event.kind === "consumes" && event.within && calledFactories.has(event.within.key)) {
      continue;
    }
    let to: string;
    let confidence = event.confidence;
    if (event.queue.kind === "known") {
      const { name } = event.queue;
      const node = queueNode(name, { ...(declared.get(name) ?? event.site) });
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      to = node.id;
    } else {
      const { node } = event.queue;
      if (!node) continue;
      if (!nodes.has(node.id)) nodes.set(node.id, { ...node });
      to = node.id;
      confidence = "unresolved";
    }
    for (const from of bindOwners(event.sources, inlineHandlers)) {
      addEdge(event, from, to, confidence);
    }
  }
  // Queues that are created but never used still exist.
  for (const [name, source] of declared) {
    const node = queueNode(name, { ...source });
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }

  const out = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of out) edge.sites.sort(compareLocations);
  return { nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)), edges: out };
}

/**
 * Collect one service's {@link QueueFacts} with its program: the queues its root files name,
 * their producers and consumers, and every call of a function returning a worker (whether it
 * is a factory is decided globally). Owners name inline handlers by node key (ADR-0094); other
 * programs are reached only through the resolver (ADR-0091). `repoUsesQueues` is
 * {@link usesQueueLibrary}; without it nothing is looked for.
 */
export function collectQueueFacts(
  sp: ServiceProgram,
  resolver: SymbolResolver,
  workspace: Workspace,
  repoUsesQueues: boolean,
): QueueFacts {
  const facts: QueueFacts = {
    service: sp.service.key,
    scanned: repoUsesQueues,
    declared: [],
    events: [],
    factoryCalls: [],
  };
  if (!repoUsesQueues) return facts;
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

  /** The function a call calls, with its program and how surely it was found. */
  const calledFunction = (
    sp: ServiceProgram,
    call: ts.CallExpression,
  ): { fn: FunctionWithBody; fnSp: ServiceProgram; confidence: Confidence } | undefined => {
    const name = calleeName(call.expression);
    const symbol = name && symbolAt(sp, name);
    if (!symbol) return undefined;
    const fn = functionOf(resolver.checkerOf(sp), symbol);
    if (fn) return { fn, fnSp: sp, confidence: "exact" };
    // A factory exported from a workspace package TypeScript couldn't resolve.
    const own = symbol.flags & ts.SymbolFlags.Alias ? symbol.declarations?.[0] : undefined;
    const target = own && resolver.importTarget(sp, own);
    const imported = target && functionOf(resolver.checkerOf(target.sp), target.symbol);
    return imported && target
      ? { fn: imported, fnSp: target.sp, confidence: target.confidence }
      : undefined;
  };

  /** The instance a call to a factory function returns, with the factory and its program. */
  const factoryCall = (
    sp: ServiceProgram,
    call: ts.CallExpression,
    hops: number,
    called = calledFunction(sp, call),
  ): { fn: FunctionWithBody; fnSp: ServiceProgram; instance: QueueInstance } | undefined => {
    if (!called) return undefined;
    const { fn, fnSp, confidence } = called;
    const found = returnedInstance(fnSp, fn, hops);
    if (!found) return undefined;
    const instance = bind(found, fn, call, sp);
    return {
      fn,
      fnSp,
      instance: { ...instance, confidence: weaker(confidence, found.confidence) },
    };
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
    owners: Owners,
  ): { sources: Owners; confidence: Confidence } => {
    if (!processor) return { sources: owners, confidence: "exact" };
    const e = unwrap(processor.expression);
    if (isFunctionWithBody(e)) {
      return { sources: enclosingOwners(processor.sp, e, owners), confidence: "exact" };
    }
    const target = resolver.resolve(processor.sp, e);
    return target
      ? { sources: { handlers: [], ids: [target.id] }, confidence: target.confidence }
      : { sources: owners, confidence: "exact" };
  };

  /**
   * The owners of the code around a node: the innermost symbol or inline handler's routes,
   * else its file node, else `outer` (when the file is in no service).
   */
  const enclosingOwners = (sp: ServiceProgram, node: ts.Node, outer: Owners): Owners => {
    const byNode = resolver.callers.get(node.getSourceFile());
    const file = sp.toRepoPath(node.getSourceFile().fileName);
    // Inline handlers are found in root files only, as the symbols in `byNode` are.
    const rootFile = byNode ? file : undefined;
    const handlers: string[] = [];
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      const key = rootFile === undefined ? undefined : handlerKey(rootFile, n);
      if (key !== undefined) handlers.push(key);
      const symbol = byNode?.get(n);
      if (symbol !== undefined) return { handlers, ids: [symbol] };
    }
    const service = file === undefined ? undefined : serviceForFile(workspace, file);
    return service && file !== undefined
      ? { handlers, ids: [fileNodeId(service, file)] }
      : { handlers: [...handlers, ...outer.handlers], ids: outer.ids };
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

  /** A factory's {@link FactoryRef}; none outside the repo, where no consumer can be. */
  const factoryRef = (fnSp: ServiceProgram, fn: FunctionWithBody): FactoryRef | undefined => {
    const path = fnSp.toRepoPath(fn.getSourceFile().fileName);
    return path === undefined
      ? undefined
      : { key: `${fnSp.service.key}|${nodeKey(path, fn)}`, names: functionNames(fn) };
  };

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

  /** An event as a fact: its queue's name, or the unresolved node standing for it. */
  const factOf = (event: QueueEvent, within?: FactoryRef): QueueEventFact => {
    const { kind, queue, sources, confidence, site } = event;
    const node = queue.kind === "dynamic" ? unresolvedNode(queue, event) : undefined;
    return {
      kind,
      queue:
        queue.kind === "known"
          ? { kind: "known", name: queue.name }
          : { kind: "dynamic", ...(node ? { node } : {}) },
      sources,
      confidence,
      site,
      ...(within ? { within } : {}),
    };
  };

  /** A consumer, `within` the walked program's function whose parameter its name reads. */
  const consume = (
    instance: QueueInstance,
    processor: ProgramExpression | undefined,
    owners: Owners,
    site: SourceLocation,
    node: ts.Node,
  ): QueueEventFact => {
    const { sources, confidence } = processorSources(processor, owners);
    const fn = parameterOwner(instance.queue, node);
    const event: QueueEvent = {
      kind: "consumes",
      queue: instance.queue,
      sources,
      confidence: weaker(instance.confidence, confidence),
      site,
      text: node,
    };
    return factOf(event, fn && factoryRef(sp, fn));
  };

  /** Visit every call and `new` in the program's root files with their sources. */
  const walk = (
    onCall: (file: string, node: ts.CallExpression | ts.NewExpression, sources: Owners) => void,
  ): void => {
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      const byNode = sourceFile && resolver.callers.get(sourceFile);
      if (!sourceFile || !byNode) continue;
      const service = serviceForFile(workspace, file);
      const fallback = service ? [fileNodeId(service, file)] : [];
      const visit = (node: ts.Node, owners: Owners): void => {
        const current = ownersAt(file, node, byNode.get(node), owners);
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          onCall(file, node, withFallback(current, fallback));
        }
        ts.forEachChild(node, (child) => {
          visit(child, current);
        });
      };
      visit(sourceFile, NO_OWNERS);
    }
  };

  // Constructions and calls on instances.
  walk((file, node, sources) => {
    // Bull's default export also works without `new`; other constructors need it.
    const built =
      ts.isNewExpression(node) || ts.isIdentifier(unwrap(node.expression))
        ? constructed(sp, node, 0)
        : undefined;
    if (built) declare(built.queue);
    if (built?.role === "worker") {
      facts.events.push(consume(built, built.processor, sources, locationOf(node, file), node));
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
            facts.events.push(
              factOf({
                kind: "publishes",
                queue,
                sources,
                confidence: receiver.confidence,
                site,
                text: node,
              }),
            );
          }
        } else if (receiver.role === "queue" && receiver.lib.process.includes(method)) {
          const last = node.arguments[node.arguments.length - 1];
          facts.events.push(
            consume(receiver, last && { sp, expression: last }, sources, site, node),
          );
        }
      }
    }
  });

  // Calls of functions returning a worker, in a second pass so the first one's caches fill
  // in the order they did before facts. Whether each callee is a worker factory, and so
  // whether the call consumes, is only known globally (`composeQueueEdges`). A fresh factory
  // has a parameter its worker's name reads, so functions without one are skipped.
  walk((file, node, sources) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node.expression);
    const text = name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : "";
    if (!name || text === "") return;
    const called = calledFunction(sp, node);
    if (!called || called.fn.parameters.length === 0) return;
    const factory = factoryCall(sp, node, 0, called);
    const ref = factory && factoryRef(factory.fnSp, factory.fn);
    if (!factory || !ref || factory.instance.role !== "worker") return;
    const { instance } = factory;
    facts.factoryCalls.push({
      factory: ref.key,
      name: text,
      event: consume(instance, instance.processor, sources, locationOf(name, file), node),
    });
  });

  for (const [name, site] of declared) facts.declared.push({ name, site });
  return facts;
}
