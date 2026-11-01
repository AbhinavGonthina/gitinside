#!/usr/bin/env node
/**
 * CI's check of the worker image as Cloud Run runs it (docs/SECURITY.md §3, ADR-0111,
 * ADR-0150). Run from the repo root on a Linux machine with Docker:
 *
 *   node infra/gcp/check.mjs
 *
 * Cloud Run starts the image's own user and command with `PORT` set, a memory limit, and an
 * in-memory filesystem; it applies none of a compose file's hardening (read-only root,
 * dropped capabilities, tmpfs mounts, an init process). So the worker runs here under a
 * plain `docker run` with only what Cloud Run gives: the env (a fake one; no real secret
 * exists in CI), a `PORT` other than the 8080 default, 1 vCPU / 4 GiB with no swap, `/tmp`
 * in memory, and the `K_*` variables. Postgres is a throwaway container on the check's own
 * network. No Redis and no egress gateway: the queue is Cloud Tasks (ADR-0148), and the
 * platform's sandbox replaces the gateway (ADR-0111). It checks:
 * - the image: numeric non-root `USER`, `HOST=0.0.0.0`, `NODE_ENV=production`, the command;
 * - `GET /health` answers 200 on `PORT`, from outside the container;
 * - an unsigned request to any path is refused (401); with the secret from the env, a
 *   signed bad job is a 400, a signed unknown path a 404, a signed `GET /run` a 405;
 * - inside, for the worker and a process started next to it: uid/gid 1000 and no
 *   capabilities, no path on the filesystem outside `/tmp` (and the platform's `/proc`,
 *   `/sys`, `/dev`) that it can write, `/tmp` writable, and no npm/npx/corepack/yarn;
 * - a fixture tarball extracted under `/tmp/jobs` and analyzed by the real sandboxed child
 *   gives the golden graph byte for byte (the image layout keeps the child's read root at
 *   /app);
 * - SIGTERM as PID 1 (no init) stops it with exit 0 within Cloud Run's 10 s grace, and
 *   every log line is JSON.
 * The containers, network, and image are removed at the end, pass or fail.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = "gitinside-worker:check";
const NETWORK = "gitinside-check";
const POSTGRES = "gitinside-check-postgres";
const WORKER = "gitinside-check-worker";
// Not 8080, so the check fails if the worker ignores Cloud Run's PORT.
const PORT = "9090";
const FIXTURE = "fixtures/express-basic";
// Cloud Run's gap between SIGTERM and SIGKILL.
const GRACE_SECONDS = 10;

const secret = randomBytes(32).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "gitinside-check-"));
const envFile = join(dir, "worker.env");
writeFileSync(
  envFile,
  [
    `DATABASE_URL=postgres://gitinside:gitinside@${POSTGRES}:5432/gitinside`,
    "SNAPSHOTS_NAMESPACE=checkns",
    "SNAPSHOTS_REGION=us-ashburn-1",
    "SNAPSHOTS_ACCESS_KEY_ID=check",
    "SNAPSHOTS_SECRET_ACCESS_KEY=check",
    "SNAPSHOTS_BUCKET=gitinside-check",
    `ENQUEUE_HMAC_SECRET=${secret}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

/** `docker …` with output shown (builds, startup). */
function run(args) {
  execFileSync("docker", args, { stdio: "inherit" });
}

/** `docker …` returning stdout; `input` goes to the command's stdin. */
function capture(args, input) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** `docker inspect` of a container or image. */
function inspect(name) {
  const [details] = JSON.parse(capture(["inspect", name]));
  return details;
}

