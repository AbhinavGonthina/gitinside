# Capped runs: VS Code under production's analysis limits (2026-10-31)

- **Repo:** https://github.com/microsoft/vscode at `11ba54a90a0ff8720cf47c086f5a9948eef9cf2c` (the tree `pnpm bench:stress` extracted, M5.16a), and cal.com from `pnpm bench` for comparison
- **Method:** `pnpm bench:capped <folder>...` (`bench/src/capped.ts`): each folder through the worker's own sandboxed runner (`runAnalysis`: 3,072 MB heap, 5 min, no network), one after another, nothing else running. "Source" is what the inventory keeps (`.ts .tsx .js .jsx .mjs .cjs .prisma`, after the ignore, 2 MB, and generated-file rules). Times are from the parent: they include starting the child.
- **Code:** gitinside `65c56fc` plus M5.16b's changes (uncommitted while measuring). The calibration runs had `MAX_SOURCE_MB` raised to 1,000 so folders over 50 reached the parser; the "with the limit" runs used the committed 50.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, Windows 11, Node v22.13.0
- **Runs:** one per folder. Raw lines are below; nothing was rounded beyond what `capped.ts` prints.

## Without the source-size limit (calibration)

| Folder | Source files | Source MiB | Outcome | Time | Last step seen (at) |
|---|---:|---:|---|---:|---|
| `src/vs/editor` | 885 | 10.1 | finished | 9,866 ms | assemble (9.2 s) |
| cal.com (113 services) | 5,073 | 18.0 | finished | 37,986 ms | assemble (36.9 s) |
| `extensions` | 3,698 | 33.2 | finished | 31,861 ms | assemble (30.3 s) |
| `src/vs/platform` | 3,512 | 44.8 | finished | 37,317 ms | assemble (35.5 s) |
| `src/vs/workbench/contrib` | 3,523 | 59.0 | finished | 50,883 ms | assemble (43.7 s) |
| `src/vs/workbench` | 4,946 | 79.8 | `LIMIT_MEMORY` | 52,259 ms | calls (23.1 s) |
| whole repo | 15,184 | 201.0 | `LIMIT_MEMORY` | 32,966 ms | programs (8.7 s) |

## With the 50 MB limit (production)

| Folder | Source files | Source MiB | Outcome | Time | Last step seen (at) |
|---|---:|---:|---|---:|---|
| whole repo | 15,184 | 201.0 | `LIMIT_SOURCE_SIZE` | 8,384 ms | inventory (0.5 s) |
| `src/vs/workbench` | 4,946 | 79.8 | `LIMIT_SOURCE_SIZE` | 2,853 ms | inventory (0.5 s) |
| `src/vs/platform` | 3,512 | 44.8 | finished | 29,134 ms | assemble (27.5 s) |

## Raw output

```json
{"folder":".repos/vscode-11ba54a-tree/src/vs/editor","maxSourceMb":1000,"sourceFiles":885,"sourceMib":10.1,"ok":true,"ms":9866,"lastStep":"assemble","lastStepAtMs":9196,"stageMs":{"inventory":472,"workspace":1,"programs":1943,"imports":235,"express":13,"next":0,"prisma":1,"infra":1,"files":494,"symbols":32,"calls":3317,"http":1564,"sdk":608,"queues":8,"assemble":203}}
{"folder":".repos/calcom","maxSourceMb":1000,"sourceFiles":5073,"sourceMib":18,"ok":true,"ms":37986,"lastStep":"assemble","lastStepAtMs":36915,"stageMs":{"inventory":3473,"workspace":39,"programs":12330,"imports":2307,"express":51,"next":1633,"prisma":1307,"infra":37,"files":3010,"symbols":60,"calls":5886,"http":3969,"sdk":1379,"queues":749,"assemble":328}}
{"folder":".repos/vscode-11ba54a-tree/extensions","maxSourceMb":1000,"sourceFiles":3698,"sourceMib":33.2,"ok":true,"ms":31861,"lastStep":"assemble","lastStepAtMs":30292,"stageMs":{"inventory":2393,"workspace":3,"programs":8250,"imports":932,"express":40,"next":0,"prisma":1,"infra":15,"files":2234,"symbols":79,"calls":7852,"http":5576,"sdk":2125,"queues":21,"assemble":431}}
{"folder":".repos/vscode-11ba54a-tree/src/vs/platform","maxSourceMb":1000,"sourceFiles":3512,"sourceMib":44.8,"ok":true,"ms":37317,"lastStep":"assemble","lastStepAtMs":35478,"stageMs":{"inventory":2372,"workspace":2,"programs":8593,"imports":1096,"express":37,"next":0,"prisma":1,"infra":2,"files":1926,"symbols":82,"calls":9151,"http":9020,"sdk":2446,"queues":29,"assemble":497}}
{"folder":".repos/vscode-11ba54a-tree/src/vs/workbench/contrib","maxSourceMb":1000,"sourceFiles":3523,"sourceMib":59,"ok":true,"ms":50883,"lastStep":"assemble","lastStepAtMs":43676,"stageMs":{"inventory":2317,"workspace":1,"programs":10078,"imports":1473,"express":46,"next":0,"prisma":1,"infra":2,"files":2047,"symbols":116,"calls":12741,"http":9400,"sdk":4667,"queues":46,"assemble":1085}}
{"folder":".repos/vscode-11ba54a-tree/src/vs/workbench","maxSourceMb":1000,"sourceFiles":4946,"sourceMib":79.8,"ok":false,"code":"LIMIT_MEMORY","ms":52259,"lastStep":"calls","lastStepAtMs":23087}
{"folder":".repos/vscode-11ba54a-tree","maxSourceMb":1000,"sourceFiles":15184,"sourceMib":201,"ok":false,"code":"LIMIT_MEMORY","ms":32966,"lastStep":"programs","lastStepAtMs":8698}
{"folder":".repos/vscode-11ba54a-tree","maxSourceMb":50,"sourceFiles":15184,"sourceMib":201,"ok":false,"code":"LIMIT_SOURCE_SIZE","ms":8384,"lastStep":"inventory","lastStepAtMs":497}
{"folder":".repos/vscode-11ba54a-tree/src/vs/workbench","maxSourceMb":50,"sourceFiles":4946,"sourceMib":79.8,"ok":false,"code":"LIMIT_SOURCE_SIZE","ms":2853,"lastStep":"inventory","lastStepAtMs":478}
{"folder":".repos/vscode-11ba54a-tree/src/vs/platform","maxSourceMb":50,"sourceFiles":3512,"sourceMib":44.8,"ok":true,"ms":29134,"lastStep":"assemble","lastStepAtMs":27547,"stageMs":{"inventory":1865,"workspace":1,"programs":6461,"imports":839,"express":28,"next":0,"prisma":1,"infra":1,"files":1723,"symbols":70,"calls":6548,"http":7350,"sdk":2055,"queues":22,"assemble":433}}
```

