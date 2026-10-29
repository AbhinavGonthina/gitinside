#!/usr/bin/env node
import { runQuota } from "./quota.js";

/** The quota check's command: `node dist/quota-bin.js` (quota.ts, ADR-0078). */
process.exitCode = await runQuota({
  env: process.env,
  write: (line) => void process.stdout.write(line),
});
