import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "./analyze.js";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import { buildSdkEdges, sdkPackage, type SdkEdges } from "./sdk.js";
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
