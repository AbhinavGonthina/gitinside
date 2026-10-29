# Malicious fixtures (M5.11)

Hostile repos for the worker's security suite, `apps/worker/src/security.test.ts` (docs/SECURITY.md T1–T5, docs/TESTING.md "Security tests"). Each case runs through the real job pipeline at the production limits: a fake GitHub serves the tarball, `processJob` streams it through `extractTarball`, and the sandboxed analysis child (`runAnalysis`) analyzes what was written.

Only `postinstall-script/` is a committed folder. The others are archives no honest tool produces (`../` names, links, lying sizes) or are too big to commit, so the suite builds them byte by byte in the test (`tar.testkit.ts`):

| Case | What the archive holds | Expected |
|---|---|---|
| `postinstall-script` | install scripts, config files, a TS plugin, `.npmrc` hooks, top-level code that writes a sentinel and runs a shell | analysis succeeds; no sentinel; one child process, sandboxed |
| `huge-file` | a 3 MB source file next to a normal one; separately, a header declaring 600 MiB | `SKIPPED_LARGE` warning and the rest analyzed; `LIMIT_SIZE` before any body is read |
| `symlink-escape` | symlinks and a hard link to a canary folder and file outside the job, a file written "through" a link; a symlink planted on disk after extraction | links skipped and listed, nothing written outside, the canary's contents never reach the graph |
| `path-traversal-tar` | `../`, absolute, mid-path `..`, pax and GNU long-name escapes aimed at real folders | `TAR_UNSAFE_PATH`, not retried, nothing written outside, job folder deleted |
| `zip-bomb` | a small file, then 520 MiB of zeros (about 0.5 MB compressed) | `LIMIT_SIZE` while streaming, nothing beyond the small file written |
| `deep-nesting` | a file 80 folders deep, a path over 4,096 bytes | `SKIPPED_DEPTH` past 64 levels, the long path skipped as `UNSUPPORTED_NAME`, the rest analyzed |
| `too-many-files` | 20,001 source files; separately, 100,001 entries | `LIMIT_FILES` from the analyzer; `LIMIT_ENTRIES` from the extractor |

The suite also runs `fixtures/fake-secrets` through the same pipeline with fake secrets in the worker's own environment, and checks that none of them reach the stored graph (T5).

Fixtures are never executed: no `npm install`, no scripts.
