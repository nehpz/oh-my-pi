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
The sync operation: rebasing the Patch Stack from the old Upstream Snapshot onto a new one. A Replant runs in an isolated worktree so the production checkout never sits mid-rebase, and finishes with Promotion only after verification passes.

### Promotion
Moving the fork's mainline to the verified replanted head and force-pushing it. Promotion cannot be a fast-forward — snapshots are unrelated histories — so it is an explicit pointer move, made atomic by doing all verification beforehand.

### Supersession
Retirement of a Patch because upstream now satisfies its intent. Detected by running the Patch's own tests against the bare Upstream Snapshot (materializing the test files first, since they ship inside the Patch): if the tests pass without the Patch, upstream has absorbed it and the Patch is dropped, recorded in the Sync Log.

### Mechanical Drift
Conflict during a Replant where the patched logic still exists in recognizably the same shape and only its surroundings moved. Resolved in place without review. The test: a reviewer could verify the resolution from the conflict hunk alone.

### Semantic Drift
Conflict during a Replant where upstream rewrote the logic a Patch modifies. Never resolved by picking sides in conflict markers — the Patch is re-implemented from its commit-message intent against the new upstream code and reviewed as an isolated diff before Promotion.

### Sync Log
The append-only record of each sync — base transition, per-Patch outcome, retirements and re-implementations — kept in the fork-maintenance runbook and committed as part of the Patch Stack.
