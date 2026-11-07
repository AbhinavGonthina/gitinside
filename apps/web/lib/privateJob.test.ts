// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { analyze } from "@gitinside/analyzer";
import {
  analyses,
  findPublishedAnalysis,
  installations,
  repos,
  upsertInstallation,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { stringifyGraph } from "@gitinside/schema";
import {
  createAnalysisRecorder,
  createRunServer,
  createTokenClient,
  type JobDeps,
  type ObjectStore,
  type PutObjectOptions,
} from "@gitinside/worker";
import { derivedSecret, TOKEN_REQUEST_PURPOSE } from "@gitinside/worker/hmac";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { enqueueAnalysis, type QueueRepo } from "./enqueue";
import { fakeApp, type FakeApp } from "./githubApp.testkit";
import { handleGraphRequest } from "./graphRoute";
import { handleTokenRequest } from "./installationTokenRoute";
import { createLocalTaskQueue, type LocalTaskEvent } from "./localTasks";

/**
 * A private repo from enqueue to snapshot (M8.3c3c), with every piece of our own real: the
 * website's `enqueueAnalysis` queues the job, the local task queue pushes it signed to the
 * worker's `POST /run`, the worker's token client asks the website's token route, which mints
 * through a fake GitHub App, and the worker reads the repo's facts and tarball with that token,
 * analyzes it (in-process here, not in the sandboxed child), and publishes the snapshot. Only
 * GitHub and the bucket are fakes.
 */

const SECRET = "w".repeat(43);
const VERSION = "0.1.0";
const SHA = "b".repeat(40);
const INSTALLATION = 41;
const WORKER_TOKEN = "ghp_workers_own";
const SOURCE = {
  "package.json": '{"name":"shop"}\n',
  "src/index.ts": "export function hello() {}\n",
};

const REPO: QueueRepo = {
  providerRepoId: 3_000_000_041,
  owner: "acme",
  name: "shop",
  visibility: "private",
  installationId: INSTALLATION,
  defaultBranch: "main",
  sha: SHA,
};

/** One ustar header block plus its padded body. */
function tarEntry(name: string, body: Buffer, type: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  const octal = (offset: number, length: number, value: number) =>
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "latin1");
  header.write(name, 0, 100, "utf8");
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, body.length);
  octal(136, 12, 0);
  header.write(type, 156, 1, "latin1");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

/** A gzipped tarball of `files` under GitHub's top folder, as `GET …/tarball/{sha}` serves. */
function tarball(files: Record<string, string>): Buffer {
  const top = "acme-shop-bbbbbbb";
  const folders = new Set<string>([`${top}/`]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/").slice(0, -1);
    parts.forEach((_, i) => folders.add(`${top}/${parts.slice(0, i + 1).join("/")}/`));
  }
  return gzipSync(
    Buffer.concat([
      ...[...folders].map((folder) => tarEntry(folder, Buffer.alloc(0), "5")),
      ...Object.entries(files).map(([path, text]) =>
        tarEntry(`${top}/${path}`, Buffer.from(text), "0"),
      ),
      Buffer.alloc(1024),
    ]),
  );
}

/** The repo's API answers: facts and the tarball, only to the newest token the app issued. */
function fakeRepoApi(app: FakeApp, seen: string[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const authorization = request.headers.get("authorization") ?? "";
    seen.push(`${new URL(request.url).pathname} ${authorization}`);
    if (authorization !== `Bearer ${app.issued.at(-1)?.token ?? "none"}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const path = new URL(request.url).pathname;
    if (path === "/repos/acme/shop") {
      return Response.json({
        id: REPO.providerRepoId,
        name: "shop",
        owner: { login: "acme" },
        private: true,
        default_branch: "main",
      });
    }
    if (path === `/repos/acme/shop/tarball/${SHA}`) {
      return new Response(tarball(SOURCE), { headers: { "content-type": "application/x-gzip" } });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

/** A bucket in memory, recording each put's options and every read. */
function memoryStore() {
  const objects = new Map<string, { body: Uint8Array; options: PutObjectOptions }>();
  const reads: string[] = [];
  const store: ObjectStore = {
    async put(key, body, options) {
      objects.set(key, { body, options });
    },
    async get(key) {
      reads.push(key);
      const object = objects.get(key);
      if (object === undefined) return undefined;
      // As `fetch` reads the stored gzip: decoded.
      return { body: new Response(gunzipSync(object.body)).body!, contentType: "application/json" };
    },
    async *list() {
      yield* [];
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { store, objects, reads };
}

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(analyses);
  await t.db.delete(repos);
  await t.db.delete(installations);
  await upsertInstallation(t.db, {
    githubInstallationId: INSTALLATION,
    accountId: 9001,
    accountLogin: "acme",
    accountType: "Organization",
    suspendedAt: null,
  });
  // The token route logs each outcome; keep the output quiet.
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  onTestFinished(() => log.mockRestore());
});

/** Start the worker's real `POST /run` on loopback, wired to the website's token route. */
async function startWorker(app: FakeApp, githubSeen: string[]) {
  const root = await mkdtemp(join(tmpdir(), "gitinside-private-job-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bucket = memoryStore();
  const github = { apiBase: "https://api.github.test", fetch: fakeRepoApi(app, githubSeen) };
  const recorder = createAnalysisRecorder({
    db: t.db,
    store: bucket.store,
    analyzerVersion: VERSION,
    github: { ...github, token: WORKER_TOKEN },
  });
  const tokenDeps = {
    db: t.db,
    app: { appId: app.appId, privateKey: app.privateKey, fetch: app.fetch },
    keys: [derivedSecret(SECRET, TOKEN_REQUEST_PURPOSE)],
  };
  const website = "https://gitinside.test";
  const installationToken = createTokenClient({
    origin: website,
    secrets: [SECRET],
    // The website's route itself, called in-process at the URL the client asks.
    fetch: async (input, init) => handleTokenRequest(new Request(input, init), tokenDeps),
  });
  const graphs: string[] = [];
  const run: NonNullable<JobDeps["run"]> = async (job) => {
    const text = stringifyGraph(
      await analyze(job.src, { owner: job.owner, name: job.name, sha: SHA }),
    );
    await writeFile(job.out, text);
    graphs.push(text);
    return {
      ok: true,
      stats: {
        files: 1,
        nodes: 1,
        edges: 0,
        unresolved: 0,
        warnings: 0,
        graphBytes: 1,
        stageMs: {},
      },
      durationMs: 1,
    };
  };
  const server = createRunServer({
    deps: {
      jobsRoot: join(root, "jobs"),
      recorder,
      publish: recorder.publish,
      download: { ...github, token: WORKER_TOKEN },
      installationToken,
      run,
    },
    secrets: [SECRET],
    analyzerVersion: VERSION,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const events: LocalTaskEvent[] = [];
  const queue = createLocalTaskQueue({
    workerUrl: `http://127.0.0.1:${port}`,
    secret: SECRET,
    backoffMs: () => 0,
    log: (event) => events.push(event),
  });
  return { queue, events, bucket, graphs };
}