## Observations (hand-written, not generated)

- **What production did with VS Code before M5.16b.** Everything before parsing passes (M5.16a: 328 of 500 MiB unpacked, 25,233 of 100,000 entries, 15,184 of 20,000 source files). The analysis child then started building its one TypeScript program 8.7 s in and was over the 3 GB heap at 33 s: `LIMIT_MEMORY`. On the progress page that is the download, the unpacking (69 s on this laptop, M5.16a), then "Parsing 15,184 files" for half a minute, then "The analysis needed more memory than one repo may use. Try a smaller repo." It fails on memory, not time: at 33 s it is far from the 5 minute limit. An earlier, unrecorded session measured 44 s and 77 s for the same run, so the moment varies from run to run; the outcome and the step didn't.
- **What it does now.** The inventory adds up the sizes it already `lstat`s and refuses 201 MiB against the 50 MB limit before any program is built: the child's last step is the inventory at 0.5 s, and the job fails 8.4 s after the runner starts (most of that is walking 20,000 files on Windows). The page says "This repo has over 50 MB of source code, the limit for one analysis. Try a smaller repo." Download and unpacking still happen first; M5.18b's check on GitHub's repo `size` is the one that can refuse before downloading.
- **Why bytes and not files.** `src/vs/workbench` (4,946 files) ran out of memory while cal.com (5,073 files) finished, so a file count can't tell them apart. By source size they are 79.8 against 18.0 MiB. Across the VS Code folders the finished runs go up to 59 MiB and the failed ones start at 79.8.
- **Why 50.** It is under the largest size that finished (59 MiB) and well under the smallest that failed (79.8 MiB). How close 59 MiB came to 3 GB isn't measured (the runner reports no peak heap), and Cloud Run's 1 vCPU will be slower than this 20-core laptop, so time matters more there: these runs finished in under a minute here against a 5 minute limit.
- **Size isn't everything.** cal.com took 38 s for 18 MiB, about 2.4× the time per MiB of `src/vs/workbench/contrib` (51 s for 59 MiB): its 113 services each get a program and its Next.js and Prisma detectors do work VS Code's folders don't need. A repo of many services under 50 MB can still hit `LIMIT_MEMORY` or `LIMIT_TIME`; those stay the backstop. Recalibrate on Cloud Run with `pnpm bench:capped` in M5.13.
- **Where a capped run's time goes:** in the finished VS Code folders `calls` and `http` together are 42–49% of the time (e.g. `src/vs/platform`: 9.2 s and 9.0 s of 37.3 s), then `programs` (20–26%). That matches M5.16a's uncapped run on the whole repo.

## What the analyzer would need to take a VS Code (not done; no caps raised)

- **More than one program.** VS Code's root `package.json` declares no workspaces, so the analyzer makes one service and one TypeScript program over all 15,184 files, and that program alone passes 3 GB (the whole repo died in `programs`). Treating each `extensions/<name>` folder with its own `package.json` as a service, and `src/vs` as one or a few (it has its own layering: `base`, `platform`, `editor`, `workbench`), would give programs of the sizes that finished above.
- **Not holding every program at once.** Today all services' programs stay alive until the graph is assembled, so smaller programs only help if each one's facts are collected and the program is dropped before the next is built. That is the shape of M6.7's per-service fact cache, which would also let a later commit re-parse only the services that changed.
- **Cheaper `calls` and `http` passes.** They are the two largest stages in both the capped and the uncapped runs; M5.16a found 128 HTTP edges among 250,703 calls in the whole repo. Skipping call sites that can't be HTTP (no `fetch`/`axios`/client import in the file) before asking the checker would cut most of `http`.
- Even with all three, `src/vs/workbench` alone is 79.8 MiB in one layer that imports itself heavily; splitting it is a modeling choice (what counts as a service), not just a performance fix.
