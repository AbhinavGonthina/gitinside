import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "./analyze.js";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import {
  buildSdkEdges,
  collectSdkFacts,
  composeSdkEdges,
  sdkPackage,
  type SdkEdges,
  type SdkFacts,
} from "./sdk.js";
import { detectWorkspace } from "./workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-sdk-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), Array.isArray(content) ? content.join("\n") + "\n" : content);
}

/** Run the detector over the temp repo, with Express inline handlers like `analyze` has. */
async function detect(): Promise<SdkEdges> {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  return buildSdkEdges(programs, resolver, workspace, express.inlineHandlers);
}

/** `from -> host (confidence) @ line:column …` per edge; edges carry no label (ADR-0034). */
function summary(result: SdkEdges): string[] {
  return result.edges.map(
    (e) =>
      `${e.from} -> ${e.to.replace("external:ext/", "")}${e.label === undefined ? "" : " LABEL"}` +
      (e.confidence === "exact" ? "" : ` (${e.confidence})`) +
      ` @ ${e.sites.map((s) => `${s.file}:${s.line}:${s.column}`).join(" ")}`,
  );
}

describe("sdkPackage", () => {
  it.each([
    ["stripe", "api.stripe.com", "exact"],
    ["twilio/lib/rest/Twilio", "api.twilio.com", "exact"],
    ["@sendgrid/mail", "api.sendgrid.com", "exact"],
    ["@aws-sdk/client-s3", "s3.amazonaws.com", "exact"],
    ["@aws-sdk/client-ses", "email.amazonaws.com", "exact"],
    ["@aws-sdk/lib-dynamodb", "dynamodb.amazonaws.com", "exact"],
    ["@aws-sdk/client-textract", "textract.amazonaws.com", "heuristic"],
  ])("%s ⇒ %s (%s)", (specifier, host, confidence) => {
    expect(sdkPackage(specifier)).toMatchObject({ host, confidence });
  });

  it.each([
    "axios",
    "@aws-sdk/credential-providers",
    "@aws-sdk/lib-unknown",
    "./stripe",
    "@sentry/node",
  ])("%s is not an SDK", (specifier) => {
    expect(sdkPackage(specifier)).toBeUndefined();
  });
});

describe("buildSdkEdges", () => {
  it("follows clients from imports, require, new, factories, and types", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/stripe.ts", [
      'import Stripe from "stripe";',
      "export const stripe = new Stripe(process.env.KEY ?? '');",
      "export async function charge() {",
      "  await stripe.paymentIntents.create({ amount: 1 });",
      "  await stripe.customers.list();",
      "}",
      "export function verify(body: string) {",
      "  return Stripe.webhooks.constructEvent(body, '', '');",
      "}",
    ]);
    await put("src/billing.ts", [
      'import { stripe } from "./stripe";',
      'import type Stripe from "stripe";',
      "export class Billing {",
      "  constructor(private readonly client: Stripe) {}",
      "  refund() { return this.client.refunds.create({}); }",
      "}",
      "export const portal = () => stripe.billingPortal.sessions.create({});",
    ]);
    await put("src/mail.js", [
      'const sgMail = require("@sendgrid/mail");',
      "sgMail.setApiKey(process.env.SENDGRID);",
      "function send(msg) { return sgMail.send(msg); }",
      "module.exports = { send };",
    ]);
    await put("src/aws.ts", [
      'import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";',
      'import * as sqs from "@aws-sdk/client-sqs";',
      "const s3 = new S3Client({});",
      "function makeQueue() { return new sqs.SQSClient({}); }",
      "export async function upload() {",
      "  await s3.send(new PutObjectCommand({ Bucket: 'b', Key: 'k' }));",
      "  await makeQueue().send({} as never);",
      "  s3.destroy();",
      "}",
    ]);
    await put("src/sms.ts", [
      'import twilio from "twilio";',
      "export const notify = () => twilio('sid', 'token').messages.create({});",
    ]);
    const result = await detect();
    expect(summary(result)).toEqual([
      "symbol:api/src/aws.ts#upload -> s3.amazonaws.com @ src/aws.ts:6:12",
      "symbol:api/src/aws.ts#upload -> sqs.amazonaws.com @ src/aws.ts:7:21",
      "symbol:api/src/billing.ts#Billing.refund -> api.stripe.com @ src/billing.ts:5:41",
      "symbol:api/src/billing.ts#portal -> api.stripe.com @ src/billing.ts:7:59",
      "symbol:api/src/mail.js#send -> api.sendgrid.com @ src/mail.js:3:36",
      "symbol:api/src/sms.ts#notify -> api.twilio.com @ src/sms.ts:2:61",
      "symbol:api/src/stripe.ts#charge -> api.stripe.com @ src/stripe.ts:4:31 src/stripe.ts:5:26",
    ]);
    expect(result.nodes.map((n) => n.id)).toEqual([
      "external:ext/api.sendgrid.com",
      "external:ext/api.stripe.com",
      "external:ext/api.twilio.com",
      "external:ext/s3.amazonaws.com",
      "external:ext/sqs.amazonaws.com",
    ]);
  });

  it("follows clients exported from workspace packages and keeps the import's confidence", async () => {
    await put(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    // No manifest entry and no `index`, so `src/index` is a heuristic import (ADR-0024).
    await put("packages/pay/package.json", JSON.stringify({ name: "@acme/pay" }));
    await put("packages/pay/src/index.ts", [
      'import Stripe from "stripe";',
      'import { Resend } from "resend";',
      "export const stripe = new Stripe('');",
      "export function getResend() { return new Resend(''); }",
    ]);
    await put("apps/web/package.json", JSON.stringify({ name: "web" }));
    await put("apps/web/src/checkout.ts", [
      'import { stripe, getResend } from "@acme/pay";',
      'import * as pay from "@acme/pay";',
      "export const one = () => stripe.checkout.sessions.create({});",
      "export const two = () => pay.stripe.refunds.create({});",
      "export const three = () => getResend().emails.send({} as never);",
    ]);
    expect(summary(await detect())).toEqual([
      "symbol:web/src/checkout.ts#one -> api.stripe.com (heuristic) @ apps/web/src/checkout.ts:3:51",
      "symbol:web/src/checkout.ts#three -> api.resend.com (heuristic) @ apps/web/src/checkout.ts:5:47",
      "symbol:web/src/checkout.ts#two -> api.stripe.com (heuristic) @ apps/web/src/checkout.ts:4:45",
    ]);
  });

  it("attributes top-level calls to the file and inline handler calls to the route", async () => {
    await put("package.json", JSON.stringify({ name: "api", dependencies: { express: "4" } }));
    await put("src/server.ts", [
      'import express from "express";',
      'import OpenAI from "openai";',
      'const { S3Client } = require("@aws-sdk/client-s3");',
      'import * as aws from "@aws-sdk/client-textract";',
      "const openai = new OpenAI();",
      "const s3 = new S3Client({});",
      "const app = express();",
      'app.post("/chat", async (req, res) => {',
      "  res.json(await openai.chat.completions.create({} as never));",
      "});",
      "void s3.send({});",
      "export function scan(client: aws.TextractClient) { return client.send({}); }",
    ]);
    expect(summary(await detect())).toEqual([
      "file:api/src/server.ts -> s3.amazonaws.com @ src/server.ts:11:9",
      "route:api/POST /chat -> api.openai.com @ src/server.ts:9:42",
      "symbol:api/src/server.ts#scan -> textract.amazonaws.com (heuristic) @ src/server.ts:12:66",
    ]);
  });

  it("recognizes Google's versioned classes and API factories, but not auth helpers", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/google.ts", [
      'import { calendar_v3 } from "@googleapis/calendar";',
      'import { google } from "googleapis";',
      "export async function list(auth: never) {",
      "  const cal = new calendar_v3.Calendar({ auth });",
      "  await cal.events.list({});",
      "}",
      "export async function people(auth: never) {",
      "  const oauth = new google.auth.OAuth2();",
      "  google.auth.fromJSON({});",
      "  const api = google.people({ version: 'v1', auth });",
      "  return api.people.get({});",
      "}",
      "export const typed = (c: calendar_v3.Calendar, e: calendar_v3.Schema$Event) =>",
      "  c.calendars.get({}) && e.id?.toString();",
    ]);
    expect(summary(await detect())).toEqual([
      "symbol:api/src/google.ts#list -> www.googleapis.com @ src/google.ts:5:20",
      "symbol:api/src/google.ts#people -> www.googleapis.com @ src/google.ts:11:21",
      "symbol:api/src/google.ts#typed -> www.googleapis.com @ src/google.ts:14:15",
    ]);
  });

  it("ignores lookalikes: local classes, non-client exports, results, and cycles", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/fake.ts", [
      "class Stripe { charges = { create: () => 1 }; }",
      'import { PutObjectCommand, type GetObjectCommandOutput } from "@aws-sdk/client-s3";',
      'import { S3Client } from "@aws-sdk/client-s3";',
      "const stripe = new Stripe();",
      "let a: any = b; let b: any = a;",
      "export function run(out: GetObjectCommandOutput) {",
      "  stripe.charges.create();",
      "  new PutObjectCommand({}).middlewareStack.add();",
      "  void out.Body?.transformToString();",
      "  a.b.c();",
      "  S3Client.name.toString();",
      "}",
      "export async function result(s3: S3Client) {",
      "  const res = await s3.send({});",
      "  return res.Body.transformToString();",
      "}",
    ]);
    // Only calls on the SDK's own exports and clients count. `S3Client.name.toString()` is a
    // call on an export that runs locally: over-reported, as documented under "not handled".
    expect(summary(await detect())).toEqual([
      "symbol:api/src/fake.ts#result -> s3.amazonaws.com @ src/fake.ts:14:24",
      "symbol:api/src/fake.ts#run -> s3.amazonaws.com @ src/fake.ts:11:17",
    ]);
  });

  it("traces each factory once, however many calls return it (M2 review)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    // Each factory returns ten calls of the one before: 10^7 traces without a cache.
    const lines = ['import Stripe from "stripe";', "declare const c: number;"];
    lines.push('function f0() { return new Stripe("k"); }');
    for (let i = 1; i <= 7; i++) {
      const returns = Array.from({ length: 10 }, (_, k) => `if (c === ${k}) return f${i - 1}();`);
      lines.push(`function f${i}() { ${returns.join(" ")} return f${i - 1}(); }`);
    }
    lines.push("export const go = () => f7().customers.create();");
    await put("src/pay.ts", lines);
    const started = performance.now();
    expect(summary(await detect())).toEqual([
      "symbol:api/src/pay.ts#go -> api.stripe.com @ src/pay.ts:11:40",
    ]);
    expect(performance.now() - started).toBeLessThan(20_000);
  });
});

