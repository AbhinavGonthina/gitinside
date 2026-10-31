// A stand-in for child.js that runner.test.ts starts inside the same sandbox (heap cap,
// permission model, empty env, network guard). `job.owner` picks the behavior; `job.name`
// carries its argument. Probes answer with `{ ok: false, code: "PROBE", message: <JSON> }`.
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import { promises as dnsPromises } from "node:dns";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { connect } from "node:net";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const job = JSON.parse(process.argv[2]);

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function probe(findings) {
  report({ ok: false, code: "PROBE", message: JSON.stringify(findings) });
}

/** The error code an attempt fails with, or "ALLOWED" if it didn't throw. */
async function attempt(run) {
  try {
    await run();
    return "ALLOWED";
  } catch (error) {
    return error.code ?? error.name;
  }
}

switch (job.owner) {
  case "spin":
    for (;;) {
      // Synchronous work that never yields: only SIGKILL stops it.
    }
  case "hog": {
    const keep = [];
    for (;;) keep.push(new Array(100_000).fill(keep.length));
  }
  case "crash":
    throw new Error("boom");
  case "silent":
    break;
  case "noisy":
    process.stdout.write("x".repeat(200 * 1024));
    report({ ok: false, code: "LIMIT_FILES", message: "after noise" });
    break;
  case "lie":
    report({
      ok: true,
      stats: { nodes: 1, edges: 0, unresolved: 0, warnings: 0, graphBytes: 999, stageMs: {} },
    });
    break;
  case "known":
    report({ ok: false, code: "LIMIT_FILES", message: "LIMIT_FILES: too many files" });
    break;
  case "steps":
    // Progress lines, one split across two writes, then the report.
    report({ progress: { step: "inventory" } });
    process.stdout.write('{"progress":{"step":"prog');
    await new Promise((done) => setTimeout(done, 50));
    process.stdout.write('rams","count":1204}}\n');
    report({ progress: { step: "http", count: 87 } });
    report({ ok: false, code: "LIMIT_FILES", message: "LIMIT_FILES: too many files" });
    break;
  case "found":
    // Found lines between progress lines, then the report.
    report({ progress: { step: "workspace" } });
    report({ found: { services: { count: 2, names: ["api", "web"] } } });
    report({ progress: { step: "programs", count: 3 } });
    report({ found: { services: { count: 2, names: ["api", "web"] }, routes: 12 } });
    report({ ok: false, code: "LIMIT_FILES", message: "LIMIT_FILES: too many files" });
    break;
  case "after":
    report({ ok: false, code: "LIMIT_FILES", message: "LIMIT_FILES: too many files" });
    report({ progress: { step: "assemble" } });
    break;
  case "twice":
    report({ ok: false, code: "LIMIT_FILES", message: "first" });
    report({ ok: false, code: "LIMIT_FILES", message: "second" });
    break;
  case "unterminated":
    process.stdout.write(JSON.stringify({ ok: false, code: "LIMIT_FILES", message: "m" }));
    break;
  case "network": {
    const port = Number(job.name);
    probe({
      netConnect: await attempt(() => connect({ host: "127.0.0.1", port })),
      socketConnect: await attempt(() => new net.Socket().connect(port, "127.0.0.1")),
      httpGet: await attempt(() => http.get(`http://127.0.0.1:${port}/`)),
      fetch: await attempt(() => fetch(`http://127.0.0.1:${port}/`)),
      dnsLookup: await attempt(() => dnsPromises.lookup("localhost")),
      listen: await attempt(() => net.createServer().listen(0)),
      udp: await attempt(() => dgram.createSocket("udp4")),
    });
    break;
  }
  case "sandbox":
    probe({
      readSecret: await attempt(() => readFileSync(job.name, "utf8")),
      writeSrc: await attempt(() => writeFileSync(join(job.src, "planted.txt"), "x")),
      writeOut: await attempt(() => writeFileSync(job.out, "{}")),
      spawn: await attempt(() => {
        const result = spawnSync(process.execPath, ["-e", ""]);
        if (result.error) throw result.error;
      }),
      worker: await attempt(() => new Worker("0", { eval: true })),
      env: Object.keys(process.env).sort(),
      heapFlag: process.execArgv.find((flag) => flag.startsWith("--max-old-space-size")),
    });
    break;
  default:
    throw new Error(`unknown probe ${job.owner}`);
}
