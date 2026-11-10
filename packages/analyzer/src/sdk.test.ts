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
    // A client known only by its type may have been built with any base: the SDK's default
    // host is kept, but only at `heuristic`.
    expect(outgoing(graph)).toEqual([
      "symbol:api/src/chat.ts#Chat.ask -> api.openai.com (heuristic)",
      "symbol:api/src/llm.js#Groq.chat -> api.groq.com",
      "symbol:api/src/llm.js#ask -> proxy.example.com",
      "symbol:api/src/llm.js#embed -> api.openai.com",
      "symbol:api/src/llm.js#repos -> github.acme.com",
    ]);
    expect(unresolved(graph)).toEqual([]);
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
