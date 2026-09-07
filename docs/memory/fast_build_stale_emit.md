# fast-build: pruning the validate emit dir

`compile validate` emits declarations into `<pkg>/.validate/emit` and `syncDirectory` mirrors that
into `<pkg>/types`. tsc writes the emit dir incrementally and never cleans up, so a deleted `x.ts`
left `x.d.ts` behind forever and the ghost was copied back into `types/` on every run - a ghost
`transfer.d.ts` next to a real `transfer/` shadows it for `export * from './transfer'`, and every
consumer keeps seeing the pre-split API. `pruneEmitDir` in `platform-rig/bin/validate-worker.js`
drops emit files whose source is gone.

## Do not use ts.getOutputFileNames here (2026-09-03)

Without an explicit `rootDir` that call throws `Debug Failure` from
`getCommonSourceDirectoryOfConfig`, and the `try/catch` around it turned every throw into an empty
expected set - so the prune deleted the whole emit dir and `syncDirectory` removed the same files
from `types/`. CI failed with `TS7016: Could not find a declaration file for module
'@hcengineering/platform'` across ~450 packages; the log names it in one line - the first package
validated as `[0c/0u/26r]`, nothing copied, 26 removed. **Any `[0c/0u/*r]` is that bug.**

It hides locally: with no emit dir from a previous run the prune empties the fresh one,
`cleanEmptyDirs` removes it, and `syncDirectory` returns early on a missing source, leaving `types/`
intact. Only a warm emit dir (CI restores one from cache) exposes it.

Output paths are now derived directly - relative to `options.rootDir`, else to the common directory
of the source file names, extension stripped. An empty expected set returns early.
