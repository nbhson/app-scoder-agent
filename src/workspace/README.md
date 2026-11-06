# workspace/ — build & worktree state

**Responsibility:** build runner (`build.ts`), unified diff (`diff.ts`),
snapshot checkpoints (`snapshot.ts`), diagnostics parsing (`diagnostics.ts`),
file index for @-completion (`file-index.ts`), watcher (`watch.ts`).

**Anti-patterns:** caching without a full invalidation key.
