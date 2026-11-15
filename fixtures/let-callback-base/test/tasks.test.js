import { after, before, test } from "node:test";
import app from "../src/app.js";

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server.close());

test("lists tasks", async () => {
  await fetch(`${baseUrl}/api/v1/tasks`);
});

test("creates a task", async () => {
  await fetch(`${baseUrl}/api/v1/tasks`, { method: "POST" });
});

test("reads a task", async () => {
  await fetch(`${baseUrl}/api/v1/tasks/42`);
});
