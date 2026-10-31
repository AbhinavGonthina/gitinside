/**
 * The seeded E2E server's database (M4b.14a): PGlite (Postgres compiled to WebAssembly) in
 * memory, served on a local port over Postgres's wire protocol, so `next start` connects to it
 * with a plain `DATABASE_URL` as it does to Neon, and no Docker or Postgres install is needed.
 * Migrated with the real migrations, then seeded with one finished analysis of
 * `fixtures/shop-demo` at {@link E2E_SHA}. The browser's graph and code requests are answered by
 * the tests themselves (`explorer.e2e.ts`), so no object storage or GitHub is involved.
 *
 * Run by Playwright as a web server (`playwright.config.ts`), which waits for the "seeded" line.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import {
  completeAnalysis,
  createDb,
  runMigrations,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";

/** The port the database listens on (playwright.config.ts builds `DATABASE_URL` from it). */
const port = Number(process.argv[2]);
/** The commit the seeded analysis is of (the tests' permalink). */
const sha = process.argv[3];
if (!Number.isInteger(port) || sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
  throw new Error("usage: database.ts <port> <40-hex sha>");
}

const server = new PGLiteSocketServer({
  db: await PGlite.create(),
  host: "127.0.0.1",
  port,
  // The migrator's and the server's pools; PGlite still runs one query at a time.
  maxConnections: 8,
});
await server.start();

const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
await runMigrations(url);
const { db, close } = createDb(url, { max: 1 });
const { id: repoId } = await upsertRepo(db, {
  providerRepoId: 1,
  owner: "fixtures",
  name: "shop-demo",
  visibility: "public",
  defaultBranch: "main",
});
const analysis = await startAnalysis(db, { repoId, sha, analyzerVersion: ANALYZER_VERSION });
await completeAnalysis(db, analysis.id, {
  snapshotKey: `public/1/${sha}/${ANALYZER_VERSION}/architecture.json.gz`,
  stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
});
await close();
console.log(`seeded fixtures/shop-demo@${sha} on ${url}`);

const stop = () => {
  server.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
