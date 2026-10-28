// Serves the static Storybook build (storybook-static/) for the visual
// regression run (playwright.config.ts starts it). Local files only, GET only,
// on loopback; nothing outside the build folder is ever read.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../storybook-static", import.meta.url)));
const port = Number(process.argv[2] ?? 6107);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const file = resolve(join(root, path.endsWith("/") ? `${path}index.html` : path));
  let size = -1;
  if (file.startsWith(root + sep)) {
    try {
      const stat = statSync(file);
      if (stat.isFile()) size = stat.size;
    } catch {
      // Missing file: 404 below.
    }
  }
  if (size < 0) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": size,
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1");
