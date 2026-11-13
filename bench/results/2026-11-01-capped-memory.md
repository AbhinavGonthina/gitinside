# Capped runs: memory of the analysis child, for a 4 GiB Cloud Run instance (2026-11-01)

- **Repos:** cal.com from `pnpm bench`, and folders of https://github.com/microsoft/vscode at `11ba54a90a0ff8720cf47c086f5a9948eef9cf2c` (the tree `pnpm bench:stress` extracted, M5.16a)
- **Method:** `pnpm bench:capped [--heap-mb=<n>] <folder>...` (`bench/src/capped.ts`): each folder through the worker's own sandboxed runner (`runAnalysis`: the given heap cap, 5 min, no network), one after another. New in M5.17c2c: the child reports its peak RSS (`process.resourceUsage().maxRSS`), its V8 heap after serializing (`heapTotal`), and the graph's size.
- **Code:** gitinside `bf2ebce` plus M5.17c2c's changes (uncommitted while measuring).
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, Windows 11, Node v22.13.0. Only 2.4 GiB of RAM was free during the runs (other programs open), so these times are 2–3× M5.16b's for the same folders and shouldn't be compared with them.
- **Runs:** one per folder and cap. Raw lines are below.

## Raw output

Heap cap 3,072 MB (the worker's default before M5.17c2c):

```json
{"folder":".repos/calcom","maxSourceMb":50,"sourceFiles":5073,"sourceMib":18,"ok":true,"ms":97882,"lastStep":"assemble","lastStepAtMs":95347,"stageMs":{"inventory":4148,"workspace":1635,"programs":28512,"imports":6873,"express":130,"next":3095,"prisma":3963,"infra":75,"files":5074,"symbols":234,"calls":16892,"http":15338,"sdk":5604,"queues":2999,"assemble":963},"graphMib":24.7,"peakRssMib":2216.7,"heapMib":2135.6}
{"folder":".repos/vscode-11ba54a-tree/src/vs/platform","maxSourceMb":50,"sourceFiles":3512,"sourceMib":44.8,"ok":true,"ms":125004,"lastStep":"assemble","lastStepAtMs":118311,"stageMs":{"inventory":2244,"workspace":2,"programs":24909,"imports":4460,"express":119,"next":1,"prisma":3,"infra":6,"files":5210,"symbols":282,"calls":32641,"http":37818,"sdk":9609,"queues":52,"assemble":1587},"graphMib":53.5,"peakRssMib":2523.3,"heapMib":1113.3}
{"folder":".repos/vscode-11ba54a-tree/extensions","maxSourceMb":50,"sourceFiles":3698,"sourceMib":33.2,"ok":true,"ms":96727,"lastStep":"assemble","lastStepAtMs":91635,"stageMs":{"inventory":2122,"workspace":14,"programs":21694,"imports":3769,"express":121,"next":1,"prisma":3,"infra":32,"files":3592,"symbols":320,"calls":27173,"http":23326,"sdk":8472,"queues":62,"assemble":1363},"graphMib":50,"peakRssMib":1957.2,"heapMib":1175.7}
{"folder":".repos/vscode-11ba54a-tree/src/vs/editor","maxSourceMb":50,"sourceFiles":885,"sourceMib":10.1,"ok":true,"ms":25442,"lastStep":"assemble","lastStepAtMs":23693,"stageMs":{"inventory":609,"workspace":1,"programs":2211,"imports":1193,"express":48,"next":2,"prisma":3,"infra":3,"files":917,"symbols":114,"calls":10656,"http":5136,"sdk":2122,"queues":15,"assemble":587},"graphMib":19.9,"peakRssMib":758.9,"heapMib":688.7}
```

Heap cap 2,048 MB (`--heap-mb=2048`):

```json
{"folder":".repos/calcom","maxHeapMb":2048,"maxSourceMb":50,"sourceFiles":5073,"sourceMib":18,"ok":true,"ms":60246,"lastStep":"assemble","lastStepAtMs":43735,"stageMs":{"inventory":2837,"workspace":41,"programs":13101,"imports":2663,"express":39,"next":754,"prisma":2695,"infra":66,"files":4829,"symbols":88,"calls":7248,"http":4495,"sdk":1713,"queues":2564,"assemble":2541},"graphMib":24.7,"peakRssMib":1993.1,"heapMib":753.9}
{"folder":".repos/vscode-11ba54a-tree/src/vs/platform","maxHeapMb":2048,"maxSourceMb":50,"sourceFiles":3512,"sourceMib":44.8,"ok":true,"ms":127818,"lastStep":"assemble","lastStepAtMs":123740,"stageMs":{"inventory":3113,"workspace":6,"programs":27042,"imports":4405,"express":97,"next":2,"prisma":5,"infra":9,"files":3373,"symbols":259,"calls":34530,"http":40073,"sdk":9845,"queues":65,"assemble":2709},"graphMib":53.5,"peakRssMib":2138.9,"heapMib":538.3}
```

The worker parent and the unpacked trees (scratch script: the worker's modules loaded, then each tree walked without `.git`; "tar" adds a 512-byte header and 512-byte padding per file, as GitHub's tarball does; "pages" rounds each file and folder up to 4 KiB, as an in-memory `/tmp` stores them):

```json
{"parentRssMib":96.8,"heapMib":67.5}
{"dir":"bench/.repos/calcom","entries":10289,"bytesMib":197.2,"tarMib":202.9,"pagesMib":228.3}
{"dir":"bench/.repos/vscode-11ba54a-tree","entries":25232,"bytesMib":309.9,"tarMib":325.2,"pagesMib":374.2}
```

## Observations (hand-written, not generated)

- **Peak RSS follows the cap, not the need.** Under 3,072 MB, `src/vs/platform` peaked at 2,523 MiB but held 1,113 MiB of heap at the end; under 2,048 MB the same run peaked at 2,139 MiB and finished in about the same time (125 s and 128 s). V8 collects less often while it has room, so the 3,072 MB peak was mostly garbage. cal.com behaved the same way: 2,217 MiB peak under 3,072, 1,993 under 2,048, both finished.
- **About 90 MiB lives outside the old-space cap.** `src/vs/platform`'s 2,048 MB run peaked 91 MiB over the cap (cal.com's stayed 55 MiB under it): the young generation, compiled code, and Node's own buffers. The budget keeps 256 MiB for it.
- **The graph is about the size of the source.** 53.5 MiB of graph from 44.8 MiB of source (`src/vs/platform`), 50.0 from 33.2 (`extensions`), 24.7 from 18.0 (cal.com), 19.9 from 10.1 (`src/vs/editor`): 1.2 to 2.0×. Against the 50 MB source limit that's up to about 100 MiB, inside the budget's 128 MiB, though nothing enforces it.
- **The tree's page rounding is real but modest.** Rounding each file to 4 KiB adds 49 MiB to VS Code's 325 MiB stream (25,232 entries) and 25 MiB to cal.com's 203 MiB. The budget's bound (a full page per entry) is the worst case, for a repo of tiny files.
- **The worker process is small:** 96.8 MiB resident with all its modules loaded. Publishing reads and gzips the graph after the child has exited, so it never adds to the child's peak.
- **What wasn't measured:** a run under the new 2,560 MB cap itself (2,048 is the stricter test), any folder between 45 and 50 MiB of source, and Cloud Run: its 1 vCPU and Linux memory accounting may differ. The child now stores `peakRssBytes` and `heapBytes` with every analysis, so M5.13's production runs will show it.
- **Times here aren't comparable** with M5.16b's: only 2.4 GiB of RAM was free (other programs open), and cal.com took 98 s under 3,072 MB against 38 s then. The memory readings come from the child itself and aren't affected the same way, but on Windows the peak RSS is the peak working set, which reads low once memory is paged out; the heap readings don't have that problem.
