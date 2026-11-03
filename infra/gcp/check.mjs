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
 * network, left empty: the worker applies the migrations at startup (ADR-0192). No Redis and no egress gateway: the queue is Cloud Tasks (ADR-0148), and on Cloud
 * Run the analysis child's own guards are its network boundary (ADR-0152). It checks:
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
 * - the fact cache (ADR-0178): two jobs on a workspace fixture, each in its own job folder,
 *   share `/tmp/cache/public` through the sandboxed child. The first misses and stores every
 *   service, the second hits every one with the same bytes (the golden graph), the folder's
 *   entries belong to uid 1000, and it holds no more than the job's cap;
 * - SIGTERM as PID 1 (no init) stops it with exit 0 within Cloud Run's 10 s grace, and
 *   every log line is JSON;
 * - the billing kill switch, started from the same image with `killswitch.json`'s command,
 *   args, and variables: health on `PORT`, an under-budget push acknowledged (204), and a
 *   clean SIGTERM stop.
 * The containers, network, and image are removed at the end, pass or fail.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip } from "node:zlib";

const IMAGE = "gitinside-worker:check";
const NETWORK = "gitinside-check";
const POSTGRES = "gitinside-check-postgres";
const WORKER = "gitinside-check-worker";
const KILLSWITCH = "gitinside-check-killswitch";
// Not 8080, so the check fails if the worker ignores Cloud Run's PORT.
const PORT = "9090";
const FIXTURE = "fixtures/express-basic";
// Several services, so a warm job reuses more than one cache entry.
const CACHE_FIXTURE = "fixtures/pnpm-monorepo";
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

/**
 * The image's size gzipped, about what the registry stores (it keeps each layer gzipped):
 * `docker image save` streamed through gzip, never held in memory.
 */
