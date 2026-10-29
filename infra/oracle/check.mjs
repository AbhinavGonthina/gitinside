#!/usr/bin/env node
/**
 * CI's check of the production worker stack (docs/SECURITY.md §3, ADR-0074, ADR-0075). Run
 * from the repo root on a Linux machine with Docker Compose v2, port 443 free, and internet
 * access (the egress checks reach GitHub):
 *
 *   node infra/oracle/check.mjs
 *
 * It builds the images through infra/oracle/compose.yml (plus compose.check.yml's throwaway
 * Postgres), writes a fake env file (no real secret exists in CI), applies the migrations
 * from inside the image, starts the stack with Caddy serving `localhost`, and checks:
 * - the worker answers `GET /health` on 127.0.0.1:8080, and the port is bound to loopback only;
 * - Caddy serves the API's routes over TLS on 443 and answers 404 for anything else;
 * - Redis publishes no port and sits only on the `internal: true` network;
 * - the worker runs in the egress gateway's network namespace, where only allowlisted names
 *   resolve, TCP reaches them on 443 only, and other hosts, raw IPs, the cloud metadata
 *   address, outside DNS servers, and Docker's own resolver are all refused;
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
import { request } from "node:https";
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
const env = { ...process.env, WORKER_ENV_FILE: envFile, WORKER_DOMAIN: "localhost" };

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

/** A request to Caddy on 127.0.0.1:443 as `https://localhost`, trusting only `ca`. */
function viaCaddy(method, path, ca) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: 443,
        servername: "localhost",
        method,
        path,
        ca,
        headers: { host: "localhost" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

/** Caddy's local root certificate, once it has issued one for `localhost` (≤ 30 s). */
async function caddyRoot() {
  for (let attempt = 0; ; attempt++) {
    try {
      return capture(["exec", "-T", "caddy", "cat", "/data/caddy/pki/authorities/local/root.crt"]);
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
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

// Run as the worker (uid 1000) in its network namespace. Each attempt gives "connected",
// "timeout", an array of addresses, or the error code.
const EGRESS = `
import { lookup, Resolver } from "node:dns/promises";
import { connect } from "node:net";
const tcp = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port, timeout: 5000 });
  socket.on("connect", () => { socket.destroy(); resolve("connected"); });
  socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
  socket.on("error", (error) => resolve(error.code));
});
const dns = async (server, name) => {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers([server]);
  try { return await resolver.resolve4(name); } catch (error) { return error.code; }
};
const host = async (name) => {
  try { return (await lookup(name, { all: true })).map((a) => a.family); } catch (error) { return error.code; }
};
console.log(JSON.stringify({
  githubName: await host("api.github.com"),
  github443: await tcp("api.github.com", 443),
  codeload443: await tcp("codeload.github.com", 443),
  github80: await tcp("api.github.com", 80),
  otherName: await host("example.com"),
  rawIp: await tcp("1.1.1.1", 443),
  metadata: await tcp("169.254.169.254", 80),
  outsideDns: await dns("1.1.1.1", "example.com"),
  dockerDns: await dns("127.0.0.11", "example.com"),
  redis: await tcp("redis", 6379),
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
  run(["up", "-d", "--wait", "egress", "redis", "postgres"]);
  run(["run", "--rm", "--no-deps", "-T", "worker", "node", "--input-type=module", "-e", MIGRATE]);
  run(["up", "-d", "--wait", "worker", "caddy"]);

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
  const egress = inspect("egress");
  assert.equal(worker.HostConfig.NetworkMode, `container:${egress.Id}`);
  assert.deepEqual(Object.keys(worker.HostConfig.PortBindings ?? {}), []);

  assert.equal(egress.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(egress.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(egress.HostConfig.CapAdd.map((cap) => cap.replace(/^CAP_/, "")).sort(), [
    "NET_ADMIN",
    "NET_BIND_SERVICE",
  ]);
  assert.ok(egress.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.deepEqual(egress.HostConfig.PortBindings, {
    "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
  });
  assert.deepEqual(Object.keys(egress.NetworkSettings.Networks).sort(), [
    "gitinside_internal",
    "gitinside_outside",
  ]);

  const caddy = inspect("caddy");
  assert.equal(caddy.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(caddy.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(Object.keys(caddy.HostConfig.PortBindings), ["443/tcp"]);
  assert.deepEqual(Object.keys(caddy.NetworkSettings.Networks), ["gitinside_outside"]);

  // Caddy: TLS on 443, the API's routes passed through unchanged, nothing else.
  const ca = await caddyRoot();
  const tlsHealth = await viaCaddy("GET", "/health", ca);
  assert.equal(tlsHealth.status, 200, tlsHealth.body);
  assert.deepEqual(JSON.parse(tlsHealth.body), { status: "ok" });
  const unsigned = await viaCaddy("POST", "/enqueue", ca);
  assert.equal(unsigned.status, 401, unsigned.body);
  assert.ok("error" in JSON.parse(unsigned.body), unsigned.body);
  for (const path of ["/", "/metrics", "/enqueuex", "/health/x"]) {
    assert.equal((await viaCaddy("GET", path, ca)).status, 404, path);
  }

  // The egress allowlist, as the worker sees it.
  const reach = inWorker(EGRESS);
  // IPv4 only: the gateway drops AAAA answers.
  assert.ok(
    Array.isArray(reach.githubName) && reach.githubName.every((family) => family === 4),
    JSON.stringify(reach),
  );
  assert.deepEqual(
    { github443: reach.github443, codeload443: reach.codeload443, redis: reach.redis },
    { github443: "connected", codeload443: "connected", redis: "connected" },
    JSON.stringify(reach),
  );
  assert.equal(reach.otherName, "ENOTFOUND", JSON.stringify(reach));
  for (const key of ["github80", "rawIp", "metadata"]) {
    assert.equal(reach[key], "ECONNREFUSED", `${key}: ${JSON.stringify(reach)}`);
  }
  for (const key of ["outsideDns", "dockerDns"]) {
    assert.equal(typeof reach[key], "string", `${key}: ${JSON.stringify(reach)}`);
  }

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
