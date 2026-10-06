---
title: Fold Post-Promotion Fixups Into the Patch Stack Without Rebasing Production main
date: 2026-10-06
category: workflow-issues
module: fork-maintenance
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "A fix found after Promotion must be folded into its owning Patch with git commit --fixup plus an autosquash rebase"
  - "Any history rewrite of the Patch Stack is needed while main is the production checkout"
  - "A fixup targets an older Patch whose neighboring lines a later Patch has since edited"
symptoms:
  - "git rebase -i --autosquash on main stops with CONFLICT (content) in docs/fork-maintenance.md"
  - "Production main is left mid-rebase until git rebase --abort"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - documentation
tags: [fork, patch-stack, fixup, autosquash, worktree, promotion, production-checkout]
---

# Fold Post-Promotion Fixups Into the Patch Stack Without Rebasing Production main

## Context

`docs/fork-maintenance.md:12` makes the checkout production: the `omp` CLI and the launchd auth services run from it, and "`main` must never sit in a broken or mid-rebase state". `docs/fork-maintenance.md:102` says a fix found after verification is folded "into the owning patch with `git commit --fixup` plus an autosquash rebase". That rule assumes the fix lands on the sync branch inside the Sync Worktree. It doesn't say where to run the fold when the fix arrives after Promotion, when the only copy of the Patch Stack is `main`.

During the v18.7.0 sync follow-up, two fixups were created on `main`: the `check:rs` gating in `scripts/sync-upstream.ts` and its test, plus a doc line in `docs/fork-maintenance.md`. Then `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash upstream/v18.7.0` ran directly on `main`. The doc fixup targeted the copy-on-write-clone Patch, which originally wrote that doc paragraph. A *later* Patch (deploy auth services to a remote service host) had since rewritten the line next to it. At the older Patch's position, the fixup's context didn't exist yet, so git stopped with a content conflict and production `main` sat mid-rebase until `git rebase --abort`.

The same lesson was learned once before (session history). On 2026-09-28 the sync-log squash was folded in a throwaway worktree (`git worktree add ../oh-my-pi-fold …`), checked by diffing against `main`, and only then moved onto `main`. That precedent was in session transcripts, not in the runbook, so it was rediscovered the hard way.

## Guidance

Never run an autosquash (or any rebase) of the Patch Stack in the production checkout. Fold in a throwaway worktree, prove the result is the same tree, then move `main` with one pointer update.

```bash
# fixups already committed on main (git commit --fixup=<owner> ...)
git worktree add -q -b fold-tmp /tmp/omp-fold main
cd /tmp/omp-fold
GIT_SEQUENCE_EDITOR=true git rebase -q -i --autosquash upstream/vX.Y.Z
# conflict here? It's isolated: fix or retarget (below), main is untouched

git diff main fold-tmp --stat | wc -l                                  # must be 0: same tree
git log --oneline upstream/vX.Y.Z..fold-tmp --grep='^fixup!' | wc -l   # must be 0: all folded
cd -
git worktree remove /tmp/omp-fold
git reset -q --keep fold-tmp && git branch -q -D fold-tmp
```

**Pick the fixup target by the lines it touches, not only by feature ownership.** A fixup applies at its target's position in the stack, before any later Patch. If a later Patch edited the same or neighboring lines, the fixup's context doesn't exist yet at that position and the fold conflicts. Find the last Patch that touched the region and target that instead:

```bash
git blame -L <start>,<end> --porcelain HEAD -- <file> | head -1   # last commit that touched the lines
git log --format='%h %s' <owner>..HEAD -- <file>                   # later Patches editing the same file
```

Code fixups usually still belong to the Patch that owns the behavior and its tests (Patch Stack convention, `CONCEPTS.md` → Patch). Retargeting is mainly for shared runbook prose, where many Patches touch nearby lines.

## Why This Matters

- **Production impact.** A mid-rebase `main` means the source-linked CLI and any service restart run a half-applied stack. `git rebase --abort` recovers, but only if someone notices before a restart or a new session starts.
- **`reset --keep` is the safe move.** Unlike `reset --hard`, it refuses to move if uncommitted local changes would be overwritten. Paired with an empty `git diff main fold-tmp`, it changes history only, not working files, so the running CLI and services see the same code.
- **The runbook rule alone leads here.** `fork-maintenance.md:102` tells a maintainer to autosquash. Without "where", the obvious place is the checkout they're standing in.

## When to Apply

- Folding any fix into an existing Patch after Promotion (verification fixes, doc corrections, test adjustments).
- Squashing or reordering fork commits on `main`, such as sync-log consolidation.
- Before the sync worktree is removed, prefer folding there instead (the `docs/fork-maintenance.md:102` case). This doc covers the case where it's already gone.

## Examples

v18.7.0 follow-up: on `main`, `git commit --fixup=<auto-sync Patch>` for the script and test, and `git commit --fixup=<clone Patch>` for the doc.

- **Before:** autosquash on `main` → `CONFLICT (content): Merge conflict in docs/fork-maintenance.md` → `main` mid-rebase → `git rebase --abort`.
- **After:**
  1. Recreate the doc fixup with `--fixup=<remote-service-host Patch>`, the last Patch that touched the neighboring line.
  2. Autosquash in `/tmp/omp-fold`: clean.
  3. Tree diff vs `main`: 0 lines. Leftover `fixup!` commits: 0. Commits since the upstream tag: 51 → 49.
  4. `git reset --keep fold-tmp`. `bun test scripts/sync-upstream.test.ts` still passes on the moved `main`.

## Related

- `docs/fork-maintenance.md` — production-checkout rule (line 12) and the fold rule this doc extends (line 102).
- `docs/solutions/workflow-issues/upstream-sync-history-truncated-fork.md` — Replant worktree isolation and explicit Promotion; same "main never mid-rebase" rule, applied to the sync itself.
- `docs/solutions/workflow-issues/generated-bazel-lock-refresh-replant.md` — why the script's own Replant runs `--no-autosquash`. That covers the script's Replant; this doc covers manual fixup folds.
- `docs/solutions/workflow-issues/fork-sync-upstream-gitignore-rebase-conflict.md` — earlier conflict incident, also resolved in a worktree rather than on `main`.