async function compressedBytes(image) {
  const save = spawn("docker", ["image", "save", image], { stdio: ["ignore", "pipe", "inherit"] });
  const gzip = createGzip();
  let bytes = 0;
  gzip.on("data", (chunk) => {
    bytes += chunk.length;
  });
  const [code] = await Promise.all([
    new Promise((resolve, reject) => {
      save.on("error", reject);
      save.on("close", resolve);
    }),
    new Promise((resolve, reject) => {
      gzip.on("error", reject);
      gzip.on("end", resolve);
      save.stdout.pipe(gzip);
    }),
  ]);
  assert.equal(code, 0, "docker image save failed");
  return bytes;
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

// Two jobs as job.ts runs them: the cache folder prepared (factcache.ts), a fresh job folder,
// the tarball extracted, the sandboxed child analyzing with the cache; then every file under
// the cache root with its owner, and its size in the in-memory filesystem's pages.
const CACHE = `
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { CONFIG_DEFAULTS } from "./dist/config.js";
import { CACHE_BLOCK_BYTES, cacheFolder, prepareCacheFolder } from "./dist/factcache.js";
import { extractTarball } from "./dist/extract.js";
import { runAnalysis } from "./dist/runner.js";
const tarball = await buffer(process.stdin);
const root = CONFIG_DEFAULTS.cacheRoot;
const runs = [];
for (let job = 0; job < 2; job++) {
  const cache = await prepareCacheFolder(root, cacheFolder(root, { visibility: "public" }));
  await mkdir("/tmp/jobs", { recursive: true });
  const dir = await mkdtemp("/tmp/jobs/cache-");
  try {
    const src = dir + "/src";
    const out = dir + "/architecture.json";
    await mkdir(src);
    await extractTarball(Readable.from([tarball]), src, { stripRoot: false });
    const result = await runAnalysis({ src, out, owner: "fixtures", name: "pnpm-monorepo", cache });
    const graph = result.ok ? await readFile(out, "utf8") : null;
    runs.push({ cache, result, graph });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const files = [];
let bytes = 0;
for (const name of (await readdir(root, { recursive: true })).sort()) {
  const info = await stat(root + "/" + name);
  files.push({ name, uid: info.uid, gid: info.gid, file: info.isFile() });
  if (info.isFile()) bytes += Math.ceil(info.size / CACHE_BLOCK_BYTES) * CACHE_BLOCK_BYTES;
}
const rootInfo = await stat(root);
console.log(JSON.stringify({
  runs,
  folders: await readdir(root),
  root: { uid: rootInfo.uid, gid: rootInfo.gid },
  files,
  bytes,
}));
`;

/** Remove the check's containers and network, ignoring what doesn't exist. */
function removeAll() {
  for (const args of [
    ["rm", "--force", "--volumes", WORKER, POSTGRES, KILLSWITCH],
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
  // Artifact Registry keeps a few versions inside its free 0.5 GB (registry.json, ADR-0170).
  const registry = JSON.parse(readFileSync("infra/gcp/registry.json", "utf8"));
  const compressed = await compressedBytes(IMAGE);
  console.log(
    `image: ${(compressed / 1e6).toFixed(1)} MB gzipped, ${(image.Size / 1e6).toFixed(1)} MB unpacked`,
  );
  assert.ok(
    compressed <= registry.maxImageMB * 1e6,
    `the image is ${(compressed / 1e6).toFixed(1)} MB gzipped, over registry.json's ${registry.maxImageMB} MB`,
  );

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

  // The worker, as Cloud Run starts it: the image's user, command, and filesystem as built.
  // The database is empty, as production's was (planning #17): the worker migrates it.
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

  // The fact cache: a second job reuses the first one's facts through the sandboxed child.
  const cached = inWorker(
    CACHE,
    execFileSync("git", ["archive", "--format=tar.gz", `HEAD:${CACHE_FIXTURE}`]),
  );
  const [cold, warm] = cached.runs;
  const expected = readFileSync(join(CACHE_FIXTURE, "expected.json"), "utf8");
  for (const run of [cold, warm]) {
    assert.equal(run.result.ok, true, JSON.stringify(run.result));
    assert.equal(run.graph, expected);
    assert.deepEqual(run.cache, { dir: "/tmp/cache/public", maxBytes: 64 * 1024 * 1024 });
  }
  const services = JSON.parse(expected).nodes.filter((node) => node.kind === "service").length;
  assert.ok(services > 1, `${CACHE_FIXTURE} has ${services} service`);
  const counts = (hits, misses, writes) => ({ hits, misses, writes, evictions: 0, errors: 0 });
  assert.deepEqual(cold.result.stats.cache, counts(0, services, services));
  assert.deepEqual(warm.result.stats.cache, counts(services, 0, 0));
  assert.deepEqual(cached.folders, ["public"]);
  assert.deepEqual(cached.root, { uid: 1000, gid: 1000 });
  assert.ok(
    cached.files.filter((file) => file.file).length >= services,
    JSON.stringify(cached.files),
  );
  for (const file of cached.files) {
    assert.equal(file.uid, 1000, `${file.name} is owned by uid ${file.uid}`);
    assert.equal(file.gid, 1000, `${file.name} is owned by gid ${file.gid}`);
  }
  assert.ok(cached.bytes > 0 && cached.bytes <= warm.cache.maxBytes, `${cached.bytes} bytes`);
  console.log(
    `fact cache: ${services} services, ${cached.files.length} paths, ${cached.bytes} bytes`,
  );

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
  for (const event of [
    "worker_starting",
    "migrations_applied",
    "worker_ready",
    "signal",
    "worker_stopped",
  ]) {
    assert.ok(events.includes(event), `no ${event} in ${events.join(", ")}`);
  }

  // The billing kill switch: the same image with killswitch.json's command (ADR-0169).
  const killSwitch = JSON.parse(readFileSync("infra/gcp/killswitch.json", "utf8")).spec.template
    .spec.containers[0];
  run([
    "run",
    "--detach",
    "--name",
    KILLSWITCH,
    "--publish",
    `127.0.0.1:${PORT}:${PORT}`,
    "--env",
    `PORT=${PORT}`,
    ...killSwitch.env.flatMap((variable) => ["--env", `${variable.name}=${variable.value}`]),
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--entrypoint",
    killSwitch.command[0],
    IMAGE,
    ...killSwitch.args,
  ]);
  await waitFor("the kill switch", 30, async () => {
    const state = inspect(KILLSWITCH).State;
    if (!state.Running) throw new Error(`the kill switch exited (${state.ExitCode})`);
    try {
      return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
    } catch {
      return false;
    }
  });
  // Under budget: acknowledged without asking Google (there is no metadata server here).
  const data = Buffer.from(JSON.stringify({ costAmount: 0, budgetAmount: 1 })).toString("base64");
  const push = await fetch(`http://127.0.0.1:${PORT}/budget`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { data } }),
  });
  assert.equal(push.status, 204);
  run(["stop", "--timeout", String(GRACE_SECONDS), KILLSWITCH]);
  assert.equal(inspect(KILLSWITCH).State.ExitCode, 0);
  const switchEvents = capture(["logs", KILLSWITCH])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line).event);
  assert.deepEqual(switchEvents, ["killswitch_ready", "budget_under"]);
  console.log("worker container check passed");
} catch (error) {
  // The containers' own logs say why one never became ready.
  for (const name of [WORKER, POSTGRES, KILLSWITCH]) {
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
