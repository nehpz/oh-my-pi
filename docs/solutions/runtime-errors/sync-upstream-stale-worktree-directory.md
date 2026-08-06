---
title: "Stale unregistered sync worktree directory fails git worktree add with exit 128"
date: 2026-08-06
category: runtime-errors
module: scripts/sync-upstream.ts
problem_type: runtime_error
component: development_workflow
symptoms:
  - "bun scripts/sync-upstream.ts <version> aborts right after 'tagged rollback point fork/pre-<version>' with git exit code 128"
  - "fatal: '../oh-my-pi-sync' already exists from git worktree add"
  - "../oh-my-pi-sync exists on disk (holding only a leftover .omp/ directory) but is absent from git worktree list"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [git, worktree, upstream-sync, fork-maintenance, replant, stale-directory]
---

# Stale unregistered sync worktree directory fails git worktree add with exit 128

## Problem

Running the fork's upstream sync (`bun scripts/sync-upstream.ts 17.2.10`) failed immediately after tagging the rollback point. The Replant phase ran `git worktree add -B sync/v17.2.10 ../oh-my-pi-sync main`, and git died with `fatal: '../oh-my-pi-sync' already exists` (exit 128): the disposable sync worktree path existed on disk but was no longer registered with git.

## Symptoms

- The sync aborts right after the snapshot phase with a raw git error:
  ```text
  tagged rollback point fork/pre-v17.2.10
  Failed with exit code 128
  ```
- `git worktree list --porcelain` does not mention `../oh-my-pi-sync`, yet the directory exists on disk — containing only a leftover `.omp/` subdirectory.

## What Didn't Work

- **The script's own resume logic.** `worktreeExists()` (scripts/sync-upstream.ts:447-450) consults only `git worktree list --porcelain`. An on-disk-but-unregistered directory falls through to the create path, where `git worktree add` fails hard with git's raw fatal — no actionable message and no recovery.
- **Re-running the sync with the fix uncommitted.** `preflight()` calls `assertCleanTree()` (scripts/sync-upstream.ts:405-407), which rejects any dirty tracked files, so the fix to the sync script itself had to be stashed for the duration of the sync run and restored afterwards.

## Solution

A fail-closed guard, `clearStaleWorktreeDirectory()` (scripts/sync-upstream.ts:460-482), now runs immediately before `git worktree add` in `replant()` (callsite at scripts/sync-upstream.ts:513). It reconciles disk state with git's registry:

- Path absent → no-op.
- Path present with a `.git` entry → throw (`"exists with a .git entry but is not a registered worktree of this repository — inspect and remove it manually, then re-run"`) so a real checkout is never clobbered.
- Otherwise → log and `fs.rm(worktreeDir, { recursive: true, force: true })`.

Before:

```typescript
if (await worktreeExists()) {
	console.log(`sync worktree already exists at ${worktreePath} (resuming)`);
} else {
	// died with exit 128 when ../oh-my-pi-sync existed on disk unregistered
	await git(["worktree", "add", "-B", syncBranch, worktreePath, "main"]).quiet();
}
```

After (scripts/sync-upstream.ts:460-482, 510-516):

```typescript
export async function clearStaleWorktreeDirectory(worktreeDir: string = worktreePath): Promise<void> {
	const exists = await fs.stat(worktreeDir).then(
		() => true,
		() => false,
	);
	if (!exists) return;
	const hasGit = await fs.stat(path.resolve(worktreeDir, ".git")).then(
		() => true,
		() => false,
	);
	if (hasGit) {
		throw new Error(
			`${worktreeDir} exists with a .git entry but is not a registered worktree of this repository — inspect and remove it manually, then re-run`,
		);
	}
	console.log(`removing stale directory at ${worktreeDir} (not a registered worktree)`);
	await fs.rm(worktreeDir, { recursive: true, force: true });
}

// in replant():
if (await worktreeExists()) {
	console.log(`sync worktree already exists at ${worktreePath} (resuming)`);
} else {
	await clearStaleWorktreeDirectory();
	await git(["worktree", "add", "-B", syncBranch, worktreePath, "main"]).quiet();
}
```

The fix is in the working tree but uncommitted as of this writing — no commit SHA yet; it should land as a fork Patch on the next commit.

## Why This Works

The root-cause chain is an external process re-poisoning the disposable worktree path:

1. An omp agent session ran with its cwd pinned inside `../oh-my-pi-sync` (the fork even carries a Patch, `chore(dev): pin the shared mnemopi bank for worktree sessions`, because sessions run there).
2. A previous sync's `removeSyncWorktree()` (scripts/sync-upstream.ts:453-458) unregistered and deleted the worktree.
3. The still-running session recreated `.omp/` inside the deleted path afterwards — leaving a directory git knows nothing about. A prior session (2026-08-05) debugging mnemopi memory-bank fragmentation across worktree dirs confirms agent sessions held cwds inside worktrees in this window. (auto memory)
4. The next sync's `worktreeExists()` is registry-only, so the leftover was invisible until `git worktree add` hit it.

The guard closes the registry/disk gap at the exact point the assumption was made, and the `.git` check bounds the blast radius: only content-free leftovers are auto-removed; anything that looks like a checkout stops the sync with instructions instead.

## Prevention

- The guard itself is the durable prevention: every future replant reconciles disk with the registry before `worktree add`.
- Operational hygiene: don't leave agent/tool sessions running with cwd inside the disposable sync worktree across syncs — they recreate runtime state (`.omp/`) after the worktree is removed.
- Contract test (scripts/sync-upstream.test.ts, "clears a stale unregistered directory but refuses one holding a .git entry"): missing path is a no-op; leftover junk (a recreated `.omp/`) is removed; a directory holding a `.git` entry is refused and its content preserved.

## Related Issues

- [Upstream Sync for History-Truncated Forks via Patch-Stack Replant](../workflow-issues/upstream-sync-history-truncated-fork.md) — the sync architecture this script implements (Replant, Promotion, worktree isolation)
- [Fork sync to upstream: resolve .gitignore rebase conflicts and verify Bazel build](../workflow-issues/fork-sync-upstream-gitignore-rebase-conflict.md) — incident playbook for conflicts inside the same sync worktree
