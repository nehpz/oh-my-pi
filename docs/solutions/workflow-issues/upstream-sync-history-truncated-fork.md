---
title: Upstream Sync for History-Truncated Forks via Patch-Stack Replant
module: fork-maintenance
date: 2026-07-21
last_refreshed: 2026-10-06
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

Investigation revealed a structural change: upstream truncated its entire repository history. Upstream `main` and release tag `v17.0.7` are the same parentless orphan snapshot commit (`7b141199d` — upstream tag identity; `git show -s --format=%P` returns empty), sharing no lineage with the fork's `v17.0.6` base (`89d6a8f6d` — upstream v17.0.6 tag identity, mirrored locally as tag `upstream/v17.0.6`). Merge-based synchronization is structurally impossible, for this and every future release published this way.

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
- **fork/pre-vX.Y.Z** — rollback tag created immediately before each sync.

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

**Worked example (v17.1.6)**: upstream added a Bazel ignore block in `.gitignore` while a fork patch added local dev ignores (`.compound-engineering/*.local.yaml`, `.stakpak/session*`). Both are orthogonal additions — keep upstream's tool block and the fork's paths. See [Fork sync: `.gitignore` rebase conflict](./fork-sync-upstream-gitignore-rebase-conflict.md).

### 4. Automation and safety mechanisms

`scripts/sync-upstream.ts` (`status` | `deploy [<git-ref>] [--dry-run]` | `<version>` [`--dry-run`] [`--verify-only`] [`--accept-manual-review`] [`--native-mode=auto|npm|bazel`]) executes every mechanical step and stops with per-patch state on conflicts; judgment lives in the runbook, not the script.

#### Worktree isolation and promotion

The checkout drives live services: `com.omp.auth-broker` and `com.omp.auth-gateway` run under launchd and exec `packages/coding-agent/scripts/omp`, either from this checkout or, when `git config omp-sync.serviceHost` is set, from a checkout on a separate service host that each promotion deploys to (see the runbook's "Service host (Mac mini)" section). Either way `main` must never sit mid-rebase or unverified. All verification runs in the worktree. Fast-forward promotion is impossible across unrelated histories — promotion moves `main` explicitly:

```bash
git reset --hard <verified-sync-head>
git push --force-with-lease origin main
```

`promote()` stages its verified `.node` addon under a temporary name outside the sync worktree before deleting the worktree, then atomically renames it into the live checkout after the tracked-tree reset. This prevents the ignored pre-sync addon from surviving the tracked-tree reset and prevents readers from observing a partially copied binary.

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

#### Native addon preparation

`prepareWorktree()` in `scripts/sync-upstream.ts` runs `bun install --frozen-lockfile`, then produces the exact-version addon for the target release and swaps it into the worktree before verification. Worktrees are reused when a sync resumes and their ignored `.node` files persist, so a same-version stale addon must never be allowed to pass verification and be promoted into the live checkout.

The producer is the Native Preparation Mode. The default `auto` mode picks `npm`, which acquires the official `@oh-my-pi/pi-natives-<platform>` leaf for that version, unless a retained Patch touches the native build or packaging contract. In that case it picks `bazel`, which runs `scripts/bazel-natives.ts host`; that host build defaults to the local Cargo/N-API path (Bazel only with `OMP_NATIVE_BUILD_BACKEND=bazel` or extra bazel args), and first builds can take many minutes. `--native-mode=npm|bazel` overrides the choice; npm is refused when the classification requires Bazel.

#### Retiring generated Bazel lock refreshes

Historical Patches whose subject exactly matches `build(natives): refresh Bazel lock for vX.Y.Z` and whose sole changed file is `MODULE.bazel.lock` are release-scoped generated state. Before Replant, the sync script classifies those Patches from their actual changed-file lists and rewrites only their interactive rebase todo entries from `pick`/`p` to `drop`. The rebase runs with `--no-autosquash` so Git configuration cannot reorder the selected entries; dry-run output reports each drop explicitly.

Do not generalize this exception to every lockfile change. A different subject or any additional changed path remains in the Patch Stack for normal conflict handling. After Replant, `prepareWorktree()` produces the target's addon (npm leaf or Bazel build per the Native Preparation Mode) and requires a clean tracked worktree. See [Automatically Drop Version-Scoped Bazel Lock Refreshes During Upstream Replants](./generated-bazel-lock-refresh-replant.md) for the classifier boundary, sequence-editor behavior, and regression cases.

#### Service health gates

After each `launchctl kickstart -k gui/<uid>/<label>` (run locally, or over SSH on a remote service host), distinguish transport readiness from account status:

- `omp auth-gateway check --strict` is **not** a health gate — it exits nonzero on credential quota issues (e.g., an account at its usage limit), unrelated to the sync.
- Valid gate: poll broker `/v1/healthz`, then gateway `/healthz`, each until it reports the target version (60-second deadline per service), then assert `/v1/models` shape. The broker is checked at `http://127.0.0.1:8765` (through the SSH tunnel when the services are remote); the gateway at `http://127.0.0.1:4000` locally or `http://<service-host>:4000` remotely.
- Dedupe assertions on `/v1/models` must key on `(owned_by, id)` (`verifyGatewayModels()` in `scripts/sync-upstream.ts`) — bare model ids legitimately collide across providers (observed live during this sync: anthropic and devin both serving `claude-opus-*`). The original doubling bug's signature was the same provider/id pair appearing twice.

#### Integration test stdout capture

The `status subcommand` case in `scripts/sync-upstream.test.ts` runs the script inside a temp git repo. Reading stdout via Bun Shell `` $`...`.text() `` returned **empty** under `bun test` in that layout. Prefer **`Bun.spawn` with stdout redirected to a file**, then `Bun.file(outFile).text()` — reliable across worktree and temp-repo harnesses. See the incident doc for the before/after pattern.

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

- kept <policy-patch> feat(ai): introduce policy rejections for exec handlers
- kept <models-patch> fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept <config-patch> chore(dev): add local config example and gitignore entries
- kept <sync-patch> chore(fork): add upstream sync process (runbook + sync-upstream script)
```

## Related

- `docs/fork-maintenance.md` — the runbook: conflict decision rule, supersession protocol, rollback, service host deploy, patch-authoring rules, sync log.
- [omp hosts consume a remote auth service as broker clients](../decisions/omp-hosts-consume-remote-auth-as-broker-clients.md) — why the broker stays loopback-only on a remote service host and the laptop reaches it through a tunnel.
- [Fork sync: `.gitignore` rebase conflict and Bazel verify gate](./fork-sync-upstream-gitignore-rebase-conflict.md) — v17.1.6 incident playbook (mechanical `.gitignore`, `bazelisk`, status test capture).
- `scripts/sync-upstream.ts` — sync automation; `scripts/sync-upstream.test.ts` — its unit tests; `scripts/bazel-natives.ts` — Bazel driver for native builds.
- `docs/plans/2026-07-21-001-chore-upstream-sync-process-plan.md` — the plan that produced this process.
