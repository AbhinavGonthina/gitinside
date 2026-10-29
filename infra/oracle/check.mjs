#!/usr/bin/env node
/**
 * CI's check of the production worker container (docs/SECURITY.md §3, ADR-0074). Run from
 * the repo root on a Linux machine with Docker Compose v2:
 *
 *   node infra/oracle/check.mjs
 *
 * It builds the image through infra/oracle/compose.yml (plus compose.check.yml's throwaway
 * Postgres), writes a fake env file (no real secret exists in CI), applies the migrations
 * from inside the image, starts the stack, and checks:
 * - the worker answers `GET /health` on 127.0.0.1:8080, and the port is bound to loopback only;
 * - Redis publishes no port and sits only on the `internal: true` network;
 * - inside the worker: uid 1000, no capabilities, no-new-privileges, seccomp filtering, the
 *   root filesystem read-only (`/`, `/app`, `/tmp`), `/tmp/jobs` a writable noexec tmpfs,
 *   and no npm/npx/corepack;
 * - a fixture tarball extracted and analyzed in the image by the real sandboxed child gives
 *   the golden graph byte for byte (the image layout keeps the child's read root at /app);
 * - SIGTERM stops the worker cleanly (exit 0) and every log line is JSON.
 * The stack and its volumes are removed at the end, pass or fail.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES = ["-f", "infra/oracle/compose.yml", "-f", "infra/oracle/compose.check.yml"];
const FIXTURE = "fixtures/express-basic";

const dir = mkdtempSync(join(tmpdir(), "gitinside-check-"));
const envFile = join(dir, "worker.env");
writeFileSync(
  envFile,
  [
    "DATABASE_URL=postgres://gitinside:gitinside@postgres:5432/gitinside",
    `R2_ACCOUNT_ID=${"0".repeat(32)}`,
    "R2_ACCESS_KEY_ID=check",
    "R2_SECRET_ACCESS_KEY=check",
    "R2_BUCKET=gitinside-check",
    `ENQUEUE_HMAC_SECRET=${randomBytes(32).toString("hex")}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
const env = { ...process.env, WORKER_ENV_FILE: envFile };

/** `docker compose …` with output shown (builds, startup). */
function run(args) {
  execFileSync("docker", ["compose", ...FILES, ...args], { env, stdio: "inherit" });
}

