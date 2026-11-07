# diff-export-base / diff-export-head

A pair for `packages/diff` (M7.2e): `diff-export-head` is this repo one commit later, with the shape of the break the backtest missed in `getmaxun/maxun#1157` (`eval/results/2026-11-backtest-zero-check.md`).

- `src/interpreter.ts` was emptied, but `src/run.ts` still imports `Interpreter` from it and calls `Interpreter.parse` (in `run`) and `Interpreter.extract` (in `quiet`): two broken connections, `TARGET_REMOVED`, at the import in `src/run.ts`.
- `whisper` was deleted from `src/format.ts`, which still exports `shout`, but `quiet` still imports and calls it: broken, `TARGET_REMOVED`. `run`'s call to `shout` still works.
- `src/limits.ts` still imports `MAX_SIZE` from the emptied file. Its import site lists the name as missing (`missingExports`), but reading a constant isn't a call edge, so nothing is flagged.

Both calls make no `unresolved` node in head, and the import edges survive with their files, so the only evidence is the import sites' `missingExports`. The expected diff lists exactly those three broken connections.
