---
title: "Fork sync to upstream: resolve .gitignore rebase conflicts and verify Bazel build"
date: 2026-07-27
category: workflow-issues
module: sync-upstream
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Rebasing a fork onto an upstream release tag stops with a .gitignore conflict"
  - "Upstream adds Bazel ignore blocks while the fork retains local dev ignore entries"
  - "Verifying a native build after sync requires bazelisk because upstream switched to Bazel"
  - "sync-upstream status subcommand tests run in git worktrees where Bun Shell .text() capture can be empty"
symptoms:
  - "Fork sync to upstream v17.1.6 halts during rebase on .gitignore conflict"
  - "Native build verification fails without bazelisk installed"
  - "sync-upstream status subcommand test fails in worktrees due to empty Bun Shell .text() output"
resolution_type: workflow_improvement
tags:
  - fork-sync
  - gitignore
  - rebase
  - bazelisk
  - sync-upstream
  - worktree
  - bun-shell
---

# Fork sync to upstream: resolve .gitignore rebase conflicts and verify Bazel build

## Context

During `bun scripts/sync-upstream.ts v17.1.6`, the replant stopped while applying patch **`cb235771c`** (`chore(dev): add local config example and gitignore entries`) with a **`.gitignore` conflict**.

Upstream **v17.1.6** added a **Bazel** ignore block (build outputs under `/bazel-*`, `/.bazelrc.user`, and related paths). The fork patch adds **local dev** ignores (`.compound-engineering/*.local.yaml`, `.stakpak/session*`). Both edits target the same file region but do not contradict each other—they are **orthogonal additions**.

Per `docs/fork-maintenance.md`, sync work never happens on production `main`. The script provisions a sibling worktree next to the repo root (`worktreePath` in `scripts/sync-upstream.ts`), runs `git rebase --onto upstream/vX.Y.Z <old-base> sync/vX.Y.Z`, and **exits nonzero on conflict** after printing `formatConflictReport()`—it does not auto-resolve. Resume by fixing the conflict in the worktree, continuing the rebase, and re-running the same script version argument.

After a clean replant, **verify** runs `prepareWorktree()` in the sync worktree: `bun install`, then `bun run build:native` when no `*.node` addon exists under `packages/natives/native`. Upstream v17.1.6 builds natives via Bazel (`scripts/bazel-natives.ts`); **`bazelisk` must be on PATH** or that step fails even when the rebase succeeded.

A separate verify failure hit **`scripts/sync-upstream.test.ts`**: the `status subcommand` integration test spawned the script in a temp git repo and read stdout via Bun Shell `.text()`, which returned **empty** under `bun test` in worktree contexts. Fix **`96ae53d7f`** captures stdout to a temp file via `Bun.spawn` + `Bun.file(outFile).text()`.

The v17.1.5 → v17.1.6 sync completed with **15 patches** kept, `main` on `upstream/v17.1.6`, and services healthy after promotion.

## Guidance

### 1. Classify the conflict (mechanical vs semantic)

When `sync-upstream.ts` exits with a report like:

```text
replant stopped: conflict while applying <sha> <subject>
  ...
resolve in the sync worktree (path from scripts/sync-upstream.ts) per docs/fork-maintenance.md:
  mechanical drift -> fix markers, `git rebase --continue`, re-run this script
  semantic drift   -> `git rebase --skip`, re-implement from the commit message intent
```

Apply the runbook rule from `docs/fork-maintenance.md`:

- **Mechanical drift**: the patch's intent still applies; only surroundings moved (formatting, neighboring lines, file moves). Resolve conflict markers so the patch's change lands in the new layout, then continue.
- **Semantic drift**: upstream rewrote the logic the patch touches. Do **not** hand-merge markers—`git rebase --skip`, re-implement from the patch commit message, get maintainer approval before promotion.

**`.gitignore` with upstream Bazel block + fork local entries is mechanical**: keep both sections; no semantic re-implementation.

### 2. Resolve `.gitignore` in the sync worktree

1. Open `.gitignore` in the sync worktree (path printed in the conflict report, or the sibling directory defined by `worktreePath` in `scripts/sync-upstream.ts`).
2. Remove conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
3. Retain **upstream's Bazel block** and **fork's local dev lines** from the patch.
4. Stage and continue:

```bash
cd <sync-worktree>   # sibling of repo root; see scripts/sync-upstream.ts
git add .gitignore
git rebase --continue
```

If Git reports a rebase still in progress when you re-run the script before continuing, `replant()` throws: finish continue/skip first.

### 3. Re-run sync and let verify run

From the repo root (clean tracked tree on `main`):

```bash
bun scripts/sync-upstream.ts v17.1.6
```

