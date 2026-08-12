---
title: Intermittent workspace containment failure on macOS hard links via Bun realpath
date: 2026-08-11
category: logic-errors
module: coding-agent
problem_type: logic_error
component: assistant
symptoms:
- "Intermittent sync-verify failure in packages/coding-agent/test/cursor-exec.test.ts: expected /hard links/, got 'Refusing to download outside the workspace'"
- confineToWorkspace returns null for a regular file that is lexically inside the workspace when the file has multiple hard links
- Test passes in isolation but flakes in multi-file runs under filesystem churn
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [bun, macos, realpath, hard-links, path-containment, flaky-test, cursor-exec]
---

# Intermittent workspace containment failure on macOS hard links via Bun realpath

## Problem

`bun scripts/sync-upstream.ts 17.2.15` verify failed intermittently on the upstream test `"refuses a download onto a hard link that shares its inode outside"` (`packages/coding-agent/test/cursor-exec.test.ts:1197`). The test expected the write refusal matching `/hard links/`, but got `Refusing to download outside the workspace: innocent.txt` — the containment check rejected a file that is lexically inside the workspace, before the hard-link write guard could run.

## Symptoms

- Test failure only in multi-file runs (the sync's 8-file patch-test batch); consistent pass when the file runs alone.
- `confineToWorkspace` returned `null` for an in-workspace hard link, producing the generic containment error instead of reaching the `stat.nlink > 1` guard in `writeWithoutFollowingLinks`.
- Direct probe: ~2% of `confineToWorkspace` calls (88/4000) rejected the in-workspace hard link under name-cache churn.

## What Didn't Work

1. **Suspected upstream v17.2.15 change** — disproved: both `confineToWorkspace` and the test are identical in v17.2.14 and v17.2.15; the flake predates the release.
2. **Suspected cross-test-file interference from `scripts/sync-upstream.test.ts`** — its stale-directory log line interleaved into the failure output suggested leaked filesystem state. Disproved: reruns of the full 8-file batch and forced file orderings passed; the interleaving was coincidental.
3. **Switching to non-native `fs.realpathSync`** — disproved by probing: under Bun, `fs.realpathSync` and `fs.realpathSync.native` are the same `fcntl(F_GETPATH)`-backed implementation, and both returned the flipped name.

## Solution

Fixed in fork commit `095fd020b` (*fix(coding-agent): decide non-symlink containment by the parent directory*): never realpath a non-symlink final path component.

Before (the existing-target branch realpath'd the file itself, triggering the F_GETPATH nondeterminism on hard links):

```typescript
// An existing target is authoritative: resolve it outright.
const realTarget = tryRealpath(resolved);
if (realTarget) return isUnderRootLexical(realTarget, realRoot) ? resolved : null;
if (isSymlink(resolved)) return null; // dangling link
// ...ancestor walk for nonexistent targets
```

After (`packages/coding-agent/src/tools/path-utils.ts:581-605`): a symlink final component is resolved outright; every other final component — existing or not — falls into the pre-existing ancestor walk, which realpaths the deepest existing **ancestor directory** and re-appends the `..`-free tail:

```typescript
if (isSymlink(resolved)) {
	const realTarget = tryRealpath(resolved);
	return realTarget && isUnderRootLexical(realTarget, realRoot) ? resolved : null;
}

let ancestor = path.dirname(resolved);
const tail: string[] = [path.basename(resolved)];
for (;;) {
	const real = tryRealpath(ancestor);
	if (real) {
		return isUnderRootLexical(path.join(real, ...tail.reverse()), realRoot) ? resolved : null;
	}
	const parent = path.dirname(ancestor);
	if (parent === ancestor || !isUnderRootLexical(ancestor, root)) return null;
	tail.push(path.basename(ancestor));
	ancestor = parent;
}
```

A deterministic regression test (`packages/coding-agent/test/confine-to-workspace.test.ts`) pins the kernel's worst case by spying on `fs.realpathSync.native` to return the inode's *outside* name for the target path — no stress iterations, fails reliably pre-fix:

```typescript
const realNative = fs.realpathSync.native;
const spy = spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike) =>
	p === target
		? path.join(realNative(outside), "secret.txt")
		: realNative(p)) as typeof fs.realpathSync.native);
try {
	expect(confineToWorkspace("innocent.txt", inner)).toBe(target);
} finally {
	spy.mockRestore();
}
```

## Why This Works

- **F_GETPATH is unspecified for multi-link inodes.** On macOS under Bun, realpath is backed by `fcntl(F_GETPATH)`, which returns whichever of the inode's names the kernel vnode cache currently holds. For a file with `nlink > 1`, that is nondeterministic under cache churn — this session's probes observed realpath of `ws/innocent.txt` returning `outside/secret.txt`, and observed both `fs.realpathSync` variants flipping. Realpath'ing the final component therefore made the containment verdict depend on kernel cache state.
- **Parent-directory resolution is deterministic.** POSIX forbids hard links on directories, so a directory path has exactly one realpath. A hard link shares an inode but never relocates the path being written; only a symlink does. Deciding containment as `realpath(parent) + basename` removes the nondeterminism without weakening the check.
- **Security held throughout.** A name flip can only swap names of the *same inode*, and any flip-to-accept was still refused downstream: `writeWithoutFollowingLinks` (`packages/coding-agent/src/cursor.ts:175-205`) opens with `O_NOFOLLOW` and rejects `stat.nlink > 1` on the opened handle (`packages/coding-agent/src/cursor.ts:195-199`). The bug was a determinism/UX defect, not a containment hole.

## Prevention

- **Never realpath a final path component to decide containment.** Resolve the parent directory and re-append the basename; realpath the component itself only when it is a symlink. This applies to any guard comparing a resolved path against a workspace root.
- **Pin kernel nondeterminism with a spy, not stress loops.** When a bug depends on kernel state (vnode name cache, syscall ordering), a regression test that spies the syscall wrapper to force the worst case fails deterministically pre-fix; stress iterations only fail probabilistically.

## Related Issues

- Fork commit `095fd020b`: `fix(coding-agent): decide non-symlink containment by the parent directory` (no PR — fork main promotes via sync force-push)
- Sibling cursor-exec learning: [cursor-exec-delete-policy-denial-rejection-contract.md](cursor-exec-delete-policy-denial-rejection-contract.md) (same subsystem, unrelated root cause)
- Containment implementation: `packages/coding-agent/src/tools/path-utils.ts:558-606`; write guards: `packages/coding-agent/src/cursor.ts:175-205`; original flaky test: `packages/coding-agent/test/cursor-exec.test.ts:1197-1228`