/** `docker compose …` returning stdout; `input` goes to the command's stdin. */
function capture(args, input) {
  return execFileSync("docker", ["compose", ...FILES, ...args], {
    env,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** `docker inspect` of one service's container, running or stopped. */
function inspect(service) {
  const id = capture(["ps", "--all", "-q", service]).trim();
  assert.ok(id !== "", `${service} has no container`);
  const [details] = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8" }));
  return details;
}

/** Run a Node ES module inside the worker container and parse the JSON it prints. */
function inWorker(script, input) {
  return JSON.parse(
    capture(["exec", "-T", "worker", "node", "--input-type=module", "-e", script], input),
  );
}

const MIGRATE = `
import { runMigrations } from "@gitinside/db";
await runMigrations(process.env.DATABASE_URL);
`;

const PROBE = `
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const field = (status, name) => status.match(new RegExp("^" + name + ":\\\\s*(.*)$", "m"))?.[1];
const describe = (pid) => {
  const status = readFileSync("/proc/" + pid + "/status", "utf8");
  return {
    uid: field(status, "Uid"),
    capEff: field(status, "CapEff"),
    capPrm: field(status, "CapPrm"),
    noNewPrivs: field(status, "NoNewPrivs"),
    seccomp: field(status, "Seccomp"),
  };
};
const workerPid = readdirSync("/proc").find(
  (pid) => /^[0-9]+$/.test(pid) &&
    readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").includes("dist/bin.js"),
);
const writes = {};
for (const path of ["/probe", "/app/probe", "/tmp/probe", "/tmp/jobs/probe"]) {
  try {
    writeFileSync(path, "x");
    rmSync(path);
    writes[path] = "ok";
  } catch (error) {
    writes[path] = error.code;
  }
}
const jobsMount = readFileSync("/proc/mounts", "utf8").split("\\n").find((line) => line.split(" ")[1] === "/tmp/jobs");
console.log(JSON.stringify({
  self: describe("self"),
  worker: workerPid === undefined ? null : describe(workerPid),
  writes,
  jobsMount: jobsMount ?? null,
  tools: ["/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack", "/usr/local/bin/yarn"].filter(existsSync),
}));
`;

const ANALYZE = `
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { extractTarball } from "./dist/extract.js";
import { runAnalysis } from "./dist/runner.js";
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

try {
  run(["build"]);
  run(["up", "-d", "--wait", "redis", "postgres"]);
  run(["run", "--rm", "--no-deps", "-T", "worker", "node", "--input-type=module", "-e", MIGRATE]);
  run(["up", "-d", "--wait", "worker"]);

  // Outside: health on loopback, published ports, networks.
  const health = await fetch("http://127.0.0.1:8080/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const worker = inspect("worker");
  assert.equal(worker.Config.User, "1000:1000");
  assert.equal(worker.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(worker.HostConfig.CapDrop, ["ALL"]);
  assert.ok(worker.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.ok(!worker.HostConfig.SecurityOpt.some((option) => option.includes("unconfined")));
  assert.deepEqual(worker.HostConfig.PortBindings, {
    "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
  });

  const redis = inspect("redis");
  assert.deepEqual(Object.keys(redis.HostConfig.PortBindings ?? {}), []);
  assert.deepEqual(Object.keys(redis.NetworkSettings.Networks), ["gitinside_internal"]);
  const [internal] = JSON.parse(
    execFileSync("docker", ["network", "inspect", "gitinside_internal"], { encoding: "utf8" }),
  );
  assert.equal(internal.Internal, true);

  // Inside: the worker process and a process started next to it.
  const probe = inWorker(PROBE);
  assert.ok(probe.worker !== null, "the worker process was not found");
  for (const status of [probe.self, probe.worker]) {
    assert.match(status.uid, /^1000\s+1000\s+1000\s+1000$/);
    assert.equal(status.capEff, "0000000000000000");
    assert.equal(status.capPrm, "0000000000000000");
    assert.equal(status.noNewPrivs, "1");
    assert.equal(status.seccomp, "2");
  }
  assert.deepEqual(probe.writes, {
    "/probe": "EROFS",
    "/app/probe": "EROFS",
    "/tmp/probe": "EROFS",
    "/tmp/jobs/probe": "ok",
  });
  assert.ok(probe.jobsMount?.startsWith("tmpfs /tmp/jobs tmpfs "), probe.jobsMount);
  for (const option of ["nosuid", "nodev", "noexec"]) {
    assert.ok(probe.jobsMount.split(" ")[3].split(",").includes(option), probe.jobsMount);
  }
  assert.deepEqual(probe.tools, []);

  // The real pipeline in the image: extract a tarball, analyze it in the sandboxed child.
  const tarball = execFileSync("git", ["archive", "--format=tar.gz", `HEAD:${FIXTURE}`]);
  const analysis = inWorker(ANALYZE, tarball);
  assert.equal(analysis.result.ok, true, JSON.stringify(analysis.result));
  assert.equal(analysis.graph, readFileSync(join(FIXTURE, "expected.json"), "utf8"));

  // SIGTERM: a clean stop, and JSON logs throughout.
  run(["stop", "worker"]);
  assert.equal(inspect("worker").State.ExitCode, 0);
  const events = capture(["logs", "--no-color", "--no-log-prefix", "worker"])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line).event);
  for (const event of ["worker_starting", "worker_ready", "worker_stopping", "worker_stopped"]) {
    assert.ok(events.includes(event), `no ${event} in ${events.join(", ")}`);
  }
  console.log("worker container check passed");
} finally {
  run(["down", "--volumes", "--remove-orphans"]);
  rmSync(dir, { recursive: true, force: true });
}
