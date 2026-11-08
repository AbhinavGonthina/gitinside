/**
 * The signed-in E2E server's fake GitHub (M8.2c): the unit tests' fake
 * (`lib/githubOAuth.testkit.ts`) served over HTTP on a loopback port, which the site reaches
 * through `GITHUB_FAKE_ORIGIN`. The browser still goes to github.com's authorize page; the test
 * answers that page itself, asking this server for a code with `GET /_approve?url=<authorize
 * URL>&login=<account>`. `POST /_fail` makes the next GitHub call answer 502.
 *
 * `octo` sees two installations; any other login sees none (the dashboard's empty state), so
 * GitHub refuses it the private repos.
 *
 * Run by Playwright as a web server (`playwright.config.ts`), which waits for the "listening"
 * line.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeOAuth } from "../lib/githubOAuth.testkit.ts";
import { E2E_PRIVATE, E2E_SHA } from "./fixture.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) throw new Error("usage: github.ts <port>");

/**
 * Storefront's files at its analyzed commit: fixtures/shop-demo's, as its diagram is that
 * fixture's graph (dashboard.e2e.ts), for the private code preview (M8.4c3).
 */
const SHOP_DEMO = fileURLToPath(new URL("../../../fixtures/shop-demo/", import.meta.url));
function storefrontFile(path: string, ref: string): string | undefined {
  if (ref !== E2E_SHA || path.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return undefined;
  }
  try {
    return readFileSync(join(SHOP_DEMO, path), "utf8");
  } catch {
    return undefined;
  }
}

const github = fakeOAuth();
const OCTO = { id: 3_000_000_007, login: "octo" };
github.install(OCTO, [
  {
    id: E2E_PRIVATE.installationId,
    account: { login: "acme", type: "Organization" },
    selection: "selected",
    // The private repos the site has analyses of (database.ts), by GitHub's ID, each with the
    // head the site holds, so their pages are up to date and queue nothing.
    repos: [
      {
        owner: "acme",
        name: "storefront",
        private: true,
        id: E2E_PRIVATE.storefront.id,
        sha: E2E_SHA,
        file: storefrontFile,
      },
      { owner: "acme", name: "api" },
      {
        owner: "acme",
        name: "billing-service",
        private: true,
        id: E2E_PRIVATE.billing.id,
        sha: E2E_PRIVATE.billing.sha,
      },
    ],
  },
  {
    id: 7,
    account: { login: "octo", type: "User" },
    repos: [
      { owner: "octo", name: "dotfiles" },
      { owner: "octo", name: "side-project", private: true },
    ],
  },
]);

const accounts = new Map([[OCTO.login, OCTO]]);
let nextId = 3_000_000_100;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      let response: Response;
      if (url.pathname === "/_approve") {
        const login = url.searchParams.get("login") ?? OCTO.login;
        const account = accounts.get(login) ?? { id: nextId++, login };
        accounts.set(login, account);
        response = new Response(github.approve(url.searchParams.get("url") ?? "", account));
      } else if (url.pathname === "/_fail" && req.method === "POST") {
        github.failNext(Response.json({ message: "Server Error" }, { status: 502 }));
        response = new Response("ok");
      } else {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          const hop = name === "host" || name === "connection" || name === "content-length";
          if (typeof value === "string" && !hop) headers.set(name, value);
        }
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        response = await github.fetch(`https://api.github.com${url.pathname}${url.search}`, {
          method: req.method ?? "GET",
          headers,
          ...(body !== undefined && { body }),
        });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`listening fake GitHub on http://127.0.0.1:${port}`);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