describe("a private job from enqueue to snapshot", () => {
  it("stores the graph under its installation, private, and the public routes never read it", async () => {
    const app = fakeApp([{ id: INSTALLATION, owner: "acme", repos: ["shop"] }]);
    const githubSeen: string[] = [];
    const { queue, events, bucket, graphs } = await startWorker(app, githubSeen);

    const queued = await enqueueAnalysis(REPO, { db: t.db, queue, analyzerVersion: VERSION });
    expect(queued).toMatchObject({ status: "queued", entered: true });
    await queue.idle();
    expect(events).toMatchObject([{ event: "local_task_delivered", attempt: 1, status: 200 }]);

    // One token, for this repo only, and GitHub read with it, never the worker's own.
    expect(app.issued).toEqual([
      { token: expect.any(String) as string, installationId: INSTALLATION, repos: ["shop"] },
    ]);
    const token = app.issued[0]!.token;
    expect(githubSeen).toEqual([
      `/repos/acme/shop Bearer ${token}`,
      `/repos/acme/shop/tarball/${SHA} Bearer ${token}`,
    ]);

    // The row is done, under the private key, for the repo linked to the installation.
    const [repo] = await t.db.select().from(repos);
    const [installation] = await t.db.select().from(installations);
    expect(repo).toMatchObject({ visibility: "private", installationId: installation?.id });
    const key = `private/${INSTALLATION}/${repo!.id}/${SHA}/${VERSION}.json.gz`;
    const [row] = await t.db.select().from(analyses);
    expect(row).toMatchObject({ status: "done", sha: SHA, snapshotKey: key });
    if (queued.status !== "queued") throw new Error("not queued");
    expect(row?.jobId).toBe(queued.jobId);

    // The bucket holds that one object, never cached publicly, and it reads back as the graph.
    expect([...bucket.objects.keys()]).toEqual([key]);
    expect(bucket.objects.get(key)?.options).toMatchObject({
      cacheControl: "private, no-store",
      contentEncoding: "gzip",
    });
    const stored = await bucket.store.get(row!.snapshotKey!);
    const text = await new Response(stored?.body).text();
    expect(text).toBe(graphs[0]);
    expect(text).toContain("src/index.ts");
    expect(JSON.parse(text)).toMatchObject({ repo: { owner: "acme", name: "shop", sha: SHA } });

    // Nothing public finds it: no published analysis, and the graph route answers 404 without
    // reading the bucket (per-view access to private graphs is M8.4's).
    bucket.reads.length = 0;
    expect(await findPublishedAnalysis(t.db, { owner: "acme", name: "shop", sha: SHA })).toBe(
      undefined,
    );
    const response = await handleGraphRequest(
      { owner: "acme", repo: "shop", sha: SHA },
      { db: t.db, store: bucket.store },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bucket.reads).toEqual([]);
  }, 60_000);

  it("names a refusal on the row and stores nothing when the installation no longer covers the repo", async () => {
    // Linked at enqueue, but the installation was narrowed on GitHub before the job ran.
    const app = fakeApp([{ id: INSTALLATION, owner: "acme", repos: ["other"] }]);
    const githubSeen: string[] = [];
    const { queue, bucket } = await startWorker(app, githubSeen);

    await enqueueAnalysis(REPO, { db: t.db, queue, analyzerVersion: VERSION });
    await queue.idle();

    expect(app.issued).toEqual([]);
    expect(githubSeen).toEqual([]);
    expect(bucket.objects.size).toBe(0);
    const [row] = await t.db.select().from(analyses);
    expect(row).toMatchObject({ status: "failed", errorCode: "REPO_NOT_INSTALLED" });
  }, 60_000);
});
