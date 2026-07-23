---
title: Upstream Sync for History-Truncated Forks via Patch-Stack Replant
module: fork-maintenance
date: 2026-07-21
problem_type: workflow_issue
component: development_workflow
severity: high
symptoms:
  - "GitHub 'Sync fork' button fails with conflicts and offers only to discard local commits"
  - "fatal: refusing to merge unrelated histories"
  - "upstream main and release tag resolve to a single parentless commit (git show -s --format=%P is empty)"
applies_when:
  - "upstream truncated, squashed, or rewrote its history (parentless release snapshots)"
  - "git merge against upstream fails with unrelated histories"
  - "syncing a fork that carries local patches onto a new upstream release"
  - "the fork checkout is production (source-linked CLI, launchd services)"
resolution_type: workflow_improvement
related_components:
  - tooling
tags:
  - fork-maintenance
  - git-rebase
  - unrelated-histories
  - upstream-sync
  - patch-stack
  - worktree
  - supersession
  - launchd
---

# Upstream Sync for History-Truncated Forks via Patch-Stack Replant

## Context

When maintaining a downstream fork of an active project (e.g., local QoL patches that are intentionally never upstreamed), git workflows traditionally rely on periodic `git merge upstream/main`. That relies on a shared commit graph.

During the v17.0.7 release cycle of `can1357/oh-my-pi`, GitHub's "Sync fork" button failed, and local merges failed with:

```text
fatal: refusing to merge unrelated histories
```

Investigation revealed a structural change: upstream truncated its entire repository history. Upstream `main` and release tag `v17.0.7` are the same parentless orphan snapshot commit (`7b141199d` — upstream tag identity; `git show -s --format=%P` returns empty), sharing no lineage with the fork's `v17.0.6` base (`89d6a8f6d` — upstream v17.0.6 tag identity, historical: no longer reachable from the fork's replanted `main`, retained locally as tag `upstream/v17.0.6`). Merge-based synchronization is structurally impossible, for this and every future release published this way.

The fork sync process was migrated to a linear patch stack replanted onto upstream release snapshots via `git rebase --onto`.

## Guidance

### 1. Maintain a linear patch stack

Keep local modifications as clean, discrete commits directly on top of the latest release snapshot tag. Each patch must be self-contained:

- **Intent-bearing commit messages**: write messages detailed enough that if a patch fails to apply, the change can be re-implemented purely from the message's stated goal and contract.
- **Owned patch tests**: each patch introduces its own tests. They are the patch's *supersession contract* — if they pass against a bare upstream snapshot, upstream has absorbed the fix and the patch retires.
- **Never modify upstream `CHANGELOG.md`**: upstream release tooling rewrites `[Unreleased]` sections at every release, creating a guaranteed conflict per sync.
- **Prefer out-of-tree surfaces**: extensions, hooks, and config before patching upstream source files.

### 2. Fork tagging and ancestry conventions

Parentless snapshots break ancestry-based base detection, so explicit tags track state:

- `upstream/vX.Y.Z` — local mirror tag on the upstream release snapshot. The newest `upstream/v*` tag that is an ancestor of `main` defines the current base.
- `fork/pre-vX.Y.Z` — rollback point created immediately before each sync.

### 3. Replant workflow across unrelated histories

```bash
# Isolated worktree — main (production) never enters a rebase state
git worktree add -B sync/v17.0.7 ../oh-my-pi-sync main
cd ../oh-my-pi-sync

# Replant the patch stack from the old snapshot onto the new one
git rebase --empty=drop --onto upstream/v17.0.7 upstream/v17.0.6 sync/v17.0.7
```

#### Conflict rule: mechanical vs semantic drift

Per the runbook (`docs/fork-maintenance.md`):

- **Mechanical drift** (context moved, whitespace, neighboring churn): resolve markers in place, `git rebase --continue`.
- **Semantic drift** (upstream rewrote the patched logic): **never hand-merge.** `git rebase --skip` the patch and re-implement it from the commit-message intent as a fresh, reviewable diff.
- **Foreign lineage / duplicate commits**: `--empty=drop` silently drops commits whose content already exists in the snapshot; superseded commits that still conflict (e.g., an old version-bump) are skipped.

