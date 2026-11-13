# Fact cache sizes (M6.7f1)

How much room one analysis's cached facts take in the worker's in-memory `/tmp`, to size the
cache's share of the 4 GiB Cloud Run instance (ADR-0178).

- **Measured:** 2026-11-02, analyzer at `9be9486` + uncommitted cache changes (the block count
  only; the facts are unchanged), Windows dev laptop.
- **How:** a scratch script ran `analyze(repo, { cache })` cold into an empty folder opened with
  `openDiskCache(dir, { blockBytes: 4096 })`, then read the folder's size with and without
  rounding each entry up to whole 4 KiB pages. One entry per service.

| Repo | Commit | Services | Entries | Gzipped bytes | In 4 KiB pages | Graph bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| fixtures/shop-demo | `9be9486` | 2 | 2 | 3,337 | 8,192 | 21,678 |
| shadcn-ui/taxonomy | `298a885` | 1 | 1 | 27,457 | 28,672 | 439,184 |
| krishnaacharyaa/wanderlust | `2d83720` | 3 | 3 | 21,254 | 28,672 | 263,031 |
| cal.com | `0f19cc4` | 113 | 113 | 26,295,056 | 26,472,448 | 26,023,666 |
| VS Code `src/vs/platform` | `11ba54a` | 1 | 1 | 2,102,552 | 2,105,344 | 56,148,946 |

Raw lines:

```
{"repo":"fixtures/shop-demo","services":2,"entries":2,"gzBytes":3337,"pagedBytes":8192,"graphBytes":21678}
{"repo":"eval/.repos/taxonomy","services":1,"entries":1,"gzBytes":27457,"pagedBytes":28672,"graphBytes":439184}
{"repo":"eval/.repos/wanderlust","services":3,"entries":3,"gzBytes":21254,"pagedBytes":28672,"graphBytes":263031}
{"repo":"bench/.repos/calcom","services":113,"entries":113,"gzBytes":26295056,"pagedBytes":26472448,"graphBytes":26023666}
{"repo":"bench/.repos/vscode-11ba54a-tree/src/vs/platform","services":1,"entries":1,"gzBytes":2102552,"pagedBytes":2105344,"graphBytes":56148946}
```

## Observations

- cal.com's facts take 25.2 MiB in pages, about its graph's size (24.8 MiB). Not broken down
  further here; each entry holds its service's facts and its observed inputs (a path and a
  hash per file read).
- One big service compresses well: `src/vs/platform`'s single entry is 2.0 MiB against a
  53.5 MiB graph.
- Page rounding matters only for small repos (shop-demo: 3.3 KB of data in 8 KiB).
- A 64 MiB cache holds two cal.com-sized analyses, e.g. a PR's base and head, which share
  their unchanged services' entries anyway.
