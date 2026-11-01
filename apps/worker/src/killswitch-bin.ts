#!/usr/bin/env node
import { runKillSwitch } from "./killswitch.js";

/** The kill switch service's command: `node dist/killswitch-bin.js` (killswitch.ts, ADR-0169). */
await runKillSwitch({
  env: process.env,
  write: (line) => void process.stdout.write(line),
  onSignal: (signals, handler) => {
    for (const signal of signals) process.on(signal, handler);
  },
  exit: (code) => process.exit(code),
});