The dividing question: could a competent reviewer verify the resolution by looking at the conflict hunk alone? Yes → mechanical. No → semantic.

### 4. Automation and safety mechanisms

`scripts/sync-upstream.ts` (`status` | `<version>` [`--dry-run`]) executes every mechanical step and stops with per-patch state on conflicts; judgment lives in the runbook, not the script.

#### Worktree isolation and promotion

The checkout drives live services (`com.omp.auth-broker`, `com.omp.auth-gateway` under launchd exec the repo's `packages/coding-agent/scripts/omp` directly), so `main` must never sit mid-rebase or unverified. All verification runs in the worktree. Fast-forward promotion is impossible across unrelated histories — promotion moves `main` explicitly:

```bash
git reset --hard <verified-sync-head>
git push --force-with-lease origin main
```

#### Materializing test files for supersession checks

A patch's tests do not exist on the bare snapshot (the patch introduces them). Materialize them first, then run:

```bash
git checkout <patch-commit> -- <path/to/patch.test.ts>
bun test <path/to/patch.test.ts>   # pass on bare snapshot => patch superseded
```

#### Pre-promotion smoke test must use the worktree entry

```bash
bun <worktree>/packages/coding-agent/src/cli.ts --smoke-test
```

*Pitfall*: `omp --smoke-test` via `$PATH` resolves the source link into the **live checkout** regardless of cwd, silently testing pre-sync code.

#### Native addon rebuilds

A fresh worktree never has the built `.node` addon (it is untracked), so run `bun run build:native` in the worktree when the addon is missing — otherwise every natives-dependent test fails with a module-resolution error. (`scripts/sync-upstream.ts` gates the rebuild on the missing addon; a stale addon after upstream `crates/` changes is a maintainer-judgment rebuild.)

#### Service health gates

After `launchctl kickstart -k gui/<uid>/<label>`, distinguish transport readiness from account status:

- `omp auth-gateway check --strict` is **not** a health gate — it exits nonzero on credential quota issues (e.g., an account at its usage limit), unrelated to the sync.
- Valid gate: poll `GET http://127.0.0.1:4000/healthz` (boot takes several seconds — the script polls up to 30s), then assert `/v1/models` shape.
- Dedupe assertions on `/v1/models` must key on `(owned_by, id)` (`scripts/sync-upstream.ts:370`) — bare model ids legitimately collide across providers (observed live during this sync: anthropic and devin both serving `claude-opus-*`). The original doubling bug's signature was the same provider/id pair appearing twice.

## Why This Matters

Merging unrelated histories is impossible, and hand-copying files on each release loses commit provenance and the ability to tell "my delta" from "upstream drift". A patch stack replanted onto explicit release snapshots keeps the delta permanently inspectable (`git log <snapshot>..main` is exactly the fork's changes), makes supersession testable, bounds agent judgment during conflicts to re-implementation-from-intent with review, and keeps live services on verified code throughout.

## When to Apply

- Upstream squashed, rewrote, or truncated repository history (orphan release commits).
- `git merge` fails with `refusing to merge unrelated histories`.
- Maintaining persistent local patches against a third-party codebase.
- Recurring upstream release syncs in environments running live services off the checkout.

## Examples

### Executing a sync

```bash
bun scripts/sync-upstream.ts status            # current base, stack, pending releases
bun scripts/sync-upstream.ts v17.0.8 --dry-run # print resolved step plan
bun scripts/sync-upstream.ts v17.0.8           # full sync
```

### Sync log format (appended to docs/fork-maintenance.md by the script)

```markdown
### 2026-07-22 — v17.0.6 → v17.0.7

- kept 5a6ec1bb3 feat(ai): introduce policy rejections for exec handlers
- kept ae1db605e fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 50c843278 chore(dev): add local config example and gitignore entries
- kept 658659ce6 chore(fork): add upstream sync process (runbook + sync-upstream script)
```

## Related

- `docs/fork-maintenance.md` — the runbook: conflict decision rule, supersession protocol, rollback, patch-authoring rules, sync log.
- `scripts/sync-upstream.ts` — sync automation; `scripts/sync-upstream.test.ts` — its unit tests.
- `docs/plans/2026-07-21-001-chore-upstream-sync-process-plan.md` — the plan that produced this process.
