# Why cal.diy took 96.3 s (M5.13a2, 2026-11-04)

M5.13's production smoke test measured 96.3 s from queued to done for `calcom/cal.diy` at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee` (5,075 source files, 113 services) on one Cloud Run instance (1 vCPU / 4 GiB). DESIGN.md §9's budget is ≤ 60 s for a 5k-file repo. This note re-measures the same commit locally, says where the time goes, and what would bring it under 60 s.

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`, fetched with `git fetch --depth 1` into `bench/.repos/caldiy-2eb48ec` (the same files as GitHub's tarball, which the worker extracts).
- **Code:** gitinside `cc3fe55` (analyzer 0.2.0, the version production ran), built before measuring.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, Windows 11, Node v22.13.0, other programs open.
- **Production's own stage times** are in that row's `analyses.stats` (`stageMs`, and `jobMs`: download, analyze, upload), which only a production database read can show. Abhinav read them on gitinside-planning#20 (2026-11-05); they're under "Production's split" below.

## Raw output

`pnpm bench:capped .repos/caldiy-2eb48ec` ×3 (`bench/src/capped.ts`: the worker's own sandboxed runner, 2,560 MB heap cap, permission model, network guard, no cache):

```json
{"folder":".repos/caldiy-2eb48ec","maxHeapMb":2560,"maxSourceMb":50,"sourceFiles":5075,"sourceMib":17.5,"ok":true,"ms":87844,"lastStep":"assemble","lastStepAtMs":85058,"stageMs":{"inventory":4077,"workspace":2282,"programs":23022,"imports":7055,"express":131,"next":2285,"prisma":3631,"infra":106,"files":149,"symbols":191,"calls":15004,"http":13729,"sdk":5098,"queues":7713,"assemble":899},"graphMib":24.8,"peakRssMib":2217.8,"heapMib":2135.7}
{"folder":".repos/caldiy-2eb48ec","maxHeapMb":2560,"maxSourceMb":50,"sourceFiles":5075,"sourceMib":17.5,"ok":true,"ms":84351,"lastStep":"assemble","lastStepAtMs":81721,"stageMs":{"inventory":2826,"workspace":99,"programs":19028,"imports":6809,"express":104,"next":2121,"prisma":3817,"infra":75,"files":148,"symbols":205,"calls":16420,"http":15842,"sdk":5541,"queues":8194,"assemble":753},"graphMib":24.8,"peakRssMib":2231.4,"heapMib":2145.8}
{"folder":".repos/caldiy-2eb48ec","maxHeapMb":2560,"maxSourceMb":50,"sourceFiles":5075,"sourceMib":17.5,"ok":true,"ms":84724,"lastStep":"assemble","lastStepAtMs":82094,"stageMs":{"inventory":3311,"workspace":51,"programs":20967,"imports":6878,"express":126,"next":2113,"prisma":3587,"infra":45,"files":112,"symbols":206,"calls":15962,"http":15440,"sdk":5109,"queues":7665,"assemble":868},"graphMib":24.8,"peakRssMib":2233.2,"heapMib":2148.6}
```

The analysis child (`apps/worker/dist/child.js`, empty environment) under four flag sets, one run each, in this order (scratch script `bench/dist/m513a2-variants.mjs`): `none` (no flags), `heap` (`--max-old-space-size=2560`), `sandbox` (`--permission`, the `--allow-fs-*` roots, the network guard), `full` (both, what the runner passes):

```json
{"variant":"none","code":0,"ok":true,"ms":92324,"stageMs":{"inventory":2820,"workspace":52,"programs":24466,"imports":5896,"express":123,"next":2180,"prisma":4820,"infra":97,"files":189,"symbols":196,"calls":17438,"http":16940,"sdk":4936,"queues":7535,"assemble":2414},"peakRssMib":2168,"heapMib":2089}
{"variant":"heap","code":0,"ok":true,"ms":92145,"stageMs":{"inventory":4170,"workspace":112,"programs":24547,"imports":6812,"express":170,"next":2049,"prisma":4782,"infra":77,"files":167,"symbols":180,"calls":16079,"http":16772,"sdk":4868,"queues":7817,"assemble":968},"peakRssMib":2150,"heapMib":1214}
{"variant":"sandbox","code":0,"ok":true,"ms":84385,"stageMs":{"inventory":3237,"workspace":83,"programs":21990,"imports":6601,"express":126,"next":2095,"prisma":3604,"infra":109,"files":175,"symbols":205,"calls":14894,"http":15238,"sdk":5092,"queues":7843,"assemble":899},"peakRssMib":2499,"heapMib":2415}
{"variant":"full","code":0,"ok":true,"ms":63686,"stageMs":{"inventory":2860,"workspace":37,"programs":22115,"imports":7152,"express":118,"next":2062,"prisma":3771,"infra":127,"files":215,"symbols":201,"calls":12416,"http":7624,"sdk":1282,"queues":2111,"assemble":314},"peakRssMib":2238,"heapMib":2148}
```

The `heap` variant with `--cpu-prof` (same script, variant `prof`); the profile summarized by self time (scratch script `bench/dist/m513a2-profile.mjs`):

```json
{"variant":"prof","code":0,"ok":true,"ms":47934,"stageMs":{"inventory":2895,"workspace":25,"programs":15127,"imports":6645,"express":131,"next":2983,"prisma":3959,"infra":86,"files":153,"symbols":185,"calls":5574,"http":3818,"sdk":1221,"queues":1924,"assemble":286},"peakRssMib":2440,"heapMib":2150}
```

```
total sampled: 45968 ms
By file (self): typescript.js 28,219 ms (61.4%); native 9,618 ms (20.9%); analyzer imports.js 1,617 ms (3.5%),
  program.js 947 (2.1%), calls.js 830 (1.8%), prisma.js 680 (1.5%), workspace.js 640 (1.4%), queues.js 357 (0.8%),
  symbols.js 332 (0.7%), http.js 318 (0.7%), zod 217 (0.5%), inputs.js 213 (0.5%), sdk.js 209 (0.5%), every other file < 0.5%
