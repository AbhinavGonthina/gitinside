import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { compareStrings } from "@gitinside/schema";
import { tar, type TestEntry } from "./tar.testkit.js";

/**
 * A fake GitHub for tests: an "API" server and a "codeload" server on 127.0.0.1. By
 * default the API answers every tarball request with a 302 to codeload, and codeload
 * serves {@link FakeGitHub.tarball}. Either can be replaced per test, and every request
 * is recorded with its headers.
 */
export interface RecordedRequest {
  server: "api" | "codeload";
  url: string;
  authorization: string | undefined;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface FakeGitHub {
  apiBase: string;
  codeloadOrigin: string;
  requests: RecordedRequest[];
  /** What codeload serves by default. */
  tarball: Buffer;
  api: Handler;
  codeload: Handler;
  close(): Promise<void>;
}

async function listen(handler: Handler): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

/** Start both servers. */
export async function startFakeGitHub(tarball: Buffer = Buffer.alloc(0)): Promise<FakeGitHub> {
  const fake = { requests: [] as RecordedRequest[], tarball } as FakeGitHub;
  const record = (server: "api" | "codeload", req: IncomingMessage): void => {
    fake.requests.push({ server, url: req.url ?? "", authorization: req.headers.authorization });
  };
  const api = await listen((req, res) => {
    record("api", req);
    fake.api(req, res);
  });
  const codeload = await listen((req, res) => {
    record("codeload", req);
    fake.codeload(req, res);
  });
  fake.apiBase = api.origin;
  fake.codeloadOrigin = codeload.origin;
  fake.api = (req, res) => {
    res.writeHead(302, { location: `${codeload.origin}/download${req.url ?? ""}?token=grant` });
    res.end();
  };
  fake.codeload = (_req, res) => {
    res.writeHead(200, { "content-type": "application/x-gzip" });
    res.end(fake.tarball);
  };
  fake.close = async () => {
    for (const { server } of [api, codeload]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  return fake;
}

/** Tar entries (folders and files, sorted, repo-relative names) for the files under `dir`. */
export async function entriesOf(dir: string): Promise<TestEntry[]> {
  const entries: TestEntry[] = [];
  const walk = async (folder: string): Promise<void> => {
    const items = await readdir(folder, { withFileTypes: true });
    items.sort((a, b) => compareStrings(a.name, b.name));
    for (const item of items) {
      const path = join(folder, item.name);
      const name = relative(dir, path).split(sep).join("/");
      if (item.isDirectory()) {
        entries.push({ name: `${name}/`, type: "5" });
        await walk(path);
      } else {
        entries.push({ name, body: await readFile(path) });
      }
    }
  };
  await walk(dir);
  return entries;
}

/** A GitHub-style tarball (`<top>/` folder first) of the files under `dir`. */
export async function tarballOf(dir: string, top = "acme-shop-0123456"): Promise<Buffer> {
  return tarballFrom(await entriesOf(dir), top);
}

/** A gzipped tarball of the given entries under GitHub's top folder. */
export function tarballFrom(entries: TestEntry[], top = "acme-shop-0123456"): Buffer {
  return gzipSync(
    tar([
      { name: `${top}/`, type: "5" },
      ...entries.map((e) => ({ ...e, name: `${top}/${e.name}` })),
    ]),
  );
}
