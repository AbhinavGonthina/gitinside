import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExtractError,
  extractTarball,
  SKIPPED_PATH_MAX_CHARS,
  type ExtractErrorCode,
} from "./extract.js";
import { paxBody, streamOf, tar, tgz, type TestEntry } from "./tar.testkit.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const ROOT = "acme-shop-1a2b3c4";

let work: string;
let dest: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gi-extract-"));
  dest = join(work, "job", "src");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Every path under `dir` (folders with a trailing slash), sorted. */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(rel === "" ? dir : join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        out.push(`${path}/`);
        await walk(path);
      } else {
        out.push(path);
      }
    }
  }
  await walk("");
  return out.sort();
}

async function expectCode(promise: Promise<unknown>, code: ExtractErrorCode): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExtractError);
  expect((error as ExtractError).code).toBe(code);
}

const file = (name: string, body: string | Buffer = ""): TestEntry => ({ name, body });
const dir = (name: string): TestEntry => ({ name, type: "5" });

describe("extractTarball: well-formed archives", () => {
  it("writes files and folders, strips the top folder, and counts what it wrote", async () => {
    const result = await extractTarball(
      tgz([
        dir(`${ROOT}/`),
        file(`${ROOT}/package.json`, '{"name":"shop"}'),
        dir(`${ROOT}/src/`),
        file(`${ROOT}/src/index.ts`, "export const a = 1;\n"),
        file(`${ROOT}/apps/web/page.tsx`, "x"),
      ]),
      dest,
    );
    expect(await listing(dest)).toEqual([
      "apps/",
      "apps/web/",
      "apps/web/page.tsx",
      "package.json",
      "src/",
      "src/index.ts",
    ]);
    expect(await readFile(join(dest, "src/index.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(result).toEqual({ files: 3, directories: 1, tarBytes: 512 * 10, skipped: [] });
  });

  it("extracts a real `git archive` tarball (pax global header) identical to the checkout", async () => {
    const folder = "fixtures/express-basic";
    const archive = execFileSync(
      "git",
      ["archive", "--format=tar.gz", `--prefix=${ROOT}/`, "HEAD", folder],
      { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    const tracked = execFileSync("git", ["ls-files", folder], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "")
      .sort();
    const result = await extractTarball(streamOf(archive), dest);

    const files = (await listing(dest)).filter((p) => !p.endsWith("/"));
    expect(files).toEqual(tracked);
    for (const path of tracked) {
      const blob = execFileSync("git", ["show", `HEAD:${path}`], { cwd: REPO_ROOT });
      expect((await readFile(join(dest, path))).equals(blob), path).toBe(true);
    }
    expect(result.files).toBe(tracked.length);
    expect(result.skipped).toEqual([]);
  });

  it("gives the same result however the input is chunked", async () => {
    const entries = [
      file(`${ROOT}/a.ts`, "a".repeat(700)),
      {
        name: `${ROOT}/PaxHeader`,
        type: "x",
        body: paxBody({ path: `${ROOT}/${"p".repeat(150)}.ts` }),
      },
      file(`${ROOT}/ignored-name`, "b".repeat(1500)),
      file(`${ROOT}/c.ts`, "c"),
    ];
    const whole = await extractTarball(tgz(entries), dest);
    const other = join(work, "chunked");
    const chunked = await extractTarball(tgz(entries, { chunk: 3 }), other);
    expect(chunked).toEqual(whole);
    expect(await listing(other)).toEqual(await listing(dest));
    expect(await readFile(join(other, `${"p".repeat(150)}.ts`), "utf8")).toBe("b".repeat(1500));
  });

  it("keeps the top folder when stripRoot is false", async () => {
    await extractTarball(tgz([file("one/a.ts"), file("two/b.ts")]), dest, { stripRoot: false });
    expect(await listing(dest)).toEqual(["one/", "one/a.ts", "two/", "two/b.ts"]);
  });

  it("reads long names from pax headers, GNU long names, and the ustar prefix", async () => {
    const deep = `${"d".repeat(80)}/${"e".repeat(80)}`;
    await extractTarball(
      tgz([
        {
          name: "PaxHeader",
          type: "x",
          body: paxBody({ path: `${ROOT}/${deep}/pax.ts`, mtime: "1" }),
        },
        file("truncated-name", "pax"),
        { name: "././@LongLink", type: "L", body: `${ROOT}/${deep}/gnu.ts\0` },
        file("truncated-name", "gnu"),
        { name: "ustar.ts", prefix: `${ROOT}/${"d".repeat(80)}`, body: "ustar" },
      ]),
      dest,
    );
    expect(await readFile(join(dest, deep, "pax.ts"), "utf8")).toBe("pax");
    expect(await readFile(join(dest, deep, "gnu.ts"), "utf8")).toBe("gnu");
    expect(await readFile(join(dest, "d".repeat(80), "ustar.ts"), "utf8")).toBe("ustar");
  });

  it("applies a pax size to the next entry only", async () => {
    const big = "z".repeat(1000);
    await extractTarball(
      tgz([
        { name: "PaxHeader", type: "x", body: paxBody({ size: "1000" }) },
        { name: `${ROOT}/big.txt`, body: big, size: 0 },
        file(`${ROOT}/small.txt`, "s"),
      ]),
      dest,
    );
    expect(await readFile(join(dest, "big.txt"), "utf8")).toBe(big);
    expect(await readFile(join(dest, "small.txt"), "utf8")).toBe("s");
  });

  it("reads base-256 size fields", async () => {
    const sizeField = Buffer.alloc(12);
    sizeField[0] = 0x80;
    sizeField.writeUInt32BE(5, 8);
    await extractTarball(tgz([{ name: `${ROOT}/a.txt`, body: "12345", sizeField }]), dest);
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("12345");
  });

  it("treats names that merely start with dots as ordinary", async () => {
    await extractTarball(
      tgz([file(`${ROOT}/..config`, "a"), file(`${ROOT}/./src/...ts`, "b")]),
      dest,
    );
    expect(await listing(dest)).toEqual(["..config", "src/", "src/...ts"]);
  });

  it("writes files over the analyzer's 2 MB limit in full, so the analyzer warns as on a checkout", async () => {
    const body = Buffer.alloc(3 * 1024 * 1024, 0x61);
    await extractTarball(tgz([file(`${ROOT}/big.js`, body)]), dest);
    expect((await stat(join(dest, "big.js"))).size).toBe(body.length);
  });

  it.skipIf(process.platform === "win32")(
    "ignores archive modes: files 0644, folders 0755",
    async () => {
      await extractTarball(
        tgz([dir(`${ROOT}/bin/`), file(`${ROOT}/bin/run.sh`, "#!/bin/sh")]),
        dest,
      );
      expect((await stat(join(dest, "bin/run.sh"))).mode & 0o777).toBe(0o644);
      expect((await stat(join(dest, "bin"))).mode & 0o777).toBe(0o755);
    },
  );
});

describe("extractTarball: path escapes fail the job", () => {
  const cases: [string, TestEntry[]][] = [
    ["a leading ..", [file("../evil.txt", "x")]],
    ["a .. after the top folder", [file(`${ROOT}/../../evil.txt`, "x")]],
    ["a .. in the middle", [file(`${ROOT}/src/../../evil.txt`, "x")]],
    ["an absolute path", [file("/tmp/evil.txt", "x")]],
    [
      "a pax path with ..",
      [{ name: "P", type: "x", body: paxBody({ path: "../evil.txt" }) }, file("ok")],
    ],
    [
      "a pax path with a NUL",
      [{ name: "P", type: "x", body: paxBody({ path: `${ROOT}/a\0b` }) }, file("ok")],
    ],
    [
      "a GNU long name with ..",
      [{ name: "L", type: "L", body: `${ROOT}/../evil.txt\0` }, file("ok")],
    ],
    ["a directory entry with ..", [dir(`${ROOT}/../evil/`)]],
  ];
  for (const [label, entries] of cases) {
    it(`rejects ${label} and writes nothing outside the folder`, async () => {
      await expectCode(extractTarball(tgz(entries), dest), "TAR_UNSAFE_PATH");
      expect(existsSync(join(work, "evil.txt"))).toBe(false);
      expect(existsSync(join(work, "job", "evil.txt"))).toBe(false);
      expect(existsSync(join(work, "evil"))).toBe(false);
    });
  }
});

describe("extractTarball: entries that aren't regular files or folders", () => {
  it("skips links, devices, FIFOs, and unknown types, and lists them sorted", async () => {
    const result = await extractTarball(
      tgz([
        file(`${ROOT}/real.ts`, "x"),
        { name: `${ROOT}/z-link`, type: "2", linkname: "/etc/passwd" },
        { name: `${ROOT}/a-hard`, type: "1", linkname: `${ROOT}/real.ts` },
        { name: `${ROOT}/dev/tty`, type: "3" },
        { name: `${ROOT}/dev/disk`, type: "4" },
        { name: `${ROOT}/fifo`, type: "6" },
        { name: `${ROOT}/sparse`, type: "S", body: "data" },
      ]),
      dest,
    );
    expect(result.skipped).toEqual([
      { path: "a-hard", reason: "HARDLINK" },
      { path: "dev/disk", reason: "SPECIAL" },
      { path: "dev/tty", reason: "SPECIAL" },
      { path: "fifo", reason: "SPECIAL" },
      { path: "sparse", reason: "SPECIAL" },
      { path: "z-link", reason: "SYMLINK" },
    ]);
    expect(await listing(dest)).toEqual(["real.ts"]);
  });

  it("never lets a skipped symlink redirect a later write", async () => {
    const outside = join(work, "outside");
    const result = await extractTarball(
      tgz([
        { name: `${ROOT}/link`, type: "2", linkname: outside },
        { name: `${ROOT}/link2`, type: "2", linkname: "../.." },
        file(`${ROOT}/link/payload.txt`, "x"),
        file(`${ROOT}/link2/payload.txt`, "y"),
      ]),
      dest,
    );
    expect(existsSync(outside)).toBe(false);
    expect((await lstat(join(dest, "link"))).isDirectory()).toBe(true);
    expect((await lstat(join(dest, "link2"))).isDirectory()).toBe(true);
    expect(await readFile(join(dest, "link/payload.txt"), "utf8")).toBe("x");
    expect(result.skipped.map((s) => s.reason)).toEqual(["SYMLINK", "SYMLINK"]);
  });

  it("skips names it can't represent safely, with control characters replaced", async () => {
    const result = await extractTarball(
      tgz([
        file(`${ROOT}/back\\slash.ts`),
        file(`${ROOT}/bell\u0007.ts`),
        { name: "P", type: "x", body: paxBody({ path: `${ROOT}/${"n".repeat(256)}` }) },
        file("long-name-1"),
        { name: "P", type: "x", body: paxBody({ path: `${ROOT}/${"o".repeat(255)}` }) },
        file("long-name-2", "ok"),
      ]),
      dest,
    );
    expect(result.skipped).toEqual([
      { path: "back\\slash.ts", reason: "UNSUPPORTED_NAME" },
      { path: "bell�.ts", reason: "UNSUPPORTED_NAME" },
      { path: "n".repeat(256), reason: "UNSUPPORTED_NAME" },
    ]);
    expect(await listing(dest)).toEqual(["o".repeat(255)]);
  });

  it("skips paths over maxPathBytes", async () => {
    const result = await extractTarball(
      tgz([file(`${ROOT}/abcdef/ghij.ts`), file(`${ROOT}/a.ts`)]),
      dest,
      {
        limits: { maxPathBytes: 8 },
      },
    );
    expect(result.skipped).toEqual([{ path: "abcdef/ghij.ts", reason: "UNSUPPORTED_NAME" }]);
    expect(await listing(dest)).toEqual(["a.ts"]);
  });

  it("lists a skipped entry's path cut to 512 characters, never splitting a character (M5 review)", async () => {
    const huge = "x/".repeat(400_000);
    const emoji = `${"e".repeat(511)}${"😀".repeat(300)}`;
    const exact = "😀".repeat(512);
    const result = await extractTarball(
      tgz([
        { name: "P", type: "x", body: paxBody({ path: `${ROOT}/${huge}a.ts` }) },
        file("long-1"),
        { name: "P", type: "x", body: paxBody({ path: `${ROOT}/${emoji}` }) },
        { name: "link", type: "2" },
        { name: "P", type: "x", body: paxBody({ path: `${ROOT}/${exact}` }) },
        { name: "link", type: "2" },
      ]),
      dest,
    );
    expect(result.skipped).toEqual([
      { path: `${"e".repeat(511)}😀…`, reason: "SYMLINK" },
      { path: `${"x/".repeat(256)}…`, reason: "UNSUPPORTED_NAME" },
      { path: exact, reason: "SYMLINK" },
    ]);
    expect(SKIPPED_PATH_MAX_CHARS).toBe(512);
  });
});

describe("extractTarball: limits", () => {
  it("fails early when a header declares more than the size limit", async () => {
    const archive = tgz([{ name: `${ROOT}/huge.bin`, size: 10 * 1024 * 1024 }], { end: false });
    await expectCode(
      extractTarball(archive, dest, { limits: { maxBytes: 1024 * 1024 } }),
      "LIMIT_SIZE",
    );
  });

  it("catches a gzip bomb while streaming", async () => {
    // 64 MiB of zeros compress to ~64 KB; every decompressed byte counts, even past the end marker.
    const bomb = Buffer.concat([tar([file(`${ROOT}/a.ts`, "x")]), Buffer.alloc(64 * 1024 * 1024)]);
    const compressed = gzipSync(bomb);
    expect(compressed.length).toBeLessThan(1024 * 1024);
    await expectCode(
      extractTarball(streamOf(compressed), dest, { limits: { maxBytes: 8 * 1024 * 1024 } }),
      "LIMIT_SIZE",
    );
  });

  it("counts entries but not metadata records against maxEntries", async () => {
    const pax = { name: "P", type: "x", body: paxBody({ path: `${ROOT}/a.ts` }) };
    await extractTarball(tgz([pax, file("ignored"), file(`${ROOT}/b.ts`)]), dest, {
      limits: { maxEntries: 2 },
    });
    const more = tgz([file(`${ROOT}/a`), file(`${ROOT}/b`), file(`${ROOT}/c`)]);
    await expectCode(
      extractTarball(more, join(work, "more"), { limits: { maxEntries: 2 } }),
      "LIMIT_ENTRIES",
    );
  });
});

describe("extractTarball: invalid archives", () => {
  const cases: [string, Readable][] = [
    ["a bad header checksum", tgz([{ name: `${ROOT}/a.ts`, body: "x", badChecksum: true }])],
    ["a missing end-of-archive marker", tgz([file(`${ROOT}/a.ts`, "x")], { end: false })],
    [
      "a stream cut mid-file",
      streamOf(gzipSync(tar([file(`${ROOT}/a.ts`, "x".repeat(2000))]).subarray(0, 1024))),
    ],
    [
      "a stream cut mid-header",
      streamOf(gzipSync(tar([file(`${ROOT}/a.ts`, "x")]).subarray(0, 100))),
    ],
    ["a non-gzip stream", streamOf(Buffer.from("this is not gzip at all"))],
    [
      "a gzip stream cut short",
      streamOf(gzipSync(tar([file(`${ROOT}/a.ts`, "x")])).subarray(0, 30)),
    ],
    ["a duplicate file", tgz([file(`${ROOT}/a.ts`, "1"), file(`${ROOT}/a.ts`, "2")])],
    ["a folder over a file", tgz([file(`${ROOT}/a`, "1"), dir(`${ROOT}/a/`)])],
    ["a file inside a file", tgz([file(`${ROOT}/a`, "1"), file(`${ROOT}/a/b.ts`, "2")])],
    ["a file over a folder", tgz([dir(`${ROOT}/a/`), file(`${ROOT}/a`, "1")])],
    ["two top folders", tgz([file(`${ROOT}/a.ts`), file("other-root/b.ts")])],
    ["a file at the top level", tgz([file("README.md", "x")])],
    [
      "a malformed pax record",
      tgz([{ name: "P", type: "x", body: "99 path=x\n" }, file(`${ROOT}/a`)]),
    ],
    [
      "a pax record without =",
      tgz([{ name: "P", type: "x", body: "9 pathx\n\n" }, file(`${ROOT}/a`)]),
    ],
    [
      "a non-numeric pax size",
      tgz([{ name: "P", type: "x", body: paxBody({ size: "1e3" }) }, file(`${ROOT}/a`)]),
    ],
    [
      "an oversized metadata record",
      tgz([{ name: "L", type: "L", body: Buffer.alloc(1024 * 1024 + 1, 0x61) }]),
    ],
    ["a non-octal size", tgz([{ name: `${ROOT}/a`, sizeField: Buffer.from("12x45678901\0") }])],
    ["a negative base-256 size", tgz([{ name: `${ROOT}/a`, sizeField: Buffer.alloc(12, 0xff) }])],
  ];
  for (const [label, archive] of cases) {
    it(`rejects ${label}`, async () => {
      await expectCode(extractTarball(archive, dest), "TAR_INVALID");
    });
  }

  it("rethrows a failing source as it is", async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error("connection reset"));
      },
    });
    await expect(extractTarball(failing, dest)).rejects.toThrow("connection reset");
  });

  it("refuses a target folder that isn't empty", async () => {
    await extractTarball(tgz([file(`${ROOT}/a.ts`)]), dest);
    await writeFile(join(dest, "extra"), "");
    await expect(extractTarball(tgz([file(`${ROOT}/b.ts`)]), dest)).rejects.toThrow(/not empty/);
  });
});
