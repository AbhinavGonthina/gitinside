import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import {
  buildQueueEdges,
  collectQueueFacts,
  composeQueueEdges,
  DYNAMIC_NAME_DETAIL,
  usesQueueLibrary,
  type QueueEdges,
  type QueueFacts,
} from "./queues.js";
import { detectWorkspace } from "./workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-queues-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), Array.isArray(content) ? content.join("\n") + "\n" : content);
}

/** Run the detector over the temp repo, with Express inline handlers like `analyze` has. */
async function detect(): Promise<QueueEdges> {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  return buildQueueEdges(programs, resolver, workspace, express.inlineHandlers);
}

/** `kind from -> queue (confidence) @ line:column …` per edge. */
function summary(result: QueueEdges): string[] {
  return result.edges.map(
    (e) =>
      `${e.kind} ${e.from} -> ${e.to.replace("queue:infra/redis#", "#")}` +
      (e.confidence === "exact" ? "" : ` (${e.confidence})`) +
      ` @ ${e.sites.map((s) => `${s.file}:${s.line}:${s.column}`).join(" ")}`,
  );
}

describe("buildQueueEdges: BullMQ", () => {
  it("links producers and workers across workspace packages through one queue node", async () => {
    await put(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    await put(
      "packages/jobs/package.json",
      JSON.stringify({ name: "@acme/jobs", main: "src/index.ts" }),
    );
    await put("packages/jobs/src/index.ts", [
      'import { Queue } from "bullmq";',
      'export const EMAIL = "email";',
      "export const emailQueue = new Queue(EMAIL, { connection: {} });",
    ]);
    await put("apps/web/package.json", JSON.stringify({ name: "web" }));
    await put("apps/web/src/signup.ts", [
      'import { emailQueue } from "@acme/jobs";',
      "export async function signup() {",
      '  await emailQueue.add("welcome", {});',
      '  await emailQueue.addBulk([{ name: "a", data: {} }]);',
      "}",
    ]);
    await put("apps/worker/package.json", JSON.stringify({ name: "worker" }));
    await put("apps/worker/src/main.ts", [
      'import { Worker } from "bullmq";',
      'import { EMAIL } from "@acme/jobs";',
      "export async function sendEmail(job: unknown) { return job; }",
      "new Worker(EMAIL, sendEmail, { connection: {} });",
      'const inline = new Worker("email", async (job) => job);',
      "export function start() { return new Worker(EMAIL, async () => 1); }",
      "void inline;",
    ]);
    const result = await detect();
    expect(summary(result)).toEqual([
      "consumes file:worker/src/main.ts -> #email @ apps/worker/src/main.ts:5:16",
      "consumes symbol:worker/src/main.ts#sendEmail -> #email @ apps/worker/src/main.ts:4:1",
      "consumes symbol:worker/src/main.ts#start -> #email @ apps/worker/src/main.ts:6:34",
      "publishes symbol:web/src/signup.ts#signup -> #email @ apps/web/src/signup.ts:3:20 apps/web/src/signup.ts:4:20",
    ]);
    expect(result.nodes).toEqual([
      {
        id: "queue:infra/redis#email",
        kind: "queue",
        label: "email",
        parentId: "system:root",
        layer: "infra",
        engine: "redis",
        name: "email",
        source: { file: "apps/worker/src/main.ts", line: 4, column: 12 },
      },
    ]);
  });

  it("binds factory parameters, and drops a worker factory's own edge once it is called", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/queues.ts", [
      'import { Queue, Worker, type Processor } from "bullmq";',
      "export function getQueue(name: string, prefix = 'app') {",
      "  return new Queue(name, { prefix });",
      "}",
      "export const startWorker = (name: string, fn: Processor) => new Worker(name, fn);",
      "export function idle(name: string) { return new Worker(name, async () => 1); }",
      "export const defaulted = (name = 'audit') => new Queue(name);",
      "export const fixed = () => new Worker('fixed', async () => 1);",
    ]);
    await put("src/app.ts", [
      'import { getQueue, startWorker, defaulted, fixed } from "./queues";',
      "export async function handle(job: unknown) { return job; }",
      'export const send = () => getQueue("reports").add("daily", {});',
      'export const boot = () => startWorker("reports", handle);',
      "export const audit = () => defaulted().add('x', {});",
      "export const other = () => fixed();",
    ]);
    const result = await detect();
    // `fixed()` names no parameter, so its worker counts once, at the `new`.
    expect(summary(result)).toEqual([
      "consumes symbol:api/src/app.ts#handle -> #reports @ src/app.ts:4:27",
      "consumes symbol:api/src/queues.ts#fixed -> #fixed @ src/queues.ts:8:28",
      "consumes symbol:api/src/queues.ts#idle -> unresolved:api/src/queues.ts:6:56 (unresolved) @ src/queues.ts:6:45",
      "publishes symbol:api/src/app.ts#audit -> #audit @ src/app.ts:5:40",
      "publishes symbol:api/src/app.ts#send -> #reports @ src/app.ts:3:47",
    ]);
    expect(result.nodes.map((n) => n.id)).toEqual([
      "queue:infra/redis#audit",
      "queue:infra/redis#fixed",
      "queue:infra/redis#reports",
      "unresolved:api/src/queues.ts:6:56",
    ]);
    const idle = result.nodes.find((n) => n.kind === "unresolved");
    expect(idle).toMatchObject({
      reason: "DYNAMIC_NAME",
      expression: "name",
      detail: DYNAMIC_NAME_DETAIL.computed,
    });
    expect(result.edges.find((e) => e.confidence === "unresolved")?.reason).toBe("DYNAMIC_NAME");
  });

  it("reads flows, class properties, typed queues, and top-level and route code", async () => {
    await put("package.json", JSON.stringify({ name: "api", dependencies: { express: "4" } }));
    await put("src/server.ts", [
      'import express from "express";',
      'import * as bullmq from "bullmq";',
      'const { FlowProducer } = require("bullmq");',
      "const QUEUES = { thumbs: 'thumbs' } as const;",
      "class Jobs {",
      "  private queue = new bullmq.Queue(QUEUES.thumbs);",
      "  constructor(private readonly other: bullmq.Queue) {}",
      "  run() { return this.queue.add('x', {}) && this.other.add('y', {}); }",
      "}",
      "const flow = new FlowProducer();",
      "void flow.add({ name: 'p', queueName: 'parent', children: [{ name: 'c', queueName: 'child' }] });",
      "const app = express();",
      "const live = new bullmq.Queue(process.env.QUEUE!);",
      'app.post("/live", async (_req, res) => { await live.add("x", {}); res.end(); });',
      "export { Jobs };",
    ]);
    const result = await detect();
    expect(summary(result)).toEqual([
      "publishes file:api/src/server.ts -> #child @ src/server.ts:11:11",
      "publishes file:api/src/server.ts -> #parent @ src/server.ts:11:11",
      "publishes route:api/POST /live -> unresolved:api/src/server.ts:13:31 (unresolved) @ src/server.ts:14:53",
      "publishes symbol:api/src/server.ts#Jobs.run -> #thumbs @ src/server.ts:8:29",
      // A typed queue has no name expression, so its node sits at the call's method name.
      "publishes symbol:api/src/server.ts#Jobs.run -> unresolved:api/src/server.ts:8:56 (unresolved) @ src/server.ts:8:56",
    ]);
    expect(
      result.nodes.flatMap((n) => (n.kind === "unresolved" ? [[n.id, n.detail, n.label]] : [])),
    ).toEqual([
      [
        "unresolved:api/src/server.ts:13:31",
        DYNAMIC_NAME_DETAIL.computed,
        "queue process.env.QUEUE",
      ],
      [
        "unresolved:api/src/server.ts:8:56",
        DYNAMIC_NAME_DETAIL.typed,
        // The whole call is shown, so its strings (job names, payloads) are masked.
        "queue this.other.add('…', {})",
      ],
    ]);
  });

  it("masks job data in unresolved queue nodes, but shows a name expression's own text", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/jobs.ts", [
      'import { Queue, FlowProducer } from "bullmq";',
      "class Mailer {",
      "  constructor(private queue: Queue) {}",
      '  send() { return this.queue.add("send", { token: "gi_fake_q_1" }); }',
      "}",
      "const base = { name: 'b' };",
      "const flow = new FlowProducer();",
      "export const go = () => flow.add({ ...base, data: { key: 'gi_fake_q_2' } });",
      "export const named = (tenant: string) => new Queue(`mail-${tenant}`).add('x', {});",
      "export { Mailer };",
    ]);
    const result = await detect();
    const text = JSON.stringify(result.nodes);
    expect(text).not.toContain("gi_fake_q_1");
    expect(text).not.toContain("gi_fake_q_2");
    expect(result.nodes.flatMap((n) => (n.kind === "unresolved" ? [n.expression] : []))).toEqual([
      'this.queue.add("…", { token: "…" })',
      "{ ...base, data: { key: '…' } }",
      "`mail-${tenant}`",
    ]);
  });

  it("keeps a publish inside a called worker factory, and never names a queue ''", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/jobs.ts", [
      'import { Queue, Worker } from "bullmq";',
      "export function setup(name: string) {",
      '  void new Queue(name).add("hello", {});',
      "  return new Worker(name, async () => 1);",
      "}",
      'export const boot = () => setup("email");',
      'export const empty = () => new Queue("").add("x", {});',
    ]);
    const result = await detect();
    // The worker's processor is an inline function of `setup`, so `consumes` starts there; the
    // publish was dropped along with the factory's own worker before the M2 review.
    expect(summary(result)).toEqual([
      "consumes symbol:api/src/jobs.ts#setup -> #email @ src/jobs.ts:6:27",
      "publishes symbol:api/src/jobs.ts#empty -> unresolved:api/src/jobs.ts:7:38 (unresolved) @ src/jobs.ts:7:42",
      "publishes symbol:api/src/jobs.ts#setup -> unresolved:api/src/jobs.ts:3:18 (unresolved) @ src/jobs.ts:3:24",
    ]);
    expect(result.nodes.find((n) => n.id === "unresolved:api/src/jobs.ts:7:38")).toMatchObject({
      detail: DYNAMIC_NAME_DETAIL.empty,
    });
  });

  it("binds nested worker factories and workspace factories at the import's confidence", async () => {
    await put(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    // No manifest entry and no `index`, so `src/index` is a heuristic import (ADR-0024).
    await put("packages/jobs/package.json", JSON.stringify({ name: "@acme/jobs" }));
    await put("packages/jobs/src/index.ts", [
      'import { Worker } from "bullmq";',
      "const inner = (name: string, file: string) => new Worker(name, file);",
      "export function outer(name: string) { return inner(name, './processor.js'); }",
    ]);
    await put("apps/worker/package.json", JSON.stringify({ name: "worker" }));
    await put("apps/worker/src/main.ts", [
      'import { outer } from "@acme/jobs";',
      'export const boot = () => outer("pdf");',
    ]);
    // A sandboxed processor path resolves to no symbol, so the edge starts at the caller.
    expect(summary(await detect())).toEqual([
      "consumes symbol:worker/src/main.ts#boot -> #pdf (heuristic) @ apps/worker/src/main.ts:2:27",
    ]);
  });

  it("keeps queues that nothing uses, and ignores lookalikes", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/local.ts", [
      "export class Queue { constructor(public name: string) {} add() { return 1; } }",
    ]);
    await put("src/main.ts", [
      'import { Queue as Local } from "./local";',
      'import { Queue, QueueEvents, Worker } from "bullmq";',
      'const unused = new Queue("unused");',
      'const events = new QueueEvents("unused");',
      'const worker = new Worker("w", null);',
      "export function run() {",
      '  new Local("x").add();',
      "  events.on('completed', () => 1);",
      "  worker.on('failed', () => 1);",
      "  unused.close();",
      "}",
    ]);
    const result = await detect();
    expect(summary(result)).toEqual(["consumes file:api/src/main.ts -> #w @ src/main.ts:5:16"]);
    expect(result.nodes.map((n) => n.id)).toEqual([
      "queue:infra/redis#unused",
      "queue:infra/redis#w",
    ]);
  });
});