The script detects an existing worktree and resumes. After replant completes, it runs verification (install, native build if needed, supersession checks, tests, promotion)—see `prepareWorktree()` and downstream phases in `scripts/sync-upstream.ts`.

### 4. Install `bazelisk` if native build fails

If verify stops at:

```text
verify: building natives (addon missing in worktree)...
```

and the error is **`bazelisk` / `bazel` not found**, install a Bazel launcher (e.g. `brew install bazelisk`) so `bun run build:native` can invoke `scripts/bazel-natives.ts`. First Bazel builds can take many minutes; re-run the sync script after the addon appears under `packages/natives/native`.

### 5. Fix flaky status subcommand test (if verify fails on tests)

If `bun test scripts/sync-upstream.test.ts` fails because the **`status subcommand`** case sees empty stdout when using Bun Shell capture in a temp/worktree repo, use file-based capture (see Examples). This is a test harness fix, not a change to sync behavior.

## Why This Matters

- **Wrong `.gitignore` resolution drops real ignores**: omitting the Bazel block leaves Bazel artifacts untracked noise; omitting fork entries leaks local config/session paths into commits.
- **Production `main` stays safe**: conflicts are resolved only in the sync worktree until verify and promotion succeed (`docs/fork-maintenance.md`).
- **Verify gates promotion**: missing natives breaks supersession probes and downstream tests that copy the built addon from the worktree.
- **Flaky test capture blocks promotion** even when `status` works interactively—file-based spawn output is reliable across `bun test` and worktree layouts.

## When to Apply

Use this playbook when:

| Trigger | Action |
|--------|--------|
| `sync-upstream.ts` exits 1 with `CONFLICTED` on a chore/dev `.gitignore` patch | Mechanical merge: union upstream + fork sections |
| Upstream release adds tooling (Bazel) that changes ignore patterns | Prefer upstream tool blocks; re-apply fork-only paths |
| `prepareWorktree()` fails on `build:native` with missing `bazel`/`bazelisk` | Install `bazelisk`, rebuild, re-run sync |
| `status subcommand` test passes locally but fails in CI/worktree with empty `.text()` | Apply `Bun.spawn` + stdout file pattern |
| Unsure mechanical vs semantic | Ask: can a reviewer verify from the hunk alone? (`docs/fork-maintenance.md`) |

## Examples

### `.gitignore` — conflict markers (before)

Git shows two sides separated by conflict markers. In the worktree, remove the marker lines and keep both sides:

```gitignore
# ... shared content above ...

# --- upstream (HEAD) ---
# Bazel
/bazel-bin
/bazel-out
/bazel-testlogs
/bazel-pi
/.bazelrc.user

# --- fork patch cb235771c ---
.compound-engineering/*.local.yaml

# Stakpak session files
.stakpak/session*
```

### `.gitignore` — resolved (after)

Both sides kept (matches fork `main` after v17.1.6 sync):

```gitignore
# Bazel
/bazel-bin
/bazel-out
/bazel-testlogs
/bazel-pi
/.bazelrc.user
.compound-engineering/*.local.yaml

# Stakpak session files
.stakpak/session*
```

### Status test — flaky capture (before)

```typescript
const res = await $`bun scripts/sync-upstream.ts status`.cwd(dir).quiet();
expect(res.text()).toContain("no 'upstream' remote configured");
```

### Status test — file capture (after)

From `scripts/sync-upstream.test.ts` (patch `96ae53d7f`):

```typescript
const outFile = path.join(dir, "status.out");
const proc = Bun.spawn(["bun", "scripts/sync-upstream.ts", "status"], {
	cwd: dir,
	stdout: Bun.file(outFile),
	stderr: "pipe",
});
const exitCode = await proc.exited;
const output = await Bun.file(outFile).text();
expect(exitCode).toBe(0);
expect(output).toContain("no 'upstream' remote configured");
expect(output).toContain("git remote add upstream");
```

### Resume command sequence (typical v17.1.6 path)

```bash
# In sync worktree after fixing .gitignore
git add .gitignore && git rebase --continue

# From repo root
bun scripts/sync-upstream.ts v17.1.6

# If natives build failed once
brew install bazelisk   # or your platform's equivalent
bun scripts/sync-upstream.ts v17.1.6
```

## Related

- [Upstream Sync for History-Truncated Forks via Patch-Stack Replant](./upstream-sync-history-truncated-fork.md) — parent workflow for orphan-snapshot replants
- `docs/fork-maintenance.md` — conflict decision rule, sync procedure, sync log entry for v17.1.5 → v17.1.6
- `scripts/sync-upstream.ts` — `formatConflictReport()`, `replant()`, `prepareWorktree()`, `worktreePath` sibling worktree
- `scripts/sync-upstream.test.ts` — `status subcommand` integration test
- `scripts/bazel-natives.ts` — Bazel driver for `build:native`
