---
title: Automatically Drop Version-Scoped Bazel Lock Refreshes During Upstream Replants
date: 2026-07-31
category: workflow-issues
module: fork-maintenance
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "replanting the fork Patch Stack onto a newer parentless Upstream Snapshot"
  - "a Patch subject exactly matches build(natives): refresh Bazel lock for vX.Y.Z and changes only MODULE.bazel.lock"
symptoms:
  - "historical version-scoped MODULE.bazel.lock refresh Patches repeatedly conflict during Replant"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - tooling
tags:
  - upstream-sync
  - replant
  - bazel-lock
  - native-build
  - patch-stack
  - generated-artifact
---

# Automatically Drop Version-Scoped Bazel Lock Refreshes During Upstream Replants

## Context

The fork replants a linear Patch Stack from one parentless Upstream Snapshot onto the next with `git rebase --onto`. Historical commits such as `build(natives): refresh Bazel lock for v17.2.0` captured a generated `MODULE.bazel.lock` for one release. Replaying such a commit onto a later snapshot repeatedly conflicts with that snapshot's generated lock, even though native preparation regenerates the target-version lock after the Replant.

This is generated-artifact supersession, not a semantic fork conflict. The durable rule is to remove only narrowly identified, version-scoped lock-refresh commits from the interactive rebase todo and regenerate the target lock during native preparation.

The tempting alternatives are unsafe:

- Choosing “ours” keeps the target snapshot's lock but leaves a redundant historical Patch in the stack.
- Choosing “theirs” restores a stale lock generated for the old release.
- Hand-merging can create a plausible but non-reproducible mixture of two generated dependency graphs.
- Dropping every commit that touches `MODULE.bazel.lock` can discard deliberate configuration or dependency changes.

## Guidance

### Classify conservatively at the commit boundary

Treat a Patch as a Generated Lock Refresh only when all three predicates hold:

1. Its trimmed subject matches `build(natives): refresh Bazel lock for vX.Y.Z` exactly, case-insensitively, with numeric `X`, `Y`, and `Z`.
2. It changes exactly one path.
3. That path is exactly `MODULE.bazel.lock`.

The implementation encodes this boundary in `isGeneratedLockRefreshPatch`:

```ts
return (
	/^build\(natives\): refresh Bazel lock for v\d+\.\d+\.\d+$/i.test(patch.subject.trim()) &&
	changedFiles.length === 1 &&
	changedFiles[0] === "MODULE.bazel.lock"
);
```

`partitionReplantStack` checks the actual changed-file list for every Patch and produces two ordered groups: retained Patches and Generated Lock Refreshes. This distinguishes “retire an obsolete generated projection” from “discard arbitrary lock changes.”

### Drop through an explicit interactive rebase todo

`rewriteRebaseTodo` rewrites only todo entries selected by the classifier. It accepts both `pick` and abbreviated `p`, preserves the rest of the line, and compares SHAs in both prefix directions because Git can abbreviate todo SHAs.

Run the rebase with:

```text
--interactive --no-autosquash --empty=drop
```

`--no-autosquash` keeps the generated todo rewrite authoritative even when the stack contains `fixup!` or `squash!` commits. `--empty=drop` handles ordinary supersession when upstream already contains a Patch's effect.

If the rebase stops, calculate the conflicted and remaining Patches from the retained partition, not the original stack. A dropped refresh changes positional indexes; reporting against the unpartitioned stack can name the wrong conflict.

### Regenerate after replanting

After the rebase succeeds, `prepareWorktree` runs `bun install` and `bun run build:native`, removes the Bazel workspace convenience symlink, and requires a clean tracked worktree. The target snapshot and current source tree therefore produce the final lock; no old release's generated lock is replayed.

Keep dry runs honest: report the retained Patch count separately and print each omitted Patch as `drop ... (generated lock refresh)`. Operators should see both the exact classifier decision and the regeneration step before a real sync.

## Why This Matters

A generated lock is a release-specific projection, not durable fork intent. Once the base changes, its correct replacement is the new snapshot plus a fresh native preparation—not a three-way merge. Retiring the obsolete projection prevents a predictable conflict on every release while preserving all substantive fork Patches.

The classifier must remain narrow because false positives are more dangerous than false negatives. An unusual lock refresh left in the stack will stop for manual review; a meaningful commit incorrectly dropped may disappear without a conflict. This exception therefore does not generalize to `Cargo.lock`, all generated files, or semantic source conflicts.

The rest of the Replant safety model remains unchanged: work happens in the isolated sync worktree, semantic drift is re-implemented from Patch intent, verification completes before Promotion, and no generic conflict side is selected automatically.

## When to Apply

Apply this pattern only when the exact subject and sole-file predicates identify a Generated Lock Refresh during an upstream Replant.

Retain the Patch for normal review when:

- the subject differs or lacks a complete `vX.Y.Z`;
- any path besides `MODULE.bazel.lock` changed;
- the commit includes configuration or source changes; or
- its generated-only intent is uncertain.

If a Replant is already in progress, finish that rebase with `continue` or `skip` before rerunning the sync script; the script deliberately does not replace an active rebase.

## Examples

Given this rebase todo:

```text
pick <feature-sha> feat(ai): introduce policy rejections
p <lock-sha> build(natives): refresh Bazel lock for v17.2.0
pick <test-sha> test(coding-agent): narrow Cursor exec rejection results
```

when `<lock-sha>` changes exactly `MODULE.bazel.lock`, the sequence editor produces:

```text
pick <feature-sha> feat(ai): introduce policy rejections
drop <lock-sha> build(natives): refresh Bazel lock for v17.2.0
pick <test-sha> test(coding-agent): narrow Cursor exec rejection results
```

These adjacent cases remain retained:

```text
subject: build(natives): refresh Bazel lock for v17.2.0
files:   MODULE.bazel.lock, Cargo.lock

subject: build(natives): update Bazel configuration
files:   MODULE.bazel.lock
```

Regression coverage should exercise the classifier's positive and negative boundaries, both `pick` spellings, abbreviated SHAs, autosquash-enabled Git configuration, actual sequence-editor execution, retained-stack conflict indexing, and dry-run reporting. The implementation was verified with 29 focused sync tests, `bun run check:ts`, a real interactive rebase, and a v17.2.3 dry run that reported the v17.2.2 refresh in the dropped partition.

## Related

- [Upstream Sync for History-Truncated Forks via Patch-Stack Replant](./upstream-sync-history-truncated-fork.md) — parent workflow and safety model.
- [Fork sync to upstream: resolve .gitignore rebase conflicts and verify Bazel build](./fork-sync-upstream-gitignore-rebase-conflict.md) — adjacent mechanical-conflict playbook.
- [Fork maintenance runbook](../../fork-maintenance.md) — operational Replant, supersession, verification, and Promotion process.
- [`scripts/sync-upstream.ts`](../../../scripts/sync-upstream.ts) — classifier, stack partition, sequence editor, Replant, preparation, and dry-run implementation.
- [`scripts/sync-upstream.test.ts`](../../../scripts/sync-upstream.test.ts) — focused behavioral and real-Git regression coverage.
- [`CONCEPTS.md`](../../../CONCEPTS.md) — Patch Stack, Replant, Supersession, and Generated Lock Refresh vocabulary.