describe("buildQueueEdges: Bull and Bee-Queue", () => {
  it("reads add/process on Bull queues and createJob/process on Bee-Queue", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/bull.js", [
      'const Queue = require("bull");',
      'const video = new Queue("video", "redis://localhost:6379");',
      'const audio = Queue("audio");',
      "function transcode(job) { return job; }",
      'video.process("hd", 2, transcode);',
      "function enqueue() { return video.add({}) && audio.addBulk([]); }",
      "audio.process(async (job) => job);",
      "module.exports = { enqueue };",
    ]);
    await put("src/bee.ts", [
      'import BeeQueue from "bee-queue";',
      "const mail = new BeeQueue('mail');",
      "export const send = () => mail.createJob({}).save();",
      "export function work(q: BeeQueue) { q.process(async () => 1); }",
      "mail.process(async () => 1);",
    ]);
    const result = await detect();
    expect(summary(result)).toEqual([
      "consumes file:api/src/bee.ts -> #mail @ src/bee.ts:5:6",
      "consumes file:api/src/bull.js -> #audio @ src/bull.js:7:7",
      "consumes symbol:api/src/bee.ts#work -> unresolved:api/src/bee.ts:4:39 (unresolved) @ src/bee.ts:4:39",
      "consumes symbol:api/src/bull.js#transcode -> #video @ src/bull.js:5:7",
      "publishes symbol:api/src/bee.ts#send -> #mail @ src/bee.ts:3:32",
      "publishes symbol:api/src/bull.js#enqueue -> #audio @ src/bull.js:6:52",
      "publishes symbol:api/src/bull.js#enqueue -> #video @ src/bull.js:6:35",
    ]);
  });
});

