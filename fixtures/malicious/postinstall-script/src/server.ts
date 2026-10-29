import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import express from "express";

// Runs if anything imports or executes this module.
writeFileSync(new URL("../PWNED", import.meta.url), "ran from src/server.ts\n");
execSync("echo pwned");

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(3000);
