# Ground-truth labels

One file per eval repo, named `<owner>__<name>.json`, in the format of [docs/EVALUATION.md §1](../../docs/EVALUATION.md#1-cross-service-accuracy-m3). `pnpm --filter @gitinside/eval validate` checks every file here.

Labels are drafted by reading the repo's code at the pinned SHA, **never** by looking at analyzer output, and are committed before the first scoring run (D10.3).