describe("sdk facts", () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

  /** Every service's SDK facts and Express's inline handlers. */
  async function sdkInputs(root: string) {
    const inventory = await buildInventory(root);
    const workspace = await detectWorkspace(root, inventory.files);
    const programs = buildServicePrograms(root, workspace, inventory);
    const resolver = createSymbolResolver(programs, workspace);
    const { inlineHandlers } = buildExpressRoutes(programs, resolver);
    const facts = programs.map((sp) => collectSdkFacts(sp, resolver, workspace));
    return { facts, inlineHandlers };
  }

  it.each(["external-sdk", "shop-demo", "fake-secrets"])(
    "composes %s from JSON round-tripped facts into analyze's edges",
    async (name) => {
      const root = join(FIXTURES, name);
      const { facts, inlineHandlers } = await sdkInputs(root);
      const revived = JSON.parse(JSON.stringify(facts)) as SdkFacts[];
      expect(revived).toEqual(facts);
      const composed = composeSdkEdges(revived, inlineHandlers);
      expect(composed.edges.length).toBeGreaterThan(0);
      expect(composed).toEqual(composeSdkEdges(facts, inlineHandlers));
      // Assembly merges an SDK edge with a `fetch` edge to the same host, so the graph's
      // edge holds every composed site, possibly with more.
      const graph = await analyze(root);
      for (const edge of composed.edges) {
        const { sites, ...rest } = edge;
        const inGraph = graph.edges.find((e) => e.id === edge.id);
        expect(inGraph).toMatchObject(rest);
        expect(inGraph?.sites).toEqual(expect.arrayContaining(sites));
      }
      expect(graph.nodes).toEqual(expect.arrayContaining(composed.nodes));
    },
  );

  it("keeps a package's facts unchanged when another service mounts its handler", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
    await put(
      "packages/pay/package.json",
      JSON.stringify({ name: "@acme/pay", main: "src/index.ts", dependencies: { express: "4" } }),
    );
    await put("packages/pay/src/index.ts", [
      'import { Router } from "express";',
      'import Stripe from "stripe";',
      "const stripe = new Stripe('');",
      "export const pay = Router();",
      'pay.post("/charge", async (_req, res) => { await stripe.charges.create({}); res.end(); });',
    ]);
    await put(
      "apps/api/package.json",
      JSON.stringify({
        name: "api",
        dependencies: { express: "4", "@acme/pay": "workspace:*" },
      }),
    );
    await put("apps/api/src/server.ts", [
      'import express from "express";',
      "export const app = express();",
    ]);
    const before = await sdkInputs(dir);
    await put("apps/api/src/server.ts", [
      'import express from "express";',
      'import { pay } from "../../../packages/pay/src/index";',
      "export const app = express();",
      'app.use("/v1", pay);',
    ]);
    const after = await sdkInputs(dir);
    const of = (all: SdkFacts[], service: string) => all.find((f) => f.service === service);
    expect(of(before.facts, "pay")?.requests).toHaveLength(1);
    expect(of(after.facts, "pay")).toEqual(of(before.facts, "pay"));
    // Only the global step sees the mount (the route now belongs to the app's service).
    const from = (input: typeof before) =>
      composeSdkEdges(input.facts, input.inlineHandlers).edges.map((e) => e.from);
    expect(from(before)).toEqual(["route:pay/POST /charge"]);
    expect(from(after)).toEqual(["route:api/POST /v1/charge"]);
  });
});

describe("analyze: SDK and fetch calls", () => {
  it("share one external node per host, with no duplicate warning", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/pay.ts", [
      'import Stripe from "stripe";',
      "const stripe = new Stripe('');",
      "export async function pay() {",
      "  await stripe.charges.create({});",
      '  await fetch("https://api.stripe.com:443/v1/charges", { method: "POST" });',
      "}",
    ]);
    const graph = await analyze(dir);
    expect(graph.nodes.filter((n) => n.kind === "external").map((n) => n.id)).toEqual([
      "external:ext/api.stripe.com",
    ]);
    expect(graph.warnings.filter((w) => w.code === "DUPLICATE_NODE")).toEqual([]);
    const edges = graph.edges.filter((e) => e.kind === "external_call");
    // Assembly merges the fetch edge's site with the SDK's; serialization sorts them.
    const lines = (e: (typeof edges)[number]): number[] =>
      e.sites.map((s) => s.line).sort((a, b) => a - b);
    expect(edges.map((e) => [e.id, e.confidence, lines(e)])).toEqual([
      ["external_call:symbol:api/src/pay.ts#pay->external:ext/api.stripe.com", "exact", [4, 5]],
    ]);
  });
});

