---
title: Stale Native Addon Causes Undefined diffLines During Edit
module: natives
category: runtime-errors
date: 2026-07-27
problem_type: runtime_error
component: tooling
severity: high
symptoms:
  - "diffLines is not a function after an upstream sync"
  - "The edit tool changes the target file, then reports failure while rendering its result"
  - "A rebuilt addon on disk does not repair an already-running omp process"
root_cause: missing_validation
resolution_type: code_fix
related_components:
  - development_workflow
tags:
  - pi-natives
  - native-addon
  - edit-tool
  - sentinel-validation
  - upstream-sync
---

# Stale Native Addon Causes Undefined diffLines During Edit

## Problem

After the v17.1.6 upstream sync, the live checkout could run updated JavaScript against an older ignored `packages/natives/native/*.node` binary. Workspace loads accepted that binary without checking its package-version sentinel, so newly generated exports such as `diffLines` were `undefined`.

The edit path made this particularly hazardous: hashline patching commits the file before producing the rendered diff (`packages/coding-agent/src/edit/hashline/execute.ts:220-230`), while diff rendering calls the native `diffLines` export afterward (`packages/coding-agent/src/edit/diff.ts:232-238`). The file therefore changed successfully even though the tool returned `diffLines is not a function`.

## Symptoms

- Every OpenAI-backed `edit` call in the observed window failed with `diffLines is not a function`.
- Reading a target after a failed edit showed that the requested change had already landed.
- A fresh process reported native exports correctly after rebuilding, while the process that had loaded the old addon continued failing.

## What Didn't Work

- **Rebuilding without restarting.** `bun run build:native` replaces the binary on disk, but it cannot replace a native module already resident in the current Bun/Node process. The old process must be restarted.
- **Treating a tool error as proof that no write occurred.** The write precedes result rendering, so blindly retrying with the same hashline anchor can target content that no longer exists.
- **Skipping workspace sentinel validation.** That deferred an actionable startup mismatch into an unrelated native-call failure later in edit rendering.
- **Copying a live addon directly over its destination.** An independent review found that a reader could observe an incomplete binary during promotion; staging under a temporary name and renaming avoids that partial-file state (session history).

## Solution

### Validate workspace addons at load time

`validateLoadedBindings` now requires the expected version sentinel for every load (`packages/natives/native/loader-state.js:624-669`). It distinguishes two recovery paths:

```javascript
if (typeof bindings[ctx.versionSentinelExport] === "function") return;

if (residentSentinel && diskHasExpectedSentinel) {
	throw new Error("... Disk is already consistent — restart omp ...");
}

throw new Error(
	ctx.isWorkspaceLoad
		? "... run `bun run build:native`, then restart omp."
		: "... reinstall to re-sync.",
);
```

The loader scans the binary for the on-disk sentinel in bounded 64 KiB chunks, carrying enough bytes between reads to detect a sentinel split across a chunk boundary (`packages/natives/native/loader-state.js:603-621`). Workspace-level fallback help repeats the rebuild-and-restart sequence (`packages/natives/native/loader-state.js:692-716`).

### Promote rebuilt worktree addons without partial-file replacement

The sync workflow now rebuilds the host worktree addon unconditionally before verification (`scripts/sync-upstream.ts:278-284`). Promotion enumerates every `.node` file present in the reusable worktree, refuses an empty source, stages each file beside its destination, and atomically renames it into place (`scripts/sync-upstream.ts:251-276`). `promote()` performs this installation before deleting the worktree and resetting the live checkout (`scripts/sync-upstream.ts:340-354`). Because ignored addons can persist across resumed runs, this helper does not by itself prove that every copied cross-platform or alternate-variant file was rebuilt.

```typescript
console.log("promoting verified native addon to live checkout...");
await installVerifiedNativeAddon(worktreePath, repoRoot);
await git(["worktree", "remove", "--force", worktreePath]).quiet();
```

### Restart the process

Rebuilding repairs disk state; restarting repairs process state. After restarting omp and resuming the same conversation, a live `edit` smoke test changed a temporary file from `before` to `after`, returned a normal diff result, and persisted the new content without an error.

## Why This Works

The sentinel check moves failure to native initialization, where the loader knows both the package version and selected addon path and can prescribe the correct recovery. When resident bindings carry a prior version sentinel, inspecting both those exports and the binary on disk separates two otherwise identical-looking states:

- **Disk stale:** replace the addon with a matching build, then restart.
- **Process stale:** disk already contains the expected addon; restart only.

The sync changes close the host workflow gap that created the observed mismatch: the host addon is rebuilt before verification and included in live promotion, while atomic rename prevents a reader from opening a half-copied file. Restarting after promotion remains necessary because native module caching is process-local.

## Prevention

- Keep version-sentinel validation enabled for workspace, installed-package, and compiled-binary loads.
- Treat any post-write rendering failure as potentially committed; re-read the file before retrying an edit.
- Rebuild native addons unconditionally in reusable sync worktrees because ignored build artifacts survive failed or resumed runs.
- Promote the current host output that passed verification, fail closed when none exists, and replace each binary atomically; do not treat unrelated leftover variants in the reusable worktree as verified.
- Preserve regression coverage for stale workspace diagnostics, process-versus-disk diagnosis, chunk-boundary sentinel scans, empty verified builds, and replacement of stale live addons (`packages/natives/test/issue-4812-repro.test.ts`, `scripts/sync-upstream.test.ts`).

## Related Issues

- [Issue #4812](https://github.com/can1357/oh-my-pi/issues/4812) — original process-stale sentinel diagnosis.
- [Upstream Sync for History-Truncated Forks via Patch-Stack Replant](../workflow-issues/upstream-sync-history-truncated-fork.md) — parent workflow whose native build and promotion stages were hardened by this fix.