describe("queue facts", () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

  /** Every service's queue facts and Express's inline handlers. */
  async function queueInputs(root: string) {
    const inventory = await buildInventory(root);
    const workspace = await detectWorkspace(root, inventory.files);
    const programs = buildServicePrograms(root, workspace, inventory);
    const resolver = createSymbolResolver(programs, workspace);
    const { inlineHandlers } = buildExpressRoutes(programs, resolver);
    const scanned = usesQueueLibrary(programs);
    const facts = programs.map((sp) => collectQueueFacts(sp, resolver, workspace, scanned));
    return { facts, inlineHandlers };
  }

  /** The queue detector's part of a graph: its edges and the nodes they reach. */
  function queuePart(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, ids: Set<string>) {
    const edges = graph.edges.filter((e) => e.kind === "publishes" || e.kind === "consumes");
    return { nodes: graph.nodes.filter((n) => ids.has(n.id)), edges };
  }

  const of = (all: QueueFacts[], service: string) => all.find((f) => f.service === service);

  it("composes queues-bullmq from JSON round-tripped facts exactly as analyze does", async () => {
    const root = join(FIXTURES, "queues-bullmq");
    const { facts, inlineHandlers } = await queueInputs(root);
    const revived = JSON.parse(JSON.stringify(facts)) as QueueFacts[];
    expect(revived).toEqual(facts);
    const composed = composeQueueEdges(revived, inlineHandlers);
    expect(composed.edges.map((e) => e.kind).sort()).toEqual([
      "consumes",
      "publishes",
      "publishes",
    ]);
    const ids = new Set(composed.nodes.map((n) => n.id));
    expect(queuePart(composed, ids)).toEqual(queuePart(await analyze(root), ids));
  });

  /** A jobs package with a worker factory, and a worker app that may call it. */
  async function factoryRepo(call: boolean): Promise<void> {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
    await put(
      "packages/jobs/package.json",
      JSON.stringify({ name: "@acme/jobs", main: "src/index.ts" }),
    );
    await put("packages/jobs/src/index.ts", [
      'import { Queue, Worker, type Processor } from "bullmq";',
      "export const startWorker = (name: string, fn: Processor) => new Worker(name, fn);",
      "export function relay(queue: string) { return startWorker(queue, async () => 1); }",
      'export const mail = new Queue("mail");',
    ]);
    await put("apps/worker/package.json", JSON.stringify({ name: "worker" }));
    await put("apps/worker/src/main.ts", [
      'import { relay, mail } from "@acme/jobs";',
      "export const send = () => mail.add('x', {});",
      ...(call ? ['export const boot = () => relay("reports");'] : []),
    ]);
  }

  it("keeps a factory's package facts unchanged when another service starts calling it", async () => {
    await factoryRepo(false);
    const before = await queueInputs(dir);
    await factoryRepo(true);
    const after = await queueInputs(dir);
    expect(of(after.facts, "jobs")).toEqual(of(before.facts, "jobs"));
    expect(of(after.facts, "worker")).not.toEqual(of(before.facts, "worker"));
    // `relay` passes its parameter on, so its worker is found in the second round.
    expect(of(after.facts, "worker")?.factoryCalls.map((c) => c.name)).toEqual(["relay"]);
    const summarize = (input: typeof before) =>
      summary(composeQueueEdges(input.facts, input.inlineHandlers));
    // Uncalled, `relay` keeps its own worker, unresolved at its parameter.
    expect(summarize(before)).toEqual([
      "consumes symbol:jobs/src/index.ts#relay -> unresolved:jobs/src/index.ts:3:59 (unresolved) @ packages/jobs/src/index.ts:3:47",
      "publishes symbol:worker/src/main.ts#send -> #mail @ apps/worker/src/main.ts:2:32",
    ]);
    expect(summarize(after)).toEqual([
      "consumes symbol:jobs/src/index.ts#relay -> #reports @ apps/worker/src/main.ts:3:27",
      "publishes symbol:worker/src/main.ts#send -> #mail @ apps/worker/src/main.ts:2:32",
    ]);
    const composed = composeQueueEdges(after.facts, after.inlineHandlers);
    const ids = new Set(composed.nodes.map((n) => n.id));
    expect(queuePart(composed, ids)).toEqual(queuePart(await analyze(dir), ids));
  });

  it("matches a factory only in the program that walked it, as node identity did", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    await put("apps/jobs/package.json", JSON.stringify({ name: "jobs" }));
    await put("apps/jobs/src/index.ts", [
      'import { Worker } from "bullmq";',
      "export const startWorker = (name: string) => new Worker(name, async () => 1);",
    ]);
    await put("apps/web/package.json", JSON.stringify({ name: "web" }));
    // TypeScript resolves this import itself, so `web`'s program has its own copy of the file.
    await put("apps/web/src/main.ts", [
      'import { startWorker } from "../../jobs/src/index";',
      'export const boot = () => startWorker("email");',
    ]);
    const { facts, inlineHandlers } = await queueInputs(dir);
    const [call] = of(facts, "web")?.factoryCalls ?? [];
    const [own] = of(facts, "jobs")?.events ?? [];
    expect(call?.factory.replace(/^web\|/, "jobs|")).toBe(own?.within?.key);
    expect(call?.factory).not.toBe(own?.within?.key);
    expect(summary(composeQueueEdges(facts, inlineHandlers))).toEqual([
      "consumes symbol:jobs/src/index.ts#startWorker -> unresolved:jobs/src/index.ts:2:57 (unresolved) @ apps/jobs/src/index.ts:2:46",
    ]);
  });

  it("looks for nothing without a queue library, and composes unscanned facts to nothing", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/jobs.ts", "declare const q: any;\nexport const go = () => q.add('x', {});\n");
    const { facts, inlineHandlers } = await queueInputs(dir);
    expect(facts).toEqual([
      { service: "api", scanned: false, declared: [], events: [], factoryCalls: [] },
    ]);
    const site = { file: "src/jobs.ts", line: 2, column: 28 };
    const unscanned: QueueFacts = {
      ...(facts[0] as QueueFacts),
      declared: [{ name: "x", site }],
      events: [
        {
          kind: "publishes",
          queue: { kind: "known", name: "x" },
          sources: { handlers: [], ids: ["symbol:api/src/jobs.ts#go"] },
          confidence: "exact",
          site,
        },
      ],
    };
    expect(composeQueueEdges([unscanned], inlineHandlers)).toEqual({ nodes: [], edges: [] });
  });
});

describe("analyze: queues", () => {
  it("adds schema-valid queue nodes and edges to the graph", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/jobs.ts", [
      'import { Queue, Worker } from "bullmq";',
      'const q = new Queue("receipts");',
      "export async function issue() { await q.add('r', {}); }",
      "export async function handle() { return 1; }",
      'new Worker("receipts", handle);',
    ]);
    const graph = await analyze(dir);
    expect(graph.nodes.filter((n) => n.kind === "queue").map((n) => n.id)).toEqual([
      "queue:infra/redis#receipts",
    ]);
    expect(
      graph.edges.filter((e) => e.kind === "publishes" || e.kind === "consumes").map((e) => e.id),
    ).toEqual([
      "consumes:symbol:api/src/jobs.ts#handle->queue:infra/redis#receipts",
      "publishes:symbol:api/src/jobs.ts#issue->queue:infra/redis#receipts",
    ]);
  });
});
