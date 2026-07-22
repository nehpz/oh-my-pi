# Fork Maintenance

This repo is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) carrying a small set of local patches that are deliberately not upstreamed. This document is the operating manual for keeping the fork in sync with upstream releases. The mechanical steps are automated by `scripts/sync-upstream.ts`; the judgment rules an agent or maintainer applies when the script stops live here.

## Fork topology

- **Upstream publishes parentless release snapshots.** As of v17.0.7, upstream's `main` and its release tags are single orphan commits with no shared ancestry between releases. Merging is structurally impossible (`refusing to merge unrelated histories`); the fork syncs by *replanting* its patch stack onto each new snapshot with `git rebase --onto`. The process works identically if upstream ever returns to linear history.
- **The fork delta is a linear patch stack.** `git log <current-base>..main` is the exact fork delta at all times: no merge commits, each patch self-contained.
- **Tag conventions:**
  - `upstream/vX.Y.Z` — local mirror of upstream's release tag. The newest one that is an ancestor of `main` is the fork's **current base**. Because snapshots are parentless, this tag is the only durable base marker — never delete these.
  - `fork/pre-vX.Y.Z` — the fork's state immediately before the sync to `vX.Y.Z`. Rollback target.
- **The checkout is production.** The `omp` CLI on PATH is source-linked to this repo, and the launchd services `com.omp.auth-broker` / `com.omp.auth-gateway` exec `packages/coding-agent/scripts/omp` directly. `main` must never sit in a broken or mid-rebase state — all sync work happens in a separate worktree until verified.

## Sync procedure

Triggered per upstream release tag:

```bash
bun scripts/sync-upstream.ts status        # what base am I on, what's pending upstream
bun scripts/sync-upstream.ts v17.0.8 --dry-run   # print the resolved step plan
bun scripts/sync-upstream.ts v17.0.8       # run the sync
```

The script executes: preflight (clean tree, resolve base, fetch snapshot) → `fork/pre-*` tag → replant in the sync worktree → supersession check → verification → promotion of `main` → service restart + health check → sync log. It stops with actionable state whenever a step needs judgment; resume by fixing the named problem and re-running the script, which detects the in-progress worktree.

## Conflict decision rule

When the replant stops on a conflicted patch, classify the conflict:

**Mechanical drift — resolve in place, no review needed.** The patched logic still exists in recognizably the same shape; only its surroundings moved. Examples: neighboring lines changed, code moved within or between files, whitespace/formatting churn, an import list reordered. Resolve the markers so the patch's original change lands in the moved/reflowed code, `git rebase --continue`, re-run the script.

**Semantic drift — never hand-merge; re-implement from intent.** Upstream rewrote the logic the patch modifies: the function was restructured, the behavior implemented differently, the surface the patch hooks into is gone. Do not pick sides in conflict markers. Instead:

1. `git rebase --skip` the conflicted patch (its content will be re-derived).
2. Read the patch's commit message — every patch states its intent in enough detail to re-implement from the message alone.
3. Re-implement the intent against the new upstream code as a fresh commit on the sync branch, with the patch's original test files passing.
4. Present the re-implementation as an isolated diff for maintainer approval **before** promotion. This is the one step that must not proceed autonomously.

The dividing question: *could a competent reviewer verify the resolution by looking at the conflict hunk alone?* Yes → mechanical. No (you need to understand what upstream now does) → semantic.

## Supersession protocol

Fork patches are stopgaps with expiry conditions, not identity. Each sync, the script checks every patch for retirement: it materializes the patch's test files onto the bare upstream snapshot (the tests ship inside the patch, so they don't exist upstream) and runs them.

- **Tests pass without the patch** → upstream now satisfies the patch's intent. Retire it: drop the commit from the stack, record the retirement and the superseding upstream change in the sync log.
- **Tests fail** → the patch survives, replanted as usual.
- **Patch has no test files** → the check cannot run; the script flags it for manual review. (This is a patch-authoring defect — see the rules below.)

Prefer upstream, drop mine: when in doubt whether upstream's version fully covers the case, the patch's tests are the arbiter, not taste.

## Rollback

If the post-promotion health check fails (pre-promotion failures abort before `main` ever moves):

```bash
git reset --hard fork/pre-vX.Y.Z
bun install
launchctl kickstart -k gui/$UID/com.omp.auth-broker
launchctl kickstart -k gui/$UID/com.omp.auth-gateway
curl -fsS http://127.0.0.1:4000/healthz
```

This restores the CLI and inference services to the last known-good state in under a minute. Investigate in the sync worktree afterwards, without time pressure.

## Patch-authoring rules

For any future local change:

1. **Out-of-tree first.** Try extensions, hooks, custom tools, or config before patching upstream source. Only behavior-modifying changes with no extension point join the patch stack.
2. **Intent-bearing commit message.** State what behavior the patch changes and why, in enough detail that the change could be re-implemented from the message alone. The message is the patch's survival kit when upstream rewrites the code under it.
3. **Owned tests.** Every patch carries test files that fail without it and pass with it. They are the patch's expiry condition (supersession) and its re-implementation acceptance bar.
4. **No upstream `CHANGELOG.md` edits.** Upstream's release process rewrites `[Unreleased]` sections, guaranteeing a conflict per release. Intent lives in the commit message.
5. **Linear stack only.** No merge commits in the fork delta; rebase local work onto `main` before landing it.

## Sync log

<!-- Appended by scripts/sync-upstream.ts; newest first. -->

### 2026-07-22 — v17.0.6 → v17.0.7

- kept 5a6ec1bb3 feat(ai): introduce policy rejections for exec handlers
- kept ae1db605e fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 50c843278 chore(dev): add local config example and gitignore entries
- kept 658659ce6 chore(fork): add upstream sync process (runbook + sync-upstream script)
