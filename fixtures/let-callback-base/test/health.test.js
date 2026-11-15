import { before, test } from "node:test";
import app from "../src/app.js";

// Written in two callbacks: which one ran last is only known at runtime.
let origin;
// Written once, but at the top level, not in a callback.
let host;
host = "http://localhost:4300";

before(() => {
  const server = app.listen(0, () => {
    origin = `http://localhost:${server.address().port}`;
  });
  server.on("listening", () => {
    origin = "http://localhost:4400";
  });
});

test("answers health", async () => {
  await fetch(`${origin}/api/v1/health`);
});

test("answers version", async () => {
  await fetch(`${host}/api/v1/version`);
});
