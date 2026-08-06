# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Fork Maintenance

### Upstream Snapshot
A release published by upstream as a single parentless commit carrying the whole tree and no history. Snapshots share no ancestry with each other or with the fork, which makes merging impossible and makes explicit base tags the only way to know what the fork is based on.

### Patch Stack
The fork's entire delta from upstream, kept as a linear sequence of self-contained commits directly atop the current Upstream Snapshot. The stack is always inspectable as the commits between the current base and the fork's tip; it contains no merge commits.

### Patch
One self-contained commit in the Patch Stack. A Patch carries its intent in its commit message (detailed enough to re-implement the change from the message alone) and owns the tests that prove its behavior — those tests double as its Supersession contract. Patches never edit upstream changelog files.

### Replant
The sync operation: rebasing the Patch Stack from the old Upstream Snapshot onto a new one. A Replant runs in the Sync Worktree so the production checkout never sits mid-rebase, and finishes with Promotion only after verification passes.

### Sync Worktree
The disposable, sync-owned checkout a Replant runs in, separate from the production checkout. It exists only between the start of a Replant and Promotion; the sync owns its entire lifecycle and may destroy it at any time, so nothing durable belongs inside it. A directory left at its path that git no longer registers as a worktree is a stale remnant — cleared automatically before the next Replant unless it contains a `.git` entry, in which case the sync stops rather than risk deleting a real checkout. Long-lived tool sessions must not keep their working directory inside it: they recreate runtime state there after removal, which is what produces stale remnants.

### Promotion
Moving the fork's mainline to the verified replanted head and force-pushing it. Promotion cannot be a fast-forward — snapshots are unrelated histories — so it is an explicit pointer move, made atomic by doing all verification beforehand.

### Supersession
Retirement of a Patch because upstream now satisfies its intent. Detected by running the Patch's own tests against the bare Upstream Snapshot (materializing the test files first, since they ship inside the Patch): if the tests pass without the Patch, upstream has absorbed it and the Patch is dropped, recorded in the Sync Log.

### Generated Lock Refresh
A Patch whose exact versioned `build(natives): refresh Bazel lock for vX.Y.Z` subject and sole `MODULE.bazel.lock` change identify release-scoped generated state rather than durable fork intent. During a Replant it is dropped from the rebase todo, reported explicitly, and replaced by the target snapshot plus native preparation; broader lock changes remain ordinary Patches.

### Native Preparation Mode
The sync producer selected after generated-lock refreshes are partitioned:
`npm` acquires the exact official platform leaf for routine upstream-equivalent
artifacts, while `bazel` is required for native-contract changes. The retained
macOS 27 Rust toolchain/checksum overlay is builder compatibility only and stays
npm-eligible. Auto classification fails closed for unknown native-boundary edits;
there is no implicit producer fallback.

### Mechanical Drift
Conflict during a Replant where the patched logic still exists in recognizably the same shape and only its surroundings moved. Resolved in place without review. The test: a reviewer could verify the resolution from the conflict hunk alone.

### Semantic Drift
Conflict during a Replant where upstream rewrote the logic a Patch modifies. Never resolved by picking sides in conflict markers — the Patch is re-implemented from its commit-message intent against the new upstream code and reviewed as an isolated diff before Promotion.

### Contract Drift
A Replant state where the rebased code is syntactically valid but an upstream change has altered a fork-owned behavioral contract, such as a return variant, policy outcome, or error mapping. Contract Drift can sit beside a mechanically resolved conflict and evade side-effect-only tests; detect it by tracing the changed path through its consumer and asserting the Patch's observable contract.

### Sync Log
The append-only record of each sync — base transition, per-Patch outcome, retirements and re-implementations — kept in the fork-maintenance runbook and committed as part of the Patch Stack.

## Native Addon Loading

### Version Sentinel
A native export named for the package release that proves the JavaScript loader and selected addon were built for the same release.

### Disk-Stale Addon
A selected addon file that lacks the expected Version Sentinel, meaning the binary on disk must be replaced with a matching build—by rebuilding, reinstalling, re-extracting, or downloading—before the process restarts.

### Process-Stale Addon
Resident native bindings from an earlier release even though the selected addon file already carries the expected Version Sentinel; restarting the process is the only repair because rebuilding consistent disk state changes nothing in memory.
