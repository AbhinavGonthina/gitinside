#!/usr/bin/env node
import { runMain } from "./main.js";

/** The worker container's command: `node dist/bin.js` (main.ts, ADR-0065). */
await runMain({
  env: process.env,
  write: (line) => void process.stdout.write(line),
  onSignal: (signals, handler) => {
    for (const signal of signals) process.on(signal, handler);
  },
  exit: (code) => process.exit(code),
});