describe("analyze: SDK clients with a base URL (M9.1a3e2a)", () => {
  /** `from -> to (confidence)` per edge out of the repo's code, `to` without its kind prefix. */
  const outgoing = (graph: Awaited<ReturnType<typeof analyze>>): string[] =>
    graph.edges
      .filter((e) => e.kind === "external_call" || e.kind === "http")
      .map(
        (e) =>
          `${e.from} -> ${e.to.replace(/^external:ext\//, "")}` +
          (e.confidence === "exact" ? "" : ` (${e.confidence})`),
      )
      .sort();

  /** Each unresolved node's label, reason, and detail. */
  const unresolved = (graph: Awaited<ReturnType<typeof analyze>>): string[][] =>
    graph.nodes
      .filter((n) => n.kind === "unresolved")
      .map((n) => (n.kind === "unresolved" ? [n.label, n.reason, n.detail ?? ""] : []));

  it("sends a client's calls to the host its base option names, and skips mocks", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/llm.js", [
      'const { OpenAI } = require("openai");',
      'const Anthropic = require("@anthropic-ai/sdk");',
      'const { Octokit } = require("@octokit/rest");',
      "class Groq {",
      "  constructor() {",
      '    this.openai = new OpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey: "k" });',
      "  }",
      "  chat() { return this.openai.chat.completions.create({}); }",
      "}",
      'const claude = new Anthropic({ baseURL: "https://proxy.example.com" });',
      "function ask() { return claude.messages.create({}); }",
      "const plain = new OpenAI();",
      "function embed() { return plain.embeddings.create({}); }",
      "function mock() {",
      "  plain.chat.completions.create.mockResolvedValue({});",
      "  plain.chat.completions.create.mockImplementation(() => 1);",
      "}",
      'const ghe = new Octokit({ baseUrl: "https://github.acme.com/api/v3" });',
      "function repos() { return ghe.rest.repos.listForOrg({}); }",
      "module.exports = { Groq, ask, embed, mock, repos };",
    ]);
    await put("src/chat.ts", [
      'import OpenAI from "openai";',
      "export class Chat {",
      "  constructor(private readonly ai: OpenAI) {}",
      "  ask() { return this.ai.responses.create({} as never); }",
      "}",
    ]);
    const graph = await analyze(dir);
    // A client known only by its type may have been built with any base, so it's unresolved
    // rather than drawn to the SDK's default host (M9.7d).
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/llm.js#Groq.chat -> api.groq.com",
      "symbol:api/src/llm.js#ask -> proxy.example.com",
      "symbol:api/src/llm.js#embed -> api.openai.com",
      "symbol:api/src/llm.js#repos -> github.acme.com",
    ]);
    expect(unresolved(graph)).toEqual([
      [
        "POST this.ai /responses",
        "DYNAMIC_URL",
        "the SDK client is known only by its type, so its base URL isn't known",
      ],
    ]);
  });

  it("draws a base only known at runtime as unresolved, never the SDK's default host", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/local.js", [
      'const { OpenAI, AzureOpenAI } = require("openai");',
      "function client(basePath) { return new OpenAI({ baseURL: basePath }); }",
      "const settings = {};",
      "const spread = new OpenAI({ ...settings });",
      "const azure = new AzureOpenAI({ apiKey: 'k' });",
      "const fromEnv = new OpenAI({ baseURL: process.env.LOCAL_AI_BASE_PATH });",
      "async function run(p) {",
      "  await client(p).chat.completions.create({});",
      "  await spread.models.list();",
      "  await azure.chat.completions.create({});",
      "  await fromEnv.embeddings.create({});",
      "}",
      "module.exports = { run };",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([]);
    // By site: the Azure call (line 10), the env base (11), the parameter (8), the spread (9).
    expect(unresolved(graph)).toEqual([
      [
        "? {env:AZURE_OPENAI_ENDPOINT}/openai",
        "DYNAMIC_URL",
        "the SDK method's request path isn't known, so its base URL isn't matched to a route",
      ],
      [
        "POST {env:LOCAL_AI_BASE_PATH}/embeddings",
        "NO_MATCHING_ROUTE",
        "the env var LOCAL_AI_BASE_PATH isn't named like an API base (*_API_URL, *_API_PATH, …)",
      ],
      [
        "POST basePath /chat/completions",
        "DYNAMIC_URL",
        "the SDK client's base URL starts with a value only known at runtime",
      ],
      [
        "GET { ...settings } /models",
        "DYNAMIC_URL",
        "the SDK client's base URL can't be read statically",
      ],
    ]);
  });

  it("reads a base held in an instance field set once in the constructor (M9.1a7a)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/providers.js", [
      'const { OpenAI } = require("openai");',
      "class ApiPie {",
      "  constructor() {",
      '    this.basePath = "https://apipie.ai/v1";',
      "    this.openai = new OpenAI({ baseURL: this.basePath });",
      "  }",
      "  chat() { return this.openai.chat.completions.create({}); }",
      "}",
      "class Generic {",
      "  constructor() {",
      "    this.basePath = process.env.GENERIC_BASE_PATH;",
      "    this.openai = new OpenAI({ baseURL: this.basePath });",
      "  }",
      "  chat() { return this.openai.chat.completions.create({}); }",
      "}",
      "class Reset {",
      "  constructor() {",
      '    this.base = "https://first.example.com/v1";',
      "    this.openai = new OpenAI({ baseURL: this.base });",
      "  }",
      '  init() { this.base = "https://second.example.com/v1"; }',
      "  chat() { return this.openai.chat.completions.create({}); }",
      "}",
      "module.exports = { ApiPie, Generic, Reset };",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/providers.js#ApiPie.chat -> apipie.ai (heuristic)",
    ]);
    expect(unresolved(graph)).toEqual([
      [
        "POST {env:GENERIC_BASE_PATH}/chat/completions",
        "NO_MATCHING_ROUTE",
        "the env var GENERIC_BASE_PATH isn't named like an API base (*_API_URL, *_API_PATH, …)",
      ],
      [
        "POST this.base /chat/completions",
        "DYNAMIC_URL",
        "the SDK client's base URL starts with a value only known at runtime",
      ],
    ]);
  });

  it("reads a typed client's construction before its type (M9.7d, G1)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/llm.ts", [
      'import OpenAI from "openai";',
      "export class Groq {",
      "  private openai: OpenAI;",
      "  constructor() {",
      '    this.openai = new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });',
      "  }",
      "  chat() { return this.openai.chat.completions.create({} as never); }",
      "}",
      "export class Proxy {",
      '  private readonly ai: OpenAI = new OpenAI({ baseURL: "https://proxy.example.com/v1" });',
      "  list() { return this.ai.models.list(); }",
      "}",
      'const local: OpenAI = new OpenAI({ baseURL: "https://local.example.com/v1" });',
      "export function embed() { return local.embeddings.create({} as never); }",
      "export class Injected {",
      "  constructor(private readonly ai: OpenAI) {}",
      "  ask() { return this.ai.responses.create({} as never); }",
      "}",
      "export class Late {",
      "  private client!: OpenAI;",
      "  list() { return this.client.models.list(); }",
      "}",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/llm.ts#Groq.chat -> api.groq.com",
      "symbol:api/src/llm.ts#Proxy.list -> proxy.example.com",
      "symbol:api/src/llm.ts#embed -> local.example.com",
    ]);
    // A client known only by its type may have been built with any base (line 17, then 21).
    const unseen = "the SDK client is known only by its type, so its base URL isn't known";
    expect(unresolved(graph)).toEqual([
      ["POST this.ai /responses", "DYNAMIC_URL", unseen],
      ["GET this.client /models", "DYNAMIC_URL", unseen],
    ]);
  });

  it("draws a client whose branches disagree on the base as unresolved, and skips mock chains (M9.7d, G2, G5)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/llm.ts", [
      'import OpenAI from "openai";',
      'const LOCAL = process.env.LOCAL === "1";',
      'const either = LOCAL ? new OpenAI({ baseURL: "https://openrouter.ai/api/v1" }) : new OpenAI();',
      "const same = LOCAL",
      '  ? new OpenAI({ baseURL: "https://openrouter.ai/api/v1" })',
      '  : new OpenAI({ baseURL: "https://openrouter.ai/api/v1" });',
      "const given = (globalThis as { ai?: unknown }).ai;",
      'const fallback = given ?? new OpenAI({ baseURL: "https://fallback.example.com/v1" });',
      "function make(kind: string) {",
      '  if (kind === "groq") return new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });',
      "  return new OpenAI();",
      "}",
      'const made = make("x");',
      "export class Switch {",
      "  private ai: OpenAI;",
      "  constructor(local: boolean) {",
      '    if (local) this.ai = new OpenAI({ baseURL: "http://localhost:11434/v1" });',
      "    else this.ai = new OpenAI();",
      "  }",
      "  list() { return this.ai.models.list(); }",
      "}",
      "export async function run() {",
      "  await either.chat.completions.create({} as never);",
      "  await same.embeddings.create({} as never);",
      "  await fallback.models.list();",
      "  await made.chat.completions.create({} as never);",
      "}",
      "export function mocks() {",
      "  return [",
      "    same.chat.completions.create.mock.calls.at(-1),",
      "    same.models.list.getMockName(),",
      "    same.embeddings.create.withImplementation(() => 1, () => undefined),",
      "    same.models.list.mockReset(),",
      "  ];",
      "}",
      "(globalThis as { ai?: unknown }).ai = fallback;",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/llm.ts#run -> fallback.example.com",
      "symbol:api/src/llm.ts#run -> openrouter.ai",
    ]);
    // By site: `either` (line 23), `made` (26), then `this.ai` (20).
    const branches = "the SDK client is built with different base URLs on different branches";
    expect(unresolved(graph)).toEqual([
      ["GET this.ai /models", "DYNAMIC_URL", branches],
      ["POST either /chat/completions", "DYNAMIC_URL", branches],
      ["POST made /chat/completions", "DYNAMIC_URL", branches],
    ]);
  });

  it("merges every write of a field, in JS and beside a TS initializer (M9.7g, H1)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/switch.js", [
      'const { OpenAI } = require("openai");',
      'const GROQ = "https://api.groq.com/openai/v1";',
      "class Switch {",
      "  constructor(local) {",
      '    if (local) this.ai = new OpenAI({ baseURL: "http://localhost:11434/v1" });',
      "    else this.ai = new OpenAI();",
      "  }",
      "  list() { return this.ai.models.list(); }",
      "}",
      "class Same {",
      "  constructor(fast) {",
      "    if (fast) this.ai = new OpenAI({ baseURL: GROQ });",
      "    else this.ai = new OpenAI({ baseURL: GROQ });",
      "  }",
      "  list() { return this.ai.models.list(); }",
      "}",
      "class Reset {",
      "  constructor() { this.ai = null; }",
      "  init() { this.ai = this.ai || new OpenAI({ baseURL: GROQ }); }",
      "  embed() { return this.ai.embeddings.create({}); }",
      "}",
      "module.exports = { Switch, Same, Reset };",
    ]);
    await put("src/fields.ts", [
      'import OpenAI from "openai";',
      'const GROQ = "https://api.groq.com/openai/v1";',
      "export class Overridden {",
      "  private ai = new OpenAI();",
      "  useGroq() { this.ai = new OpenAI({ baseURL: GROQ }); }",
      "  list() { return this.ai.models.list(); }",
      "}",
      "export class Kept {",
      "  private ai: OpenAI = new OpenAI({ baseURL: GROQ });",
      "  reset() { this.ai = new OpenAI({ baseURL: GROQ }); }",
      "  list() { return this.ai.models.list(); }",
      "}",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/fields.ts#Kept.list -> api.groq.com",
      "symbol:api/src/switch.js#Reset.embed -> api.groq.com",
      "symbol:api/src/switch.js#Same.list -> api.groq.com",
    ]);
    // By site: `Overridden.list` (fields.ts:6), then `Switch.list` (switch.js:8).
    const branches = "the SDK client is built with different base URLs on different branches";
    expect(unresolved(graph)).toEqual([
      ["GET this.ai /models", "DYNAMIC_URL", branches],
      ["GET this.ai /models", "DYNAMIC_URL", branches],
    ]);
  });

  it("decides unread branches and branches of two packages by rule (M9.7g, H2)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/llm.ts", [
      'import OpenAI from "openai";',
      'import Anthropic from "@anthropic-ai/sdk";',
      'import Stripe from "stripe";',
      'const GROQ = "https://api.groq.com/openai/v1";',
      "export class Injected {",
      "  private ai: OpenAI;",
      "  constructor(opts: { client?: unknown }) {",
      "    this.ai = (opts.client as OpenAI | undefined) ?? new OpenAI({ baseURL: GROQ });",
      "  }",
      "  list() { return this.ai.models.list(); }",
      "}",
      "const cache = globalThis as unknown as { ai?: OpenAI };",
      "const cached = cache.ai ?? new OpenAI({ baseURL: GROQ });",
      "cache.ai = cached;",
      "const keyed = process.env.KEY && new OpenAI({ baseURL: GROQ });",
      "const pick = process.env.CLAUDE ? new Anthropic() : new OpenAI({ baseURL: GROQ });",
      "export function pay(given: unknown) {",
      '  const stripe = (given as Stripe | undefined) ?? new Stripe("k");',
      "  return stripe.refunds.create({});",
      "}",
      "export async function run() {",
      "  await cached.embeddings.create({} as never);",
      "  await keyed.chat.completions.create({} as never);",
      "  await pick.models.list();",
      "}",
    ]);
    await put("src/make.js", [
      'const { OpenAI } = require("openai");',
      "function make(opts) {",
      '  return opts.client || new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });',
      "}",
      "function chat(opts) { return make(opts).chat.completions.create({}); }",
      "module.exports = { chat };",
    ]);
    const graph = await analyze(dir);
    // A client read from the global object is this same client, cached; `&&`'s left side is
    // a condition; Stripe's host doesn't depend on how its client was built.
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/llm.ts#pay -> api.stripe.com",
      "symbol:api/src/llm.ts#run -> api.groq.com",
    ]);
    // By site: `Injected.list` (llm.ts:10), `pick` (24), then `make` (make.js:5).
    const branches = "the SDK client is built with different base URLs on different branches";
    expect(unresolved(graph)).toEqual([
      ["GET this.ai /models", "DYNAMIC_URL", branches],
      ["? pick", "DYNAMIC_URL", branches],
      ["POST make(opts) /chat/completions", "DYNAMIC_URL", branches],
    ]);
  });

  it("decides an unread branch beside every kind of client, in TS and JS (M9.7j, J1)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/table.ts", [
      'import OpenAI, { AzureOpenAI } from "openai";',
      'import { Octokit } from "@octokit/rest";',
      'import { Octokit as Kit } from "octokit";',
      'import Stripe from "stripe";',
      'const LOCAL = process.env.LOCAL === "1";',
      "export function bare(given: unknown) {",
      "  const bare = (given as OpenAI | undefined) || new OpenAI();",
      "  return bare.models.list();",
      "}",
      "export function keyed(given: unknown) {",
      '  const keyed = (given as OpenAI | undefined) ?? new OpenAI({ apiKey: "k" });',
      "  return keyed.models.list();",
      "}",
      "export function gh(given: unknown) {",
      '  const gh = (given as Octokit | undefined) ?? new Octokit({ auth: "t" });',
      "  return gh.repos.get({} as never);",
      "}",
      "export function azure(given: unknown) {",
      "  const azure = (given as AzureOpenAI | undefined) ?? new AzureOpenAI();",
      "  return azure.models.list();",
      "}",
      "export function opened(given: unknown, options: object) {",
      "  const opened = (given as OpenAI | undefined) ?? new OpenAI(options);",
      "  return opened.models.list();",
      "}",
      "export function pay(given: unknown) {",
      '  const stripe = (given as Stripe | undefined) ?? new Stripe("k");',
      "  return stripe.refunds.create({});",
      "}",
      "export function plain() {",
      "  return new OpenAI().models.list();",
      "}",
      "export function same() {",
      '  const same = LOCAL ? new OpenAI() : new OpenAI({ apiKey: "k" });',
      "  return same.models.list();",
      "}",
      "export function kits() {",
      "  const kits = LOCAL ? new Octokit() : new Kit();",
      "  return kits.repos.get({} as never);",
      "}",
    ]);
    await put("src/setter.js", [
      'const { OpenAI } = require("openai");',
      'const { Octokit } = require("@octokit/rest");',
      "class Chat {",
      "  constructor() { this.ai = new OpenAI(); }",
      "  setClient(c) { this.ai = c; }",
      "  list() { return this.ai.models.list(); }",
      "}",
      "function make(opts) {",
      "  const hub = opts.octokit ?? new Octokit({ auth: opts.token });",
      "  return hub.repos.get({});",
      "}",
      "function plain() { return new OpenAI().models.list(); }",
      "module.exports = { Chat, make, plain };",
    ]);
    const graph = await analyze(dir);
    // Beside a client that reads no base (Stripe), or with no unread branch at all, calls go
    // to the SDK's host; two default-built clients of one host are one.
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/setter.js#plain -> api.openai.com",
      "symbol:api/src/table.ts#kits -> api.github.com",
      "symbol:api/src/table.ts#pay -> api.stripe.com",
      "symbol:api/src/table.ts#plain -> api.openai.com",
      "symbol:api/src/table.ts#same -> api.openai.com",
    ]);
    // Beside a client whose export reads a base, built with or without one, an unread branch
    // may hold a client with any base.
    const branches = "the SDK client is built with different base URLs on different branches";
    expect(unresolved(graph).sort()).toEqual([
      ["? azure", "DYNAMIC_URL", branches],
      ["? gh", "DYNAMIC_URL", branches],
      ["? hub", "DYNAMIC_URL", branches],
      ["GET bare /models", "DYNAMIC_URL", branches],
      ["GET keyed /models", "DYNAMIC_URL", branches],
      ["GET opened /models", "DYNAMIC_URL", branches],
      ["GET this.ai /models", "DYNAMIC_URL", branches],
    ]);
  });

  it("reads a global member as a cache only in a file that writes it (M9.7j, J3)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/global.ts", [
      'import OpenAI from "openai";',
      "const g = globalThis as unknown as Record<string, unknown>;",
      "export const cached = (g.ai as OpenAI | undefined) ?? new OpenAI();",
      "g.ai = cached;",
      'export const keyed = (g.k as OpenAI | undefined) ?? new OpenAI({ apiKey: "k" });',
      'g["k"] ??= keyed;',
      "const held = g.held as OpenAI | undefined;",
      "export const viaConst = held || new OpenAI();",
      "g.held ||= viaConst;",
      "export const given = (g.given as OpenAI | undefined) ?? new OpenAI();",
      "export async function run() {",
      "  await cached.models.list();",
      "  await keyed.models.list();",
      "  await viaConst.models.list();",
      "}",
      "export async function read() {",
      "  await given.models.list();",
      "}",
    ]);
    await put("src/window.js", [
      'const { OpenAI } = require("openai");',
      "const ai = window.openai ?? new OpenAI();",
      "function ask() { return ai.models.list(); }",
      "module.exports = { ask };",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/global.ts#run -> api.openai.com",
    ]);
    // Nothing in these files caches a client there, so another may have put any client there.
    const branches = "the SDK client is built with different base URLs on different branches";
    expect(unresolved(graph)).toEqual([
      ["GET given /models", "DYNAMIC_URL", branches],
      ["GET ai /models", "DYNAMIC_URL", branches],
    ]);
  });

  it("joins branches to one answer in every order, pairs and three-way (M9.7l, K2)", async () => {
    // U: a caller's client; N: App's client (reads no base); D: built with only a token;
    // V: built with a GitHub Enterprise base.
    const kinds = new Map([
      ["U", "opts.gh"],
      ["N", "app.octokit"],
      ["D", "new Kit({ auth: opts.token })"],
      ["V", 'new Kit({ baseUrl: "https://github.acme.com/api/v3" })'],
    ]);
    const orders: string[] = [];
    const permute = (left: string[], taken: string): void => {
      if (taken.length >= 2) orders.push(taken);
      if (taken.length === 3) return;
      for (const k of left)
        permute(
          left.filter((x) => x !== k),
          taken + k,
        );
    };
    permute([...kinds.keys()], "");
    const branch = (k: string, ts: boolean): string => {
      const text = kinds.get(k) ?? k;
      return ts && k === "U" ? `(${text} as Kit | undefined)` : text;
    };
    // Every base a client may have is the default host only when no branch reads another:
    // App's client beside a token-built one, or beside a caller's client.
    const defaultHost = (order: string): boolean =>
      [...order].sort().join("") === "DN" || [...order].sort().join("") === "NU";
    const chain = (order: string, ts: boolean): string =>
      [...order].map((k) => branch(k, ts)).join(" ?? ");
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/table.ts", [
      'import { App, Octokit as Kit } from "octokit";',
      'const app = new App({ appId: 1, privateKey: "k" });',
      ...orders.map(
        (o) =>
          `export function f_${o}(opts: { gh?: unknown; token?: string }) { const gh = ${chain(o, true)}; return gh.rest.repos.get({} as never); }`,
      ),
    ]);
    await put("src/table.js", [
      'const { App, Octokit: Kit } = require("octokit");',
      'const app = new App({ appId: 1, privateKey: "k" });',
      ...orders.map(
        (o) =>
          `function f_${o}(opts) { const gh = ${chain(o, false)}; return gh.rest.repos.get({}); }`,
      ),
      `module.exports = { ${orders.map((o) => `f_${o}`).join(", ")} };`,
    ]);
    await put("src/fields.js", [
      'const { App, Octokit: Kit } = require("octokit");',
      'const app = new App({ appId: 1, privateKey: "k" });',
      ...orders.map((o) => {
        const writes = [...o].map(
          (k, i) => `${i === 0 ? "" : "else "}if (pick === ${i}) this.gh = ${branch(k, false)};`,
        );
        return `class C_${o} { constructor(opts, pick) { ${writes.join(" ")} } get() { return this.gh.rest.repos.get({}); } }`;
      }),
      `module.exports = { ${orders.map((o) => `C_${o}`).join(", ")} };`,
    ]);
    const graph = await analyze(dir);
    const targets = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (edge.kind !== "external_call" && edge.kind !== "http") continue;
      const from = /#(?:f_|C_)(\w+?)(?:\.get)?$/.exec(edge.from)?.[1];
      const file = /src\/(\w+\.\w+)#/.exec(edge.from)?.[1];
      if (from === undefined || file === undefined) continue;
      const key = `${file} ${from}`;
      const to = edge.to.startsWith("unresolved:") ? "unresolved" : edge.to;
      targets.set(key, [...(targets.get(key) ?? []), to].sort());
    }
    const expected = new Map<string, string[]>();
    for (const file of ["fields.js", "table.js", "table.ts"]) {
      for (const o of orders) {
        expected.set(`${file} ${o}`, [
          defaultHost(o) ? "external:ext/api.github.com" : "unresolved",
        ]);
      }
    }
    expect(new Map([...targets].sort())).toEqual(new Map([...expected].sort()));
    // Every unresolved one is so because its branches disagree.
    expect(new Set(unresolved(graph).map(([, reason, detail]) => `${reason} ${detail}`))).toEqual(
      new Set([
        "DYNAMIC_URL the SDK client is built with different base URLs on different branches",
      ]),
    );
  });

  it("reads a global member by what the file writes to its path (M9.7l, K1)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/global.ts", [
      'import OpenAI from "openai";',
      "type Slots = { openai?: OpenAI; ai?: OpenAI; cache?: { ai?: OpenAI }; built?: OpenAI; groq?: OpenAI; inline?: OpenAI };",
      "const g = globalThis as unknown as Slots;",
      "export function setAI(c: OpenAI) { g.openai = c; }",
      "export const injected = g.openai ?? new OpenAI();",
      "export const nested = g.ai ?? new OpenAI();",
      "(g.cache as { ai?: OpenAI }).ai = nested;",
      "export function init() { g.built = new OpenAI(); }",
      "export const built = g.built ?? new OpenAI();",
      'export function useGroq() { g.groq = new OpenAI({ baseURL: "https://api.groq.com/openai/v1" }); }',
      "export const groq = g.groq ?? new OpenAI();",
      "declare const self: { held?: OpenAI };",
      "export const kept = self.held ?? new OpenAI();",
      "self.held = kept;",
      "export function keptModels() { return kept.models.list(); }",
      "export function initInline() { g.inline = g.inline ?? new OpenAI(); }",
      "export const inline = g.inline ?? new OpenAI();",
      "export function inlineModels() { return inline.models.list(); }",
      "export function injectedModels() { return injected.models.list(); }",
      "export function nestedModels() { return nested.models.list(); }",
      "export function builtModels() { return built.models.list(); }",
      "export function groqModels() { return groq.models.list(); }",
    ]);
    await put("src/inject.js", [
      'const { OpenAI } = require("openai");',
      "function setAI(c) { globalThis.openai = c; }",
      "const ai = globalThis.openai ?? new OpenAI();",
      "function ask() { return ai.models.list(); }",
      "function local(self) {",
      "  const own = self.client ?? new OpenAI();",
      "  self.client = own;",
      "  return own.models.list();",
      "}",
      "function Holder() {",
      "  var self = this;",
      "  self.list = function list() {",
      "    const held = self.ai ?? new OpenAI();",
      "    self.ai = held;",
      "    return held.models.list();",
      "  };",
      "}",
      "module.exports = { setAI, ask, local, Holder };",
    ]);
    const graph = await analyze(dir);
    // A global member written only with a client the other branch builds, or with itself
    // (`g.inline = g.inline ?? …`), is that client; an ambient `declare const self` names the
    // global object.
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/global.ts#builtModels -> api.openai.com",
      "symbol:api/src/global.ts#inlineModels -> api.openai.com",
      "symbol:api/src/global.ts#keptModels -> api.openai.com",
    ]);
    // An injected client, a write to another path, a different base, and a member of an
    // object that isn't the global (a parameter, a `var self = this`) may hold any client.
    const branches = "the SDK client is built with different base URLs on different branches";
    expect(unresolved(graph).sort()).toEqual([
      ["GET ai /models", "DYNAMIC_URL", branches],
      ["GET groq /models", "DYNAMIC_URL", branches],
      ["GET held /models", "DYNAMIC_URL", branches],
      ["GET injected /models", "DYNAMIC_URL", branches],
      ["GET nested /models", "DYNAMIC_URL", branches],
      ["GET own /models", "DYNAMIC_URL", branches],
    ]);
  });

  it("reads each global read form beside each write form, in TS and JS (M9.7m, L1, L2)", async () => {
    // How the reading file reads the path, then calls a method on the client it gets.
    const reads = new Map<string, (p: string) => string[]>([
      [
        "nn",
        (p) => [
          `const v_${p} = G.${p} ?? new OpenAI();`,
          `X function use_${p}() { return v_${p}.models.list(); }`,
        ],
      ],
      [
        "or",
        (p) => [
          `const v_${p} = G.${p} || new OpenAI();`,
          `X function use_${p}() { return v_${p}.models.list(); }`,
        ],
      ],
      [
        "nq",
        (p) => [
          `const get_${p} = () => (G.${p} ??= new OpenAI());`,
          `X function use_${p}() { return get_${p}().models.list(); }`,
        ],
      ],
      [
        "oq",
        (p) => [
          `const get_${p} = () => (G.${p} ||= new OpenAI());`,
          `X function use_${p}() { return get_${p}().models.list(); }`,
        ],
      ],
      [
        "held",
        (p) => [
          `const h_${p} = G.${p};`,
          `const v_${p} = h_${p} ?? new OpenAI();`,
          `X function use_${p}() { return v_${p}.models.list(); }`,
        ],
      ],
    ]);
    // What else writes the path: in the reading file, then in another file.
    const cache = (p: string): string =>
      `X function warm_${p}() { G.${p} = G.${p} ?? new OpenAI(); }`;
    const writes = new Map<string, (p: string, ts: boolean) => { own: string[]; other: string[] }>([
      ["none", () => ({ own: [], other: [] })],
      ["cache", (p) => ({ own: [cache(p)], other: [] })],
      [
        "injected",
        (p, ts) => ({
          own: [`X function set_${p}(c${ts ? ": OpenAI" : ""}) { G.${p} = c; }`],
          other: [],
        }),
      ],
      [
        "other",
        (p) => ({
          own: [cache(p)],
          other: [`X function groq_${p}() { G.${p} = new OpenAI({ baseURL: GROQ }); }`],
        }),
      ],
      [
        "elsewhere",
        (p) => ({ own: [], other: [`X function init_${p}() { G.${p} = new OpenAI(); }`] }),
      ],
      [
        "assign",
        (p, ts) => ({
          own: [
            cache(p),
            `X function put_${p}(c${ts ? ": OpenAI" : ""}) { Object.assign(globalThis, { ${p}: c }); }`,
          ],
          other: [],
        }),
      ],
      [
        "unseen",
        (p, ts) => ({
          own: [
            cache(p),
            `X function def_${p}(c${ts ? ": OpenAI" : ""}) { Object.defineProperty(globalThis, "${p}", { value: c }); }`,
          ],
          other: [],
        }),
      ],
    ]);
    // The default host only when every write stores the read itself or a default-built client,
    // and some write is seen: `??=`/`||=` is one.
    const injects = new Set(["injected", "other", "assign", "unseen"]);
    const expected = (read: string, write: string): string => {
      if (injects.has(write)) return "unresolved";
      if (write === "none" && read !== "nq" && read !== "oq") return "unresolved";
      return "external:ext/api.openai.com";
    };
    const files = { ts: [[], []] as string[][], js: [[], []] as string[][] };
    const cases: string[] = [];
    for (const lang of ["ts", "js"] as const) {
      const ts = lang === "ts";
      const fix = (line: string): string =>
        line.replaceAll("G.", ts ? "g." : "globalThis.").replace(/^X /, ts ? "export " : "");
      for (const [read, readLines] of reads) {
        for (const [write, writeLines] of writes) {
          const p = `${lang}_${read}_${write}`;
          cases.push(p);
          const { own, other } = writeLines(p, ts);
          files[lang][0]?.push(...[...readLines(p), ...own].map(fix));
          files[lang][1]?.push(...other.map(fix));
        }
      }
    }
    const names = (lines: string[]): string =>
      lines.flatMap((l) => /function (\w+)/.exec(l)?.[1] ?? []).join(", ");
    await put("package.json", JSON.stringify({ name: "api" }));
    const tsHead = [
      'import OpenAI from "openai";',
      'const GROQ = "https://api.groq.com/openai/v1";',
      "const g = globalThis as unknown as Record<string, OpenAI | undefined>;",
    ];
    await put("src/table.ts", [...tsHead, ...(files.ts[0] ?? [])]);
    await put("src/other.ts", [...tsHead, ...(files.ts[1] ?? [])]);
    const jsHead = [
      'const { OpenAI } = require("openai");',
      'const GROQ = "https://api.groq.com/openai/v1";',
    ];
    for (const [i, file] of ["src/table.js", "src/other.js"].entries()) {
      const lines = files.js[i] ?? [];
      await put(file, [...jsHead, ...lines, `module.exports = { ${names(lines)} };`]);
    }
    const graph = await analyze(dir);
    const targets = new Map<string, string>();
    for (const edge of graph.edges) {
      if (edge.kind !== "external_call" && edge.kind !== "http") continue;
      const p = /#use_(\w+)$/.exec(edge.from)?.[1];
      if (p !== undefined)
        targets.set(p, edge.to.startsWith("unresolved:") ? "unresolved" : edge.to);
    }
    const want = new Map(
      cases.map((p) => [p, expected(p.split("_")[1] ?? "", p.split("_")[2] ?? "")]),
    );
    expect(new Map([...targets].sort())).toEqual(new Map([...want].sort()));
  });

  it("reads a module variable's writes, and global paths the matcher can't see whole (M9.7m, L1, L3)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/vars.ts", [
      'import OpenAI from "openai";',
      'const GROQ = "https://api.groq.com/openai/v1";',
      "let client: OpenAI | undefined;",
      "export function setClient(c: OpenAI) { client = c; }",
      "export const getClient = () => (client ??= new OpenAI());",
      "export function injected() { return getClient().models.list(); }",
      "let lazy: OpenAI | undefined;",
      "const getLazy = () => (lazy ??= new OpenAI());",
      "export function cached() { return getLazy().models.list(); }",
      "let groq: OpenAI;",
      "groq = new OpenAI({ baseURL: GROQ });",
      "export function later() { return groq.models.list(); }",
      "let once: OpenAI | null = null;",
      "function getOnce() { if (!once) once = new OpenAI(); return once; }",
      "export function onced() { return getOnce().models.list(); }",
    ]);
    await put("src/vars.js", [
      'const { OpenAI } = require("openai");',
      "let client;",
      "function setClient(c) { client = c; }",
      "const getClient = () => (client ??= new OpenAI());",
      "function injected() { return getClient().models.list(); }",
      "let lazy;",
      "const getLazy = () => (lazy ||= new OpenAI());",
      "function cached() { return getLazy().models.list(); }",
      "module.exports = { setClient, injected, cached };",
    ]);
    await put("src/paths.ts", [
      'import OpenAI from "openai";',
      "type Slot = { ai?: OpenAI };",
      "type Slots = { slots?: Slot; s?: Slot; t?: Slot; cfg?: Slot; box?: Record<string, OpenAI> };",
      "const g = globalThis as unknown as Record<string, OpenAI | undefined> & Slots;",
      "export const a = g.a ?? new OpenAI();",
      "Object.assign(globalThis, { a });",
      "export function aModels() { return a.models.list(); }",
      "export const d = g.d ?? new OpenAI();",
      "g.d = d;",
      'export function defineD(c: OpenAI) { Object.defineProperty(globalThis, "d", { value: c }); }',
      "export function dModels() { return d.models.list(); }",
      "export const r = g.r ?? new OpenAI();",
      "g.r = r;",
      'export function setR(c: OpenAI) { Reflect.set(globalThis, "r", c); }',
      "export function rModels() { return r.models.list(); }",
      "export const k = g.box?.k ?? new OpenAI();",
      "(g.box ??= {}).k = k;",
      "export function setAny(key: string, c: OpenAI) { (g.box ??= {})[key] = c; }",
      "export function kModels() { return k.models.list(); }",
      "export const o = g.cfg?.ai ?? new OpenAI();",
      "(g.cfg ??= {}).ai = o;",
      "export function configure(opts: Slot) { Object.assign((g.cfg ??= {}), opts); }",
      "export function oModels() { return o.models.list(); }",
      "export const nested = g.slots?.ai ?? new OpenAI();",
      "(g.slots ??= {}).ai = nested;",
      "export function reset(c: OpenAI) { g.slots = { ai: c }; }",
      "export function nestedModels() { return nested.models.list(); }",
      "const s = (g.s ??= {});",
      "s.ai ??= new OpenAI();",
      "export function setS(c: OpenAI) { s.ai = c; }",
      "export function sModels() { return g.s?.ai?.models.list(); }",
      "const t = (g.t ??= {});",
      "t.ai ??= new OpenAI();",
      "export function tModels() { return t.ai?.models.list(); }",
    ]);
    const graph = await analyze(dir);
    // A variable's every write is read beside its initializer, and a write holding the
    // variable itself is its cache; an empty object written to a parent path holds no client.
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/paths.ts#aModels -> api.openai.com",
      "symbol:api/src/paths.ts#tModels -> api.openai.com",
      "symbol:api/src/vars.js#cached -> api.openai.com",
      "symbol:api/src/vars.ts#cached -> api.openai.com",
      "symbol:api/src/vars.ts#later -> api.groq.com",
      "symbol:api/src/vars.ts#onced -> api.openai.com",
    ]);
    // An injected client (also through `Reflect.set`), and a write the matcher can't read (a
    // define, a computed key, an assign from a non-literal, a parent replaced), may hold any
    // client.
    expect(
      outgoing(graph)
        .filter((e) => e.includes("-> unresolved:"))
        .map((e) => e.split(" -> ")[0])
        .sort(),
    ).toEqual([
      "symbol:api/src/paths.ts#dModels",
      "symbol:api/src/paths.ts#kModels",
      "symbol:api/src/paths.ts#nestedModels",
      "symbol:api/src/paths.ts#oModels",
      "symbol:api/src/paths.ts#rModels",
      "symbol:api/src/paths.ts#sModels",
      "symbol:api/src/vars.js#injected",
      "symbol:api/src/vars.ts#injected",
    ]);
  });

  it("reads a getter written back to what it reads the same whichever call comes first (M9.7n, M1)", async () => {
    // Each case is its own file, so what one traces first can't settle another. `warm` writes
    // the getter's result back to the variable (or global path) the getter reads; `list`
    // reads through the getter, before or after `warm` in the file.
    const variable = (setter: boolean, ts: boolean): string[] => [
      `let client${ts ? ": OpenAI | undefined" : ""};`,
      ...(setter ? [`X function setClient(c${ts ? ": OpenAI" : ""}) { client = c; }`] : []),
      "function getClient() { return client ?? new OpenAI(); }",
    ];
    // Global paths are shared by the service's files, so each case writes its own (`G.`).
    const global = (setter: boolean, ts: boolean): string[] => [
      ts
        ? "const g = globalThis as unknown as Record<string, OpenAI | undefined>;"
        : "const g = globalThis;",
      ...(setter ? [`X function setClient(c${ts ? ": OpenAI" : ""}) { G. = c; }`] : []),
      "function getClient() { return G. ?? new OpenAI(); }",
    ];
    const warm = {
      variable: "X async function warm() { client = getClient(); return client.models.list(); }",
      global: "X async function warm() { G. = getClient(); return G..models.list(); }",
    };
    const list = "X function list() { return getClient().models.list(); }";
    const cases: string[] = [];
    for (const lang of ["ts", "js"] as const) {
      const ts = lang === "ts";
      for (const kind of ["variable", "global"] as const) {
        for (const setter of [true, false]) {
          for (const order of ["first", "last"]) {
            const name = `${kind}_${setter ? "injected" : "lazy"}_${order}`;
            const fix = (line: string): string =>
              line.replace(/^X /, ts ? "export " : "").replaceAll("G.", `g.${lang}_${name}`);
            cases.push(`${lang}/${name}`);
            const body = [...(kind === "variable" ? variable : global)(setter, ts)];
            body.push(...(order === "first" ? [warm[kind], list] : [list, warm[kind]]));
            const head = ts
              ? 'import OpenAI from "openai";'
              : 'const { OpenAI } = require("openai");';
            const tail = ts ? [] : ["module.exports = { warm, list };"];
            await put(`src/${lang}/${name}.${lang}`, [head, ...body.map(fix), ...tail]);
          }
        }
      }
    }
    await put("package.json", JSON.stringify({ name: "api" }));
    const graph = await analyze(dir);
    const targets = new Map<string, string>();
    for (const edge of graph.edges) {
      if (edge.kind !== "external_call" && edge.kind !== "http") continue;
      const match = /src\/(\w+)\/(\w+)\.\w+#(warm|list)$/.exec(edge.from);
      if (!match) continue;
      const to = edge.to.startsWith("unresolved:") ? "unresolved" : edge.to;
      targets.set(`${match[1]}/${match[2]} ${match[3]}`, to);
    }
    // An injected client makes both calls unresolved in either order; with no setter, every
    // write is the getter's own result, so both keep the default host.
    const want = new Map<string, string>();
    for (const c of cases) {
      const to = c.includes("_injected_") ? "unresolved" : "external:ext/api.openai.com";
      want.set(`${c} list`, to).set(`${c} warm`, to);
    }
    expect(new Map([...targets].sort())).toEqual(new Map([...want].sort()));
  });

  it("makes a service's global reads unread when its writes can't be seen (M9.7n, M2–M4)", async () => {
    // One service per case: a write the matcher can't follow makes every read of the paths
    // it may reach unread in that service, so the cases can't share one program.
    const read = [
      "export const getAI = () => (g.ai ??= new OpenAI());",
      "export function list() { return getAI().models.list(); }",
    ];
    const typed = [
      'import OpenAI from "openai";',
      "type G = { ai?: OpenAI };",
      "const g = globalThis as unknown as G;",
    ];
    const bare = ['import OpenAI from "openai";', "declare global { var ai: OpenAI | undefined }"];
    const bareRead = [
      "export const getAI = () => (globalThis.ai ??= new OpenAI());",
      "export function list() { return getAI().models.list(); }",
    ];
    const services: Record<string, { files: Record<string, string[]>; want: string }> = {
      // M3: the global object passed to a function, aliased by a reassigned `let`, or written
      // through a destructuring assignment.
      install: {
        files: {
          "ai.ts": [
            ...typed,
            "function install(t: G, c: OpenAI) { t.ai = c; }",
            "export function setAI(c: OpenAI) { install(globalThis as unknown as G, c); }",
            ...read,
          ],
        },
        want: "unresolved",
      },
      reassigned: {
        files: {
          "ai.ts": [
            ...typed,
            "let t: G = {};",
            "export function setAI(c: OpenAI) { t = globalThis as unknown as G; t.ai = c; }",
            ...read,
          ],
        },
        want: "unresolved",
      },
      chosen: {
        files: {
          "ai.ts": [
            ...typed,
            "const root = (typeof window === 'undefined' ? globalThis : {}) as unknown as G;",
            "export function setAI(c: OpenAI) { root.ai = c; }",
            ...read,
          ],
        },
        want: "unresolved",
      },
      destructured: {
        files: {
          "ai.ts": [...typed, "export function setAI(deps: G) { ({ ai: g.ai } = deps); }", ...read],
        },
        want: "unresolved",
      },
      andAssigned: {
        files: { "ai.ts": [...typed, "export function setAI(c: OpenAI) { g.ai &&= c; }", ...read] },
        want: "unresolved",
      },
      // A module variable written where the matcher doesn't look.
      variable: {
        files: {
          "ai.ts": [
            'import OpenAI from "openai";',
            "let client: OpenAI | undefined;",
            "export function setClient(deps: { client: OpenAI }) { ({ client } = deps); }",
            "const getClient = () => (client ??= new OpenAI());",
            "export function list() { return getClient().models.list(); }",
          ],
        },
        want: "unresolved",
      },
      installJs: {
        files: {
          "ai.js": [
            'const { OpenAI } = require("openai");',
            "function install(t, c) { t.ai = c; }",
            "function setAI(c) { install(global, c); }",
            "const getAI = () => (globalThis.ai ??= new OpenAI());",
            "function list() { return getAI().models.list(); }",
            "module.exports = { setAI, list };",
          ],
        },
        want: "unresolved",
      },
      // Reads and uses that can't write the path keep the default host.
      plain: {
        files: {
          "ai.ts": [
            ...typed,
            "export const hasGlobal = typeof globalThis !== 'undefined' && 'ai' in globalThis;",
            "export function show() { console.log(g.ai, globalThis === undefined); }",
            "export function cache() { g.ai = g.ai ?? new OpenAI(); }",
            ...read,
          ],
        },
        want: "external:ext/api.openai.com",
      },
      // M2: a global written by its bare name, or destructured into it.
      bare: {
        files: { "ai.ts": [...bare, "export function setAI(c: OpenAI) { ai = c; }", ...bareRead] },
        want: "unresolved",
      },
      bareDestructured: {
        files: {
          "ai.ts": [
            ...bare,
            "export function setAI(deps: { ai: OpenAI }) { ({ ai } = deps); }",
            ...bareRead,
          ],
        },
        want: "unresolved",
      },
      bareCache: {
        files: {
          "ai.ts": [...bare, "export function warm() { ai = ai ?? new OpenAI(); }", ...bareRead],
        },
        want: "external:ext/api.openai.com",
      },
      // A JS script's top-level `var` is a global; a CommonJS module's is the module's own.
      script: {
        files: {
          "setup.js": ["var ai;", "function setAI(c) { ai = c; }"],
          "ai.js": [
            'const { OpenAI } = require("openai");',
            "const getAI = () => (globalThis.ai ??= new OpenAI());",
            "function list() { return getAI().models.list(); }",
            "module.exports = { list };",
          ],
        },
        want: "unresolved",
      },
      module: {
        files: {
          "setup.js": ["var ai;", "function setAI(c) { ai = c; }", "module.exports = { setAI };"],
          "ai.js": [
            'const { OpenAI } = require("openai");',
            "const getAI = () => (globalThis.ai ??= new OpenAI());",
            "function list() { return getAI().models.list(); }",
            "module.exports = { list };",
          ],
        },
        want: "external:ext/api.openai.com",
      },
      // M4: a `let` that held the read, then an injected client, written to the path.
      letInjected: {
        files: {
          "ai.ts": [
            ...typed,
            "let next = g.ai;",
            "export function setAI(c: OpenAI) { next = c; g.ai = next; }",
            ...read,
          ],
        },
        want: "unresolved",
      },
      letCache: {
        files: {
          "ai.ts": [
            ...typed,
            "let next = g.ai;",
            "export function warm() { next = g.ai ?? new OpenAI(); g.ai = next; }",
            ...read,
          ],
        },
        want: "external:ext/api.openai.com",
      },
    };
    await put(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["svc/*"] }),
    );
    for (const [name, { files }] of Object.entries(services)) {
      await put(`svc/${name}/package.json`, JSON.stringify({ name }));
      for (const [file, lines] of Object.entries(files))
        await put(`svc/${name}/src/${file}`, lines);
    }
    const graph = await analyze(dir);
    const targets = new Map<string, string>();
    for (const edge of graph.edges) {
      if (edge.kind !== "external_call" && edge.kind !== "http") continue;
      const match = /^symbol:(\w+)\/src\/ai\.\w+#list$/.exec(edge.from);
      if (match?.[1] !== undefined) {
        targets.set(match[1], edge.to.startsWith("unresolved:") ? "unresolved" : edge.to);
      }
    }
    const want = new Map(Object.entries(services).map(([name, s]) => [name, s.want]));
    expect(new Map([...targets].sort())).toEqual(new Map([...want].sort()));
  });

  it(
    "trusts a client only when every value that can reach it is traced (M9.7o, N1–N4, L4)",
    {
      timeout: 120_000,
    },
    async () => {
      // The M9.7z6 review's 28 repros as rows, each in its own service, plus JS twins and
      // controls whose correct edges must stay.
      const H = 'import OpenAI from "openai";';
      const J = 'const { OpenAI } = require("openai");';
      const LIST = "export function list() { return getAI().models.list(); }";
      const JLIST = [
        "function list() { return getAI().models.list(); }",
        "module.exports = { list };",
      ];
      const typed = [H, "type G = { ai?: OpenAI };", "const g = globalThis as unknown as G;"];
      const lazy = "export const getAI = () => (g.ai ??= new OpenAI());";
      const jsLazy = "const getAI = () => (globalThis.ai ??= new OpenAI());";
      const alias = [H, "export const G = globalThis as unknown as { ai?: OpenAI };"];
      const inline = (opts: string, client: string, op = "??"): string[] => [
        H,
        `export function list(${opts}) {`,
        `  const client = ${client};`,
        `  return (client ${op} new OpenAI()).models.list();`,
        "}",
      ];
      const jsInline = (opts: string, client: string, op = "??"): string[] => [
        J,
        `function list(${opts}) {`,
        `  const client = ${client};`,
        `  return (client ${op} new OpenAI()).models.list();`,
        "}",
        "module.exports = { list };",
      ];
      const both = "opts: { ai?: OpenAI; fallback?: OpenAI }";
      const ab = "opts: { a?: OpenAI; b?: OpenAI }";
      const OPENAI = "external:ext/api.openai.com";
      const services: Record<string, { files: Record<string, string[]>; want: string }> = {
        // M1–M4, re-checked.
        m1: {
          files: {
            "ai.ts": [
              H,
              "let client: OpenAI | undefined;",
              "export function setClient(c: OpenAI) { client = c; }",
              "function getClient() { return client ?? new OpenAI(); }",
              "export async function warm() { client = getClient(); return client.models.list(); }",
              "export function list() { return getClient().models.list(); }",
            ],
          },
          want: "unresolved",
        },
        m2: {
          files: {
            "ai.ts": [
              H,
              "declare global { var openai: OpenAI | undefined }",
              "export function setAI(c: OpenAI) { openai = c; }",
              "export const getAI = () => (globalThis.openai ??= new OpenAI());",
              LIST,
            ],
          },
          want: "unresolved",
        },
        m3: {
          files: {
            "ai.ts": [
              ...typed,
              "function install(t: G, c: OpenAI) { t.ai = c; }",
              "export function setAI(c: OpenAI) { install(globalThis as unknown as G, c); }",
              lazy,
              LIST,
            ],
          },
          want: "unresolved",
        },
        m4: {
          files: {
            "ai.ts": [
              ...typed,
              "let next = g.ai;",
              "export function setAI(c: OpenAI) { next = c; g.ai = next; }",
              lazy,
              LIST,
            ],
          },
          want: "unresolved",
        },
        // N1: a join of unread values is unread, inline or held by a `const` or `let`.
        n1: { files: { "ai.ts": inline(both, "opts.ai ?? opts.fallback") }, want: "unresolved" },
        n1ctl: { files: { "ai.ts": inline(both, "opts.ai") }, want: "unresolved" },
        n1cond: {
          files: { "ai.ts": inline(`flag: boolean, ${ab}`, "flag ? opts.a : opts.b") },
          want: "unresolved",
        },
        n1let: {
          files: {
            "ai.ts": [
              H,
              "let client: OpenAI | undefined;",
              `export function setClient(${ab}) { client = opts.a ?? opts.b; }`,
              "const getAI = () => (client ??= new OpenAI());",
              LIST,
            ],
          },
          want: "unresolved",
        },
        n1letctl: {
          files: {
            "ai.ts": [
              H,
              "let client: OpenAI | undefined;",
              `export function setClient(${ab}) { client = opts.a; }`,
              "const getAI = () => (client ??= new OpenAI());",
              LIST,
            ],
          },
          want: "unresolved",
        },
        n1chain: {
          files: {
            "ai.ts": [
              H,
              `export function list(${ab}) {`,
              "  return (opts.a ?? opts.b ?? new OpenAI()).models.list();",
              "}",
            ],
          },
          want: "unresolved",
        },
        n1js: {
          files: { "ai.js": jsInline("opts", "opts.ai ?? opts.fallback") },
          want: "unresolved",
        },
        n1jsctl: { files: { "ai.js": jsInline("opts", "opts.ai") }, want: "unresolved" },
        n1jscond: {
          files: { "ai.js": jsInline("flag, opts", "flag ? opts.a : opts.b", "||") },
          want: "unresolved",
        },
        n1jschain: {
          files: {
            "ai.js": [
              J,
              "function list(opts) {",
              "  return (opts.a ?? opts.b ?? new OpenAI()).models.list();",
              "}",
              "module.exports = { list };",
            ],
          },
          want: "unresolved",
        },
        n1anyts: {
          files: { "ai.ts": inline("opts: any", "opts.ai ?? opts.fallback") },
          want: "unresolved",
        },
        n1jscomma: { files: { "ai.js": jsInline("opts", "(0, opts.ai)") }, want: "unresolved" },
        n1jsand: { files: { "ai.js": jsInline("opts", "opts.on && opts.ai") }, want: "unresolved" },
        n1jsfactory: {
          files: {
            "ai.js": [
              J,
              "function pick(opts) { return opts.a ?? opts.b; }",
              "function list(opts) { return (pick(opts) ?? new OpenAI()).models.list(); }",
              "module.exports = { list };",
            ],
          },
          want: "unresolved",
        },
        n1jsobject: {
          files: {
            "ai.js": [
              J,
              "function list(opts) {",
              "  const deps = { client: opts.a ?? opts.b };",
              "  return (deps.client ?? new OpenAI()).models.list();",
              "}",
              "module.exports = { list };",
            ],
          },
          want: "unresolved",
        },
        // Controls: values that are all traced keep the default host.
        n1jsbuilt: {
          files: { "ai.js": jsInline("flag", "flag ? new OpenAI() : new OpenAI()") },
          want: OPENAI,
        },
        n1jsnull: { files: { "ai.js": jsInline("flag", "flag ? null : undefined") }, want: OPENAI },
        // N2: a destructuring default writes whatever the source holds.
        n2var: {
          files: {
            "ai.ts": [
              H,
              "let client: OpenAI | undefined;",
              "export function setClient(deps: { ai?: OpenAI }) { ({ ai: client = new OpenAI() } = deps); }",
              "const getAI = () => (client ??= new OpenAI());",
              LIST,
            ],
          },
          want: "unresolved",
        },
        n2varctl: {
          files: {
            "ai.ts": [
              H,
              "let client: OpenAI | undefined;",
              "const getAI = () => (client ??= new OpenAI());",
              LIST,
            ],
          },
          want: OPENAI,
        },
        n2arr: {
          files: {
            "ai.ts": [
              H,
              "let client: OpenAI | undefined;",
              "export function setClient(list: OpenAI[]) { [client = new OpenAI()] = list; }",
              "const getAI = () => (client ??= new OpenAI());",
              LIST,
            ],
          },
          want: "unresolved",
        },
        n2glob: {
          files: {
            "ai.ts": [
              ...typed,
              "export function setAI(deps: G) { ({ ai: g.ai = new OpenAI() } = deps); }",
              lazy,
              LIST,
            ],
          },
          want: "unresolved",
        },
        n2js: {
          files: {
            "ai.js": [
              J,
              "let client;",
              "function setClient(deps) { ({ ai: client = new OpenAI() } = deps); }",
              "const getAI = () => (client ??= new OpenAI());",
              "function list() { return getAI().models.list(); }",
              "module.exports = { setClient, list };",
            ],
          },
          want: "unresolved",
        },
        n2field: {
          files: {
            "ai.js": [
              J,
              "class AI {",
              "  constructor(deps) { this.ai = new OpenAI(); ({ ai: this.ai } = deps); }",
              "  list() { return this.ai.models.list(); }",
              "}",
              "module.exports = { AI };",
            ],
          },
          want: "unresolved",
        },
        // A JS field only a destructuring writes is never declared, so no client is seen.
        n2fieldDefault: {
          files: {
            "ai.js": [
              J,
              "class AI {",
              "  constructor(deps) { ({ ai: this.ai = new OpenAI() } = deps); }",
              "  list() { return this.ai.models.list(); }",
              "}",
              "module.exports = { AI };",
            ],
          },
          want: "none",
        },
        n2fieldctl: {
          files: {
            "ai.js": [
              J,
              "class AI {",
              "  constructor() { this.ai = new OpenAI(); }",
              "  list() { return this.ai.models.list(); }",
              "}",
              "module.exports = { AI };",
            ],
          },
          want: OPENAI,
        },
        // N3: any use of an imported alias of the global object, named or namespace.
        n3: {
          files: {
            "globals.ts": alias,
            "setup.ts": [
              H,
              'import { G } from "./globals";',
              "export function setAI(c: OpenAI) { G.ai = c; }",
            ],
            "ai.ts": [...typed, lazy, LIST],
          },
          want: "unresolved",
        },
        n3ctl: {
          files: { "globals.ts": alias, "ai.ts": [...typed, lazy, LIST] },
          want: OPENAI,
        },
        n3pass: {
          files: {
            "globals.ts": alias,
            "setup.ts": [
              H,
              'import { G } from "./globals";',
              "function install(t: { ai?: OpenAI }, c: OpenAI) { t.ai = c; }",
              "export function setAI(c: OpenAI) { install(G, c); }",
            ],
            "ai.ts": [...typed, lazy, LIST],
          },
          want: "unresolved",
        },
        n3ns: {
          files: {
            "globals.ts": alias,
            "setup.ts": [
              H,
              'import * as globals from "./globals";',
              "export function setAI(c: OpenAI) { globals.G.ai = c; }",
            ],
            "ai.ts": [...typed, lazy, LIST],
          },
          want: "unresolved",
        },
        n3renamed: {
          files: {
            "globals.ts": alias,
            "setup.ts": [
              H,
              'import { G as Slots } from "./globals";',
              "export function setAI(c: OpenAI) { Slots.ai = c; }",
            ],
            "ai.ts": [...typed, lazy, LIST],
          },
          want: "unresolved",
        },
        n3both: {
          files: {
            "globals.ts": alias,
            "setup.ts": [
              H,
              'import { G } from "./globals";',
              "export function setAI(c: OpenAI) { G.ai = c; }",
            ],
            "ai.ts": [
              H,
              'import { G } from "./globals";',
              "export const getAI = () => (G.ai ??= new OpenAI());",
              LIST,
            ],
          },
          want: "unresolved",
        },
        n3js: {
          files: {
            "globals.js": ["const G = globalThis;", "module.exports = { G };"],
            "setup.js": [
              'const { G } = require("./globals");',
              "function setAI(c) { G.ai = c; }",
              "module.exports = { setAI };",
            ],
            "ai.js": [J, jsLazy, ...JLIST],
          },
          want: "unresolved",
        },
        // N4: a binding pattern from the global object.
        n4: {
          files: {
            "ai.ts": [
              H,
              "type S = { slots: { ai?: OpenAI } };",
              "const { slots } = globalThis as unknown as S;",
              "export function setAI(c: OpenAI) { slots.ai = c; }",
              "const g = globalThis as unknown as S;",
              "export const getAI = () => (g.slots.ai ??= new OpenAI());",
              LIST,
            ],
          },
          want: "unresolved",
        },
        n4ctl: {
          files: {
            "ai.ts": [
              H,
              "type S = { slots: { ai?: OpenAI } };",
              "const g = globalThis as unknown as S;",
              "export const getAI = () => (g.slots.ai ??= new OpenAI());",
              LIST,
            ],
          },
          want: OPENAI,
        },
        n4js: {
          files: {
            "ai.js": [
              J,
              "const { slots } = globalThis;",
              "function setAI(c) { slots.ai = c; }",
              "const getAI = () => (globalThis.slots.ai ??= new OpenAI());",
              ...JLIST,
            ],
          },
          want: "unresolved",
        },
        // L4: a stored value joining the read with anything else.
        n5: {
          files: {
            "ai.ts": [
              ...typed,
              "export function setAI(c: OpenAI) { g.ai = g.ai ?? c; }",
              lazy,
              LIST,
            ],
          },
          want: "unresolved",
        },
        n5js: {
          files: {
            "ai.js": [
              J,
              "function setAI(c) { globalThis.ai = globalThis.ai || c; }",
              jsLazy,
              ...JLIST,
            ],
          },
          want: "unresolved",
        },
        n5ctl: {
          files: {
            "ai.ts": [
              ...typed,
              "export function warm() { g.ai = g.ai ?? new OpenAI(); }",
              lazy,
              LIST,
            ],
          },
          want: OPENAI,
        },
        n5prisma: {
          files: {
            "ai.ts": [
              ...typed,
              "const ai = g.ai ?? new OpenAI();",
              "if (process.env.NODE_ENV !== 'production') g.ai = ai;",
              "export const getAI = () => ai;",
              LIST,
            ],
          },
          want: OPENAI,
        },
      };
      await put(
        "package.json",
        JSON.stringify({ name: "root", private: true, workspaces: ["svc/*"] }),
      );
      for (const [name, { files }] of Object.entries(services)) {
        await put(`svc/${name}/package.json`, JSON.stringify({ name }));
        for (const [file, lines] of Object.entries(files))
          await put(`svc/${name}/src/${file}`, lines);
      }
      const graph = await analyze(dir);
      const targets = new Map<string, string>();
      for (const edge of graph.edges) {
        if (edge.kind !== "external_call" && edge.kind !== "http") continue;
        const match = /^symbol:(\w+)\/src\/ai\.\w+#(?:AI\.)?list$/.exec(edge.from);
        if (match?.[1] !== undefined) {
          targets.set(match[1], edge.to.startsWith("unresolved:") ? "unresolved" : edge.to);
        }
      }
      // A `none` row must draw no edge at all.
      const want = new Map(
        Object.entries(services)
          .filter(([, s]) => s.want !== "none")
          .map(([name, s]) => [name, s.want]),
      );
      expect(new Map([...targets].sort())).toEqual(new Map([...want].sort()));
    },
  );

  it(
    "trusts a property only when every store to it is seen (M9.7p, P1–P8)",
    {
      timeout: 120_000,
    },
    async () => {
      // The M9.7z7 review's repros as rows, each in its own service, plus JS twins and
      // controls whose correct edges must stay. Every service's one request is `list`.
      const H = 'import OpenAI from "openai";';
      const J = 'const { OpenAI } = require("openai");';
      const typed = [H, "type G = { ai?: OpenAI };", "const g = globalThis as unknown as G;"];
      const lazy = "export const getAI = () => (g.ai ??= new OpenAI());";
      const LIST = "export function list() { return getAI().models.list(); }";
      const svc = (...body: string[]): string[] => [
        H,
        "export class Svc {",
        ...body.map((line) => `  ${line}`),
        "  list() { return this.ai.models.list(); }",
        "}",
      ];
      const jsSvc = (...body: string[]): string[] => [
        J,
        "class Svc {",
        ...body.map((line) => `  ${line}`),
        "  list() { return this.ai.models.list(); }",
        "}",
        "module.exports = { Svc };",
      ];
      const config = (...body: string[]): string[] => [
        H,
        "const config = { ai: new OpenAI() };",
        ...body,
        "export function list() { return config.ai.models.list(); }",
      ];
      const OPENAI = "external:ext/api.openai.com";
      const services: Record<string, { files: Record<string, string[]>; want: string }> = {
        // P1: a `#private` field's stores are read like a public one's.
        p1: {
          files: {
            "ai.ts": [
              H,
              "export class Svc {",
              "  #ai = new OpenAI();",
              "  setAI(c: OpenAI) { this.#ai = c; }",
              "  list() { return this.#ai.models.list(); }",
              "}",
            ],
          },
          want: "unresolved",
        },
        p1public: {
          files: { "ai.ts": svc("ai = new OpenAI();", "setAI(c: OpenAI) { this.ai = c; }") },
          want: "unresolved",
        },
        p1ctl: {
          files: {
            "ai.ts": [
              H,
              "export class Svc {",
              "  #ai = new OpenAI();",
              "  list() { return this.#ai.models.list(); }",
              "}",
            ],
          },
          want: OPENAI,
        },
        p1js: {
          files: {
            "ai.js": [
              J,
              "class Svc {",
              "  #ai = new OpenAI();",
              "  setAI(c) { this.#ai = c; }",
              "  list() { return this.#ai.models.list(); }",
              "}",
              "module.exports = { Svc };",
            ],
          },
          want: "unresolved",
        },
        // P2: a field stored outside its own class's `this.<name>` stores.
        p2outside: {
          files: {
            "ai.ts": svc("ai = new OpenAI();"),
            "setup.ts": [
              H,
              'import { Svc } from "./ai";',
              "export function inject(s: Svc, c: OpenAI) { s.ai = c; }",
            ],
          },
          want: "unresolved",
        },
        p2outsidejs: {
          files: {
            "ai.js": jsSvc("constructor() { this.ai = new OpenAI(); }"),
            "setup.js": ["function inject(s, c) { s.ai = c; }", "module.exports = { inject };"],
          },
          want: "unresolved",
        },
        p2ctl: { files: { "ai.ts": svc("ai = new OpenAI();") }, want: OPENAI },
        p2jsctl: {
          files: { "ai.js": jsSvc("constructor() { this.ai = new OpenAI(); }") },
          want: OPENAI,
        },
        // Stores to another class's or another object's member of the same name are apart.
        p2unrelated: {
          files: {
            "ai.ts": svc("ai = new OpenAI();"),
            "other.ts": [
              H,
              "export class Other { ai?: OpenAI; }",
              "export function inject(o: Other, c: OpenAI) { o.ai = c; }",
              "const box = { ai: null as OpenAI | null };",
              "export function put(c: OpenAI) { box.ai = c; }",
            ],
          },
          want: OPENAI,
        },
        p2unrelatedjs: {
          files: {
            "ai.js": jsSvc("constructor() { this.ai = new OpenAI(); }"),
            "other.js": [
              "class Other { constructor(c) { this.ai = c; } }",
              "module.exports = { Other };",
            ],
          },
          want: OPENAI,
        },
        p2sub: {
          files: {
            "ai.ts": [
              H,
              "class Base { ai = new OpenAI(); }",
              "export class Svc extends Base {",
              "  constructor(c: OpenAI) { super(); this.ai = c; }",
              "  list() { return this.ai.models.list(); }",
              "}",
            ],
          },
          want: "unresolved",
        },
        p2subctl: {
          files: {
            "ai.ts": [
              H,
              "class Base { ai = new OpenAI(); }",
              "export class Svc extends Base {",
              "  list() { return this.ai.models.list(); }",
              "}",
            ],
          },
          want: OPENAI,
        },
        // The base class reads a field a subclass also stores (in JS that store declares the
        // subclass's own field).
        p2base: {
          files: {
            "ai.ts": [
              H,
              "export class Base {",
              "  ai = new OpenAI();",
              "  list() { return this.ai.models.list(); }",
              "}",
              "export class Svc extends Base {",
              "  constructor(c: OpenAI) { super(); this.ai = c; }",
              "}",
            ],
          },
          want: "unresolved",
        },
        p2subjs: {
          files: {
            "ai.js": [
              J,
              "class Base {",
              "  constructor() { this.ai = new OpenAI(); }",
              "  list() { return this.ai.models.list(); }",
              "}",
              "class Svc extends Base {",
              "  constructor(c) { super(); this.ai = c; }",
              "}",
              "module.exports = { Svc };",
            ],
          },
          want: "unresolved",
        },
        p2subjsctl: {
          files: {
            "ai.js": [
              J,
              "class Base {",
              "  constructor() { this.ai = new OpenAI(); }",
              "  list() { return this.ai.models.list(); }",
              "}",
              "class Svc extends Base {",
              "  constructor(c) { super(); this.other = c; }",
              "}",
              "module.exports = { Svc };",
            ],
          },
          want: OPENAI,
        },
        p2assign: {
          files: {
            "ai.ts": svc(
              "ai = new OpenAI();",
              "constructor(deps: { ai?: OpenAI }) { Object.assign(this, deps); }",
            ),
          },
          want: "unresolved",
        },
        p2assignjs: {
          files: {
            "ai.js": jsSvc(
              "constructor(deps) { this.ai = new OpenAI(); Object.assign(this, deps); }",
            ),
          },
          want: "unresolved",
        },
        p2element: {
          files: { "ai.ts": svc("ai = new OpenAI();", 'setAI(c: OpenAI) { this["ai"] = c; }') },
          want: "unresolved",
        },
        p2computed: {
          files: {
            "ai.ts": svc("ai = new OpenAI();", 'set(key: "ai", c: OpenAI) { this[key] = c; }'),
          },
          want: "unresolved",
        },
        p2destructure: {
          files: {
            "ai.ts": svc("ai = new OpenAI();"),
            "setup.ts": [
              H,
              'import { Svc } from "./ai";',
              "export function inject(s: Svc, deps: { ai: OpenAI }) { ({ ai: s.ai } = deps); }",
            ],
          },
          want: "unresolved",
        },
        // P3: a module object's member, stored, assigned into, or read from a copy.
        p3: {
          files: { "ai.ts": config("export function setAI(c: OpenAI) { config.ai = c; }") },
          want: "unresolved",
        },
        p3ctl: { files: { "ai.ts": config() }, want: OPENAI },
        p3assign: {
          files: {
            "ai.ts": config(
              "export function configure(o: Partial<typeof config>) { Object.assign(config, o); }",
            ),
          },
          want: "unresolved",
        },
        p3assignliteral: {
          files: {
            "ai.ts": config(
              "export function setAI(c: OpenAI) { Object.assign(config, { ai: c }); }",
            ),
          },
          want: "unresolved",
        },
        p3and: {
          files: { "ai.ts": config("export function swap(c: OpenAI) { config.ai &&= c; }") },
          want: "unresolved",
        },
        p3pass: {
          files: {
            "ai.ts": config(
              "function install(t: { ai?: OpenAI }, c: OpenAI) { t.ai = c; }",
              "export function setAI(c: OpenAI) { install(config, c); }",
            ),
          },
          want: "unresolved",
        },
        p3js: {
          files: {
            "ai.js": [
              J,
              "const config = { ai: new OpenAI() };",
              "function setAI(c) { config.ai = c; }",
              "function list() { return config.ai.models.list(); }",
              "module.exports = { setAI, list };",
            ],
          },
          want: "unresolved",
        },
        p3spread: {
          files: {
            "ai.ts": [
              H,
              "const defaults = { ai: new OpenAI() };",
              "export function list(opts: Partial<typeof defaults>) {",
              "  const cfg = { ...defaults, ...opts };",
              "  return cfg.ai.models.list();",
              "}",
            ],
          },
          want: "unresolved",
        },
        p3spreadctl: {
          files: {
            "ai.ts": [
              H,
              "const defaults = { ai: new OpenAI() };",
              "export function list() {",
              "  const cfg = { ...defaults };",
              "  return cfg.ai.models.list();",
              "}",
            ],
          },
          want: OPENAI,
        },
        p3copy: {
          files: {
            "ai.ts": [
              H,
              "const defaults = { ai: new OpenAI() };",
              "export function list(opts: Partial<typeof defaults>) {",
              "  const cfg = Object.assign({}, defaults, opts);",
              "  return cfg.ai.models.list();",
              "}",
            ],
          },
          want: "unresolved",
        },
        p3param: {
          files: {
            "ai.ts": [
              H,
              "const config = { ai: new OpenAI() };",
              "export function list(cfg: typeof config) { return cfg.ai.models.list(); }",
            ],
          },
          want: "unresolved",
        },
        // P4: a CommonJS export stored by an importer.
        p4: {
          files: {
            "ai.js": [
              J,
              "exports.ai = new OpenAI();",
              "exports.list = () => exports.ai.models.list();",
            ],
            "b.js": ['const a = require("./ai");', "exports.setAI = (c) => { a.ai = c; };"],
          },
          want: "unresolved",
        },
        p4inline: {
          files: {
            "ai.js": [
              J,
              "exports.ai = new OpenAI();",
              "exports.list = () => exports.ai.models.list();",
            ],
            "b.js": ['exports.setAI = (c) => { require("./ai").ai = c; };'],
          },
          want: "unresolved",
        },
        p4ctl: {
          files: {
            "ai.js": [
              J,
              "exports.ai = new OpenAI();",
              "exports.list = () => exports.ai.models.list();",
            ],
          },
          want: OPENAI,
        },
        // P5: a `new` of a class that isn't an SDK's may hold its arguments' client, and a
        // class the repo declares may wrap or extend one.
        p5proxy: {
          files: {
            "ai.ts": [
              ...typed,
              "export function setAI(c: OpenAI) { g.ai = new Proxy(c, {}); }",
              lazy,
              LIST,
            ],
          },
          want: "unresolved",
        },
        p5wrapper: {
          files: {
            "ai.ts": [
              ...typed,
              "class Traced { constructor(private inner: OpenAI) {} get models() { return this.inner.models; } }",
              "export function setAI(c: OpenAI) { g.ai = new Traced(c) as unknown as OpenAI; }",
              lazy,
              LIST,
            ],
          },
          want: "unresolved",
        },
        p5subclass: {
          files: {
            "ai.ts": [
              ...typed,
              'class Groq extends OpenAI { constructor() { super({ baseURL: "https://api.groq.com/openai/v1" }); } }',
              "export function useGroq() { g.ai = new Groq(); }",
              lazy,
              LIST,
            ],
          },
          want: "unresolved",
        },
        p5ctl: {
          files: {
            "ai.ts": [...typed, "export function reset() { g.ai = new OpenAI(); }", lazy, LIST],
          },
          want: OPENAI,
        },
        // P6: a constructor joined with an unread one keeps the mark.
        p6: {
          files: {
            "ai.ts": [
              H,
              "export function list(opts: { Ctor?: typeof OpenAI }) {",
              "  const C = opts.Ctor ?? OpenAI;",
              "  return new C().models.list();",
              "}",
            ],
          },
          want: "unresolved",
        },
        p6js: {
          files: {
            "ai.js": [
              J,
              "function list(opts) { const C = opts.Ctor || OpenAI; return new C().models.list(); }",
              "module.exports = { list };",
            ],
          },
          want: "unresolved",
        },
        p6ctl: {
          files: {
            "ai.ts": [
              H,
              "export function list() {",
              "  const C = OpenAI;",
              "  return new C().models.list();",
              "}",
            ],
          },
          want: OPENAI,
        },
        // P7: a static field's stores, and a parameter's default beside what callers pass.
        p7static: {
          files: {
            "ai.ts": [
              H,
              "export class Svc {",
              "  static ai = new OpenAI();",
              "  static setAI(c: OpenAI) { Svc.ai = c; }",
              "  static list() { return Svc.ai.models.list(); }",
              "}",
            ],
          },
          want: "unresolved",
        },
        p7staticctl: {
          files: {
            "ai.ts": [
              H,
              "export class Svc {",
              "  static ai = new OpenAI();",
              "  static list() { return Svc.ai.models.list(); }",
              "}",
            ],
          },
          want: OPENAI,
        },
        // An instance field's stores don't reach a static of the same name.
        p7staticapart: {
          files: {
            "ai.ts": [
              H,
              "export class Svc {",
              "  static ai = new OpenAI();",
              "  ai?: OpenAI;",
              "  set(c: OpenAI) { this.ai = c; }",
              "  static list() { return Svc.ai.models.list(); }",
              "}",
            ],
          },
          want: OPENAI,
        },
        p7default: {
          files: {
            "ai.ts": [
              H,
              "export function list(c = new OpenAI()) { return c.models.list(); }",
              "export const viaProxy = (c: OpenAI) => list(c);",
            ],
          },
          want: "unresolved",
        },
        // P8: an object literal's method reads its own member through `this`.
        p8: {
          files: {
            "ai.ts": [
              H,
              "export const svc = {",
              "  ai: new OpenAI(),",
              "  setAI(c: OpenAI) { this.ai = c; },",
              "  list() { return this.ai.models.list(); },",
              "};",
            ],
          },
          want: "unresolved",
        },
        p8ctl: {
          files: {
            "ai.ts": [
              H,
              "export const svc = {",
              "  ai: new OpenAI(),",
              "  list() { return this.ai.models.list(); },",
              "};",
            ],
          },
          want: OPENAI,
        },
        p8js: {
          files: {
            "ai.js": [
              J,
              "const svc = {",
              "  ai: new OpenAI(),",
              "  list: function () { return this.ai.models.list(); },",
              "};",
              "module.exports = { svc };",
            ],
          },
          want: OPENAI,
        },
      };
      await put(
        "package.json",
        JSON.stringify({ name: "root", private: true, workspaces: ["svc/*"] }),
      );
      for (const [name, { files }] of Object.entries(services)) {
        await put(`svc/${name}/package.json`, JSON.stringify({ name }));
        for (const [file, lines] of Object.entries(files))
          await put(`svc/${name}/src/${file}`, lines);
      }
      const graph = await analyze(dir);
      const targets = new Map<string, string>();
      for (const edge of graph.edges) {
        if (edge.kind !== "external_call" && edge.kind !== "http") continue;
        const match = /^symbol:(\w+)\/src\/ai\.\w+#(?:\w+\.)?list$/.exec(edge.from);
        if (match?.[1] !== undefined) {
          targets.set(match[1], edge.to.startsWith("unresolved:") ? "unresolved" : edge.to);
        }
      }
      const want = new Map(Object.entries(services).map(([name, s]) => [name, s.want]));
      expect(new Map([...targets].sort())).toEqual(new Map([...want].sort()));
    },
  );

  it("reads a value again from shallower when a deeper read was cut off at the hop limit (M9.7n, M6)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    const aliases = Array.from({ length: 10 }, (_, i) => `const c${i + 1} = c${i};`);
    await put("src/chain.ts", [
      'import OpenAI from "openai";',
      'const c0 = new OpenAI({ baseURL: "https://api.groq.com/openai/v1" });',
      ...aliases,
      "export function deep() { return c10.models.list(); }",
      "export function shallow() { return c4.models.list(); }",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => e.includes("#shallow"))).toEqual([
      "symbol:api/src/chain.ts#shallow -> api.groq.com",
    ]);
  });

  it("draws no outside API for an example file's placeholder host (M9.7g, H4)", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put(".env.example", [
      "AZURE_BASE_URL=https://YOUR_RESOURCE.openai.azure.com/openai/v1",
      "DOCS_BASE_URL=https://example.com/v1",
      "HOST_BASE_URL=https://<your-host>/v1",
      "REAL_BASE_URL=https://api.together.xyz/v1",
    ]);
    await put("src/llm.ts", [
      'import OpenAI from "openai";',
      "const azure = new OpenAI({ baseURL: process.env.AZURE_BASE_URL });",
      "const docs = new OpenAI({ baseURL: process.env.DOCS_BASE_URL });",
      "const host = new OpenAI({ baseURL: process.env.HOST_BASE_URL });",
      "const real = new OpenAI({ baseURL: process.env.REAL_BASE_URL });",
      "export async function run() {",
      "  await azure.models.list();",
      "  await docs.models.list();",
      "  await host.models.list();",
      "  await real.models.list();",
      "}",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/src/llm.ts#run -> api.together.xyz (heuristic)",
    ]);
    expect(unresolved(graph).map(([label, reason]) => [label, reason])).toEqual([
      ["GET {env:AZURE_BASE_URL}/models", "NO_MATCHING_ROUTE"],
      ["GET {env:DOCS_BASE_URL}/models", "NO_MATCHING_ROUTE"],
      ["GET {env:HOST_BASE_URL}/models", "NO_MATCHING_ROUTE"],
    ]);
  });

  it("matches a client whose base is the repo's own server to its routes", async () => {
    await put("package.json", JSON.stringify({ name: "api", dependencies: { express: "4" } }));
    await put("src/server.js", [
      'const express = require("express");',
      "const app = express();",
      'app.post("/api/v1/openai/chat/completions", (req, res) => res.end());',
      'app.get("/api/v1/openai/models", (req, res) => res.end());',
      "app.listen(3001);",
    ]);
    await put("scripts/check.js", [
      'const OpenAI = require("openai");',
      'const client = new OpenAI({ baseURL: "http://localhost:3001/api/v1/openai" });',
      "async function main() {",
      "  await client.models.list();",
      "  await client.chat.completions.create({});",
      "  await client.containers.list();",
      "}",
      "main();",
    ]);
    const graph = await analyze(dir);
    expect(outgoing(graph).filter((e) => !e.includes("-> unresolved:"))).toEqual([
      "symbol:api/scripts/check.js#main -> route:api/GET /api/v1/openai/models (heuristic)",
      "symbol:api/scripts/check.js#main -> route:api/POST /api/v1/openai/chat/completions (heuristic)",
    ]);
    expect(unresolved(graph)).toEqual([
      [
        "? http://localhost:3001/api/v1/openai",
        "DYNAMIC_URL",
        "the SDK method's request path isn't known, so its base URL isn't matched to a route",
      ],
    ]);
  });
});