By function (self): (garbage collector) 5,479 ms (11.9%); (idle) 2,791 ms (6.1%); TypeScript's normalizeSlashes 1,142 (2.5%),
  scan 745 (1.6%); analyzer serviceForFile 637 (1.4%); TypeScript visitNode2 566 (1.2%); analyzer toRepoPath 562 (1.2%),
  workspaceTarget 532 (1.2%); TypeScript getEncodedRootLength 470 (1.0%), bind 423 (0.9%), getBaseFileName 389 (0.8%),
  addWorkItem 388 (0.8%); native open 385 (0.8%); the regex //|(?:^|/)\.\.?(?:$|/) 363 (0.8%); TypeScript combinePaths 350 (0.8%),
  getSymbolOfNameOrPropertyAccessExpression 322, resolveNameHelper 320, resolveEntityName 320, pathComponents 297 (0.6–0.7% each)
```

Parses per repo file across the service programs (scratch script `bench/dist/m513a2-parses.mjs`: the analyzer's own inventory, workspace, and `buildServicePrograms`, every program built and its source files counted; `buildMs` is `createProgram` alone, parse and module resolution, no binding):

```json
{"services":113,"sourceFiles":5075,"rootFiles":5041,"distinctParsed":5148,"parses":7636,"parsesPerFile":1.48,"filesParsedMoreThanOnce":1458,"buildMs":20048,"mostParsed":[["packages/app-store/_utils/getInstalledAppPath.ts",40],["packages/app-store/_utils/getAppKeysFromSlug.ts",33],["packages/app-store/types.d.ts",28],["packages/app-store/_utils/oauth/decodeOAuthState.ts",25],["packages/app-store/_utils/oauth/encodeOAuthState.ts",20]],"slowestPrograms":[{"service":"web","roots":994,"repoFiles":1054,"ms":3676},{"service":"features","roots":934,"repoFiles":934,"ms":2532},{"service":"atoms","roots":171,"repoFiles":1278,"ms":2170},{"service":"v2","roots":624,"repoFiles":765,"ms":1996},{"service":"app-store","roots":130,"repoFiles":695,"ms":1130},{"service":"api","roots":1,"repoFiles":1,"ms":814},{"service":"app-store-cli","roots":23,"repoFiles":23,"ms":585},{"service":"trpc","roots":429,"repoFiles":429,"ms":553}]}
```

## Observations (hand-written, not generated)

- **This laptop can't say whether the budget is met.** The same commit and code took 47.9 s to 92.3 s for the analysis alone across 8 runs (median 84.6 s; the fastest was the profiled one); one stage (`http`) ranged from 3.8 s to 16.9 s and `sdk` from 1.2 s to 5.5 s. Production's 96.3 s also includes the Cloud Tasks dispatch, the instance's cold start, the tarball download and extraction, and the upload, which no local run has. A number for 1 vCPU has to come from a 1-vCPU machine, measured several times (see "What would bring it under 60 s", step 1).
- **The runner's flags aren't the cost.** Without any flag the child took 92.3 s; with all of them, 63.7 s. The spread between runs is larger than any flag's effect, so neither the permission model nor the heap cap shows a cost here.
- **Where the time goes: TypeScript.** 61% of the profiled CPU is inside `typescript.js` (parsing, binding, module resolution, the checker answering the detectors), 12% is the garbage collector on the main thread, 6% idle (the main thread waiting, e.g. on file reads). The analyzer's own code is under 15% in total; no single analyzer function passes 1.5%. By stage, building the programs is the largest (15–25 s, 22–35% of a run), then the checker-driven detectors: `calls` 5.6–17.4 s, `http` 3.8–16.9 s, `queues` 1.9–8.2 s, `imports` 5.9–7.2 s, `sdk` 1.2–5.5 s, `prisma` 3.6–4.8 s.
- **Repo files are parsed 1.48 times each.** Each of the 113 service programs parses every repo file it reaches, and only TypeScript's own `lib.*.d.ts` files are shared (`program.ts`'s `libCache`). 1,458 of 5,148 files are parsed more than once (`packages/app-store/_utils/getInstalledAppPath.ts` 40 times), so about a third of the parsing and binding is repeated, and each copy stays in memory for the run. No module-resolution cache is shared between programs either, so every program resolves the same specifiers again: TypeScript's path helpers (`normalizeSlashes`, `getEncodedRootLength`, `combinePaths`, `pathComponents`, `getBaseFileName`, `getDirectoryPath`, the relative-path regex) add up to about 3.2 s of self time (6.9%).
- **Memory is close to the cap, so the collector works hard.** Seven of the eight runs ended with 2,089–2,415 MiB of heap (one, `heap`, with 1,214 MiB), against the 2,560 MB cap. On 1 vCPU, V8's concurrent marking and parallel scavenging share the analysis's only core, so the collector's 12% here is a floor for Cloud Run, not an estimate. Fewer copies of each source file shrink the heap and the collector's work together.
- **Small analyzer costs:** `serviceForFile` scans all 113 packages per call and builds a string for each (0.6 s); `toRepoPath` and `workspaceTarget` are 0.5 s each. Worth a prefix index but not the main lever.

## What would bring it under 60 s on 1 vCPU (without raising the caps)

In order, each measured on step 1's runs before the next is tried:

1. **A 1-vCPU benchmark that isn't this laptop:** cal.diy at this commit in the worker image on a CI runner, `docker run --cpus=1 --memory=4g` with `/tmp` in memory (as `infra/gcp/check.mjs` already runs the image), 3 runs, stage times and job timings. Without it no speedup can be checked against the budget.
2. **Parse each repo file once:** share `SourceFile`s between service programs whose options give the same parse (language version, JSX, module detection), as TypeScript's `DocumentRegistry` does, and share a module-resolution cache between programs with the same resolution options. Expected from the counts above: about a third less parsing and binding, the 3.2 s of path work mostly gone, and a smaller heap. Graph bytes must stay identical (goldens, eval, warm == cold).
3. **The collector:** with step 2's smaller heap, re-measure the collector's share on 1 vCPU, then try a larger young generation (`--max-semi-space-size`) inside the 4 GiB budget (ADR-0146 counts ~90 MiB outside old space; a bigger semi-space adds to it).
4. **Then the detectors**, only if 1–3 aren't enough: they are mostly the checker's first answers for each file, so the gain is in asking it less (skip files that import nothing a detector looks for), not in the analyzer's own walking.

The fact cache (ADR-0178) doesn't help a first analysis: production's 96.3 s was a cold run.

## Production's split (added 2026-11-05, M5.14b2)

The two big rows from M5.13's smoke test, read by Abhinav from production's `analyses` table on gitinside-planning#20 (2026-11-05 ~06:20 UTC), copied unchanged. Both ran at gitinside `cfda744` (analyzer 0.2.0), whose analyzer is the same as `cc3fe55` above and `232ddd9` in `2026-11-04-cloudrun-caldiy.md` (the commits between them changed the website and benchmarks only).

| owner | name | sha | queued_at | started_at | finished_at |
|---|---|---|---|---|---|
| calcom | cal.diy | `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee` | 2026-11-04 05:02:45.481154+00 | 2026-11-04 05:02:46.11948+00 | 2026-11-04 05:04:18.218884+00 |
| documenso | documenso | `052aca2f955a4a98241266318e493d4e8463d973` | 2026-11-04 05:00:44.165397+00 | 2026-11-04 05:00:44.851541+00 | 2026-11-04 05:01:27.745782+00 |

```json
{"edges": 31544, "files": 5043, "jobMs": {"upload": 1377, "analyze": 81632, "download": 9502}, "nodes": 19303, "stageMs": {"sdk": 3549, "http": 11872, "next": 2815, "calls": 20017, "files": 105, "infra": 57, "prisma": 3833, "queues": 5290, "express": 163, "imports": 4411, "symbols": 280, "assemble": 947, "programs": 21595, "inventory": 1704, "workspace": 42}, "warnings": 144, "heapBytes": 1262268416, "graphBytes": 26028666, "unresolved": 720, "peakRssBytes": 2270609408, "snapshotBytes": 1411396}
{"edges": 18146, "files": 2255, "jobMs": {"upload": 759, "analyze": 37331, "download": 5092}, "nodes": 7744, "stageMs": {"sdk": 1969, "http": 4932, "next": 600, "calls": 9501, "files": 12, "infra": 66, "prisma": 3844, "queues": 2275, "express": 100, "imports": 1878, "symbols": 101, "assemble": 545, "programs": 8758, "inventory": 802, "workspace": 15}, "warnings": 19, "heapBytes": 1010171904, "graphBytes": 13410703, "unresolved": 308, "peakRssBytes": 1142939648, "snapshotBytes": 691755}
```

cal.diy's stages against the 1-vCPU CI runner's medians for the same analyzer (`2026-11-04-cloudrun-caldiy.md`, Xeon Platinum 8573C):

| Stage | Production | CI runner (median) | Ratio |
|---|---:|---:|---:|
| programs | 21.6 s | 12.0 s | 1.80× |
| calls | 20.0 s | 12.3 s | 1.63× |
| http | 11.9 s | 6.3 s | 1.88× |
| queues | 5.3 s | 2.6 s | 2.03× |
| imports | 4.4 s | 2.3 s | 1.92× |
| prisma | 3.8 s | 2.1 s | 1.83× |
| sdk | 3.5 s | 1.8 s | 1.97× |
| next | 2.8 s | 1.7 s | 1.66× |
| inventory | 1.7 s | 0.9 s | 1.89× |
| assemble | 0.9 s | 0.5 s | 1.89× |
| **all stages** | **76.7 s** | **42.8 s** | **1.79×** |
| analysis (`jobMs.analyze`) | 81.6 s | 44.3 s | 1.84× |

### Observations (hand-written, not generated)

- **Where production's time went:** cal.diy's job was 92.1 s from `started_at` to `finished_at`, and 92.7 s from `queued_at`. The analysis was 81.6 s of it (88%), the download 9.5 s, the upload 1.4 s. M5.13's 96.3 s was client wall clock, which adds the 3 s polling interval and the website's answers.
- **Dispatch and cold start are not the gap:** `queued_at` to `started_at` was 0.64 s for cal.diy and 0.69 s for documenso. In both cases an instance was already up (documenso finished 78 s before cal.diy was queued; what served documenso isn't recorded).
- **Production's vCPU ran 1.6–2.0× slower than CI's runner in every stage**, the CPU-bound checker stages and the file-reading `inventory` alike, and the same graph came out (19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings in both). So the gap is the CPU Cloud Run gave the job, not one stage or the network. Documenso agrees: its analysis was 37.3 s of a 42.9 s job.
- **The budget in production:** these rows ran before ADR-0197 (each file parsed once) and ADR-0198 (the semi-space). On CI those took cal.diy's analysis to 33.7–58.5 s median across four CPU models. At production's 1.8× this runner, the analysis alone would still be over 60 s, but that's an extrapolation, not a measurement: production's next cal.diy analysis (after the next `ANALYZER_VERSION` bump) gives the real figure.
- **The job clock and the row's clock differ a little:** `jobMs` adds up to 92.5 s for cal.diy and 43.2 s for documenso, 0.4 s and 0.3 s more than `started_at` to `finished_at`, so `started_at` is written a moment after the job's own clock starts.
- **Memory:** cal.diy's peak RSS was 2,165 MiB, in line with CI's child (2,110–2,115 MiB), within the 4 GiB instance.