/** Run a Node ES module inside the worker container (as the image's user) and parse its JSON. */
function inWorker(script, input) {
  return JSON.parse(
    capture(["exec", "-i", WORKER, "node", "--input-type=module", "-e", script], input),
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `ready()` is true, failing after `seconds`. */
async function waitFor(what, seconds, ready) {
  for (let attempt = 0; attempt < seconds * 2; attempt++) {
    if (await ready()) return;
    await sleep(500);
  }
  throw new Error(`${what} not ready after ${seconds} s`);
}

/** A request to the worker's published port, signed like the website's tasks when asked. */
async function request(method, path, { body, signed = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (signed) {
    // hmac.ts's format: v1, timestamp, method, target, then the body.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const mac = createHmac("sha256", secret)
      .update(`v1\n${timestamp}\n${method}\n${path}\n`)
      .update(body ?? "")
      .digest("hex");
    headers["x-gitinside-timestamp"] = timestamp;
    headers["x-gitinside-signature"] = `v1=${mac}`;
  }
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body });
  return { status: response.status, body: await response.json() };
}

const MIGRATE = `
import { runMigrations } from "@gitinside/db";
await runMigrations(process.env.DATABASE_URL);
`;

// Every path outside /tmp and the platform's own mounts that the caller could write to.
const PROBE = `
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const field = (status, name) => status.match(new RegExp("^" + name + ":\\\\s*(.*)$", "m"))?.[1];
const describe = (pid) => {
  const status = readFileSync("/proc/" + pid + "/status", "utf8");
  return {
    uid: field(status, "Uid"),
    gid: field(status, "Gid"),
    capEff: field(status, "CapEff"),
    capPrm: field(status, "CapPrm"),
  };
};
const workerPid = readdirSync("/proc").find(
  (pid) => /^[0-9]+$/.test(pid) &&
    readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").includes("dist/bin.js"),
);
const skip = new Set(["/proc", "/sys", "/dev", "/tmp"]);
const writable = [];
let walked = 0;
const walk = (path) => {
  walked++;
  const stat = lstatSync(path);
  // A link's target is checked where it lives (or is a platform mount, like /dev/null).
  if (stat.isSymbolicLink()) return;
  try {
    accessSync(path, constants.W_OK);
    writable.push(path);
  } catch {}
  if (!stat.isDirectory()) return;
  let names;
  try { names = readdirSync(path); } catch { return; }
  for (const name of names) {
    const child = (path === "/" ? "" : path) + "/" + name;
    if (!skip.has(child)) walk(child);
  }
};
walk("/");
const writes = {};
for (const path of ["/probe", "/app/probe", "/home/node/probe", "/tmp/probe"]) {
  try {
    writeFileSync(path, "x");
    rmSync(path);
    writes[path] = "ok";
  } catch (error) {
    writes[path] = error.code;
  }
}
console.log(JSON.stringify({
  self: describe("self"),
  worker: workerPid === undefined ? null : describe(workerPid),
  workerPid: workerPid ?? null,
  writable,
  walked,
  writes,
  tools: ["/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack", "/usr/local/bin/yarn"].filter(existsSync),
}));
`;

const ANALYZE = `
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { extractTarball } from "./dist/extract.js";
import { runAnalysis } from "./dist/runner.js";
await mkdir("/tmp/jobs", { recursive: true });
const dir = await mkdtemp("/tmp/jobs/check-");
try {
  const src = dir + "/src";
  const out = dir + "/architecture.json";
  await mkdir(src);
  await extractTarball(process.stdin, src, { stripRoot: false });
  const result = await runAnalysis({ src, out, owner: "fixtures", name: "express-basic" });
  const graph = result.ok ? await readFile(out, "utf8") : null;
  console.log(JSON.stringify({ result, graph }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
`;

/** Remove the check's containers and network, ignoring what doesn't exist. */
function removeAll() {
  for (const args of [
    ["rm", "--force", "--volumes", WORKER, POSTGRES],
    ["network", "rm", NETWORK],
  ]) {
    try {
      execFileSync("docker", args, { stdio: "ignore" });
    } catch {
      // Not created, or already gone.
    }
  }
}

removeAll();
try {
  run(["build", "--file", "apps/worker/Dockerfile", "--tag", IMAGE, "."]);

  // The image: what Cloud Run reads from it.
  const image = inspect(IMAGE);
  assert.equal(image.Config.User, "1000:1000");
  assert.ok(image.Config.Env.includes("HOST=0.0.0.0"), image.Config.Env.join(" "));
  assert.ok(image.Config.Env.includes("NODE_ENV=production"), image.Config.Env.join(" "));
  assert.deepEqual(image.Config.Cmd, ["node", "dist/bin.js"]);
  assert.equal(image.Config.WorkingDir, "/app/apps/worker");
  assert.equal(image.Architecture, "amd64", "Cloud Run runs linux/amd64 images");

  run(["network", "create", NETWORK]);
  run([
    "run",
    "--detach",
    "--name",
    POSTGRES,
    "--network",
    NETWORK,
    "--env",
    "POSTGRES_USER=gitinside",
    "--env",
    "POSTGRES_PASSWORD=gitinside",
    "--env",
    "POSTGRES_DB=gitinside",
    "--health-cmd",
    "pg_isready -U gitinside -d gitinside",
    "--health-interval",
    "1s",
    "postgres:17-alpine",
  ]);
  await waitFor("postgres", 60, () => inspect(POSTGRES).State.Health?.Status === "healthy");
  run([
    "run",
    "--rm",
    "--network",
    NETWORK,
    "--env-file",
    envFile,
    IMAGE,
    "node",
    "--input-type=module",
    "-e",
    MIGRATE,
  ]);

  // The worker, as Cloud Run starts it: the image's user, command, and filesystem as built.
  run([
    "run",
    "--detach",
    "--name",
    WORKER,
    "--network",
    NETWORK,
    "--publish",
    `127.0.0.1:${PORT}:${PORT}`,
    "--env-file",
    envFile,
    "--env",
    `PORT=${PORT}`,
    "--env",
    "K_SERVICE=gitinside-worker",
    "--env",
    "K_REVISION=gitinside-worker-00001-chk",
    "--env",
    "K_CONFIGURATION=gitinside-worker",
    "--cpus",
    "1",
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--mount",
    "type=tmpfs,destination=/tmp,tmpfs-mode=1777",
    IMAGE,
  ]);
  await waitFor("the worker", 60, async () => {
    const state = inspect(WORKER).State;
    if (!state.Running) throw new Error(`the worker exited (${state.ExitCode})`);
    try {
      return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
    } catch {
      return false;
    }
  });
  // Nothing beyond the image hardens it, as on Cloud Run.
  const started = inspect(WORKER).HostConfig;
  assert.equal(started.ReadonlyRootfs, false);
  assert.equal(started.CapDrop, null);
  assert.equal(started.Privileged, false);

  // Health on PORT, and the request gate: the signature comes before anything else.
  const health = await request("GET", "/health");
  assert.deepEqual(health, { status: 200, body: { status: "ok" } });
  for (const [method, path] of [
    ["POST", "/run"],
    ["GET", "/"],
    ["GET", "/enqueue"],
    ["GET", "/jobs/x"],
  ]) {
    const unsigned = await request(method, path, method === "POST" ? { body: "{}" } : {});
    assert.equal(unsigned.status, 401, `${method} ${path}: ${JSON.stringify(unsigned)}`);
    assert.equal(unsigned.body.error, "MISSING_SIGNATURE");
  }
  const forged = await request("POST", "/run", { body: "{}", signed: true });
  assert.equal(forged.status, 400, JSON.stringify(forged));
  assert.equal(forged.body.error, "INVALID_REQUEST");
  assert.equal((await request("GET", "/enqueue", { signed: true })).status, 404);
  assert.equal((await request("GET", "/run", { signed: true })).status, 405);

  // Inside: the worker process and a process started next to it, as the image's user.
  const probe = inWorker(PROBE);
  assert.equal(probe.workerPid, "1", "the worker is PID 1, as on Cloud Run (no init)");
  for (const status of [probe.self, probe.worker]) {
    assert.match(status.uid, /^1000\s+1000\s+1000\s+1000$/);
    assert.match(status.gid, /^1000\s+1000\s+1000\s+1000$/);
    assert.equal(status.capEff, "0000000000000000");
    assert.equal(status.capPrm, "0000000000000000");
  }
  assert.ok(probe.walked > 1000, `walked only ${probe.walked} paths`);
  assert.deepEqual(probe.writable, [], "writable outside /tmp");
  assert.deepEqual(probe.writes, {
    "/probe": "EACCES",
    "/app/probe": "EACCES",
    "/home/node/probe": "EACCES",
    "/tmp/probe": "ok",
  });
  assert.deepEqual(probe.tools, []);

  // The real pipeline in the image: extract a tarball, analyze it in the sandboxed child.
  const tarball = execFileSync("git", ["archive", "--format=tar.gz", `HEAD:${FIXTURE}`]);
  const analysis = inWorker(ANALYZE, tarball);
  assert.equal(analysis.result.ok, true, JSON.stringify(analysis.result));
  assert.equal(analysis.graph, readFileSync(join(FIXTURE, "expected.json"), "utf8"));

  // SIGTERM: a clean stop inside Cloud Run's grace, and JSON logs throughout.
  const stopStart = performance.now();
  run(["stop", "--timeout", String(GRACE_SECONDS), WORKER]);
  const stopMs = performance.now() - stopStart;
  assert.equal(inspect(WORKER).State.ExitCode, 0);
  assert.ok(stopMs < GRACE_SECONDS * 1000, `stopping took ${Math.round(stopMs)} ms`);
  const events = capture(["logs", WORKER])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line).event);
  for (const event of ["worker_starting", "worker_ready", "signal", "worker_stopped"]) {
    assert.ok(events.includes(event), `no ${event} in ${events.join(", ")}`);
  }
  console.log("worker container check passed");
} catch (error) {
  // The containers' own logs say why one never became ready.
  for (const name of [WORKER, POSTGRES]) {
    try {
      run(["logs", "--timestamps", name]);
    } catch {
      // Never started.
    }
  }
  throw error;
} finally {
  removeAll();
  try {
    execFileSync("docker", ["image", "rm", "--force", IMAGE], { stdio: "ignore" });
  } catch {
    // Never built.
  }
  rmSync(dir, { recursive: true, force: true });
}
