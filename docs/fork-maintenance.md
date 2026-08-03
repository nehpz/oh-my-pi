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
bun scripts/sync-upstream.ts v17.0.8 --verify-only # run sync through verification, then stop
bun scripts/sync-upstream.ts v17.0.8       # auto-select npm or Bazel and run the sync
bun scripts/sync-upstream.ts v17.0.8 --native-mode=npm   # explicit diagnostic override
bun scripts/sync-upstream.ts v17.0.8 --native-mode=bazel # force the maintained local builder
```

The default `auto` mode selects the exact official npm native leaf for ordinary
syncs. It selects Bazel when the retained patch stack changes native source,
dependencies, bindings, build rules, or leaf packaging; the macOS 27
`rust-toolchain.toml`/`MODULE.bazel` toolchain-only overlay remains npm-eligible.
An explicit npm override is refused when classification requires Bazel; there is
no implicit fallback between producers.

Both producers first create an addon source outside the worktree. The worktree's
real loader validates that exact source through its native-directory override;
only then does a directory-level transaction replace and revalidate the
worktree addon set.
Acquisition, build, metadata, loader, or swap failure leaves the prior
destination usable and prints an exact same-mode retry command.

Progress is identity-bound to version, exact sync HEAD, selected mode, host
platform, addon filenames, and successful loader verification. Legacy or
mismatched progress is invalid and reruns preparation. Npm acquisition uses the
official registry, exact versions, no cache, frozen manifest, and disabled
lifecycle scripts; failures stop before promotion and preserve retry state.

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

Fork patches are stopgaps with expiry conditions, not identity. Each sync run reuses a single bare upstream probe worktree/install (resetting and cleaning git state between patches) to check patches for retirement: it materializes the patch's test files onto the bare upstream snapshot (the tests ship inside the patch, so they don't exist upstream) and runs them. Each verdict is persisted to `.sync-upstream-progress.json` immediately.

- **Tests pass without the patch** → upstream now satisfies the patch's intent. Retire it: drop the commit from the stack, record the retirement and the superseding upstream change in the sync log.
- **Tests fail** → the patch survives, replanted as usual.
- **Recognized fork-record-only commits** → retained silently without behavioral supersession review. Conservative record classification automatically keeps commits with recognized fork-record subjects (e.g. `chore(fork): ...`, `docs(fork): ...`) whose entire changed-file set consists exclusively of record-only files (such as `docs/fork-maintenance.md` or `docs/solutions/*`).
- **Executable/config changes without owned tests** → flagged for manual review. Patches touching source code, executable logic, configuration files, or lockfiles without owned test files cannot be automatically evaluated for behavioral supersession and require maintainer judgment.

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

### 2026-08-03 — post-v17.2.5 restack (npm-only native syncs)

- dropped `build(natives): keep local Bazel builds working on macOS 27` (macOS 27 Bazel toolchain overlay: MODULE.bazel, crates/pi-natives/BUILD.bazel, crates/pi-shell/src/process.rs let-chain refactor) — build-time only, unnecessary under npm-mode syncs
- dropped `build(natives): refresh Bazel lock for v17.2.5` — generated lock only existed to match the retired overlay
- reverted the fork's `export` flip in `packages/natives/scripts/gen-npm-packages.ts`; `expectedAddonFilenames` is now inlined in `scripts/sync-upstream.ts`
- `.gitignore` is now a fork-record file, so `chore(dev)` config commits retain silently during supersession review
- removed dead classifier hatches (`isToolchainOverlay`, `isExpectedFilenameExportOnly`); native impact classification stays fail-closed
- root cause of the clippy pressure behind the retired process.rs refactor: a stale `rustup override` (bare `nightly`, 2026-02-26 build) on the main checkout shadowed `rust-toolchain.toml`'s `nightly-2026-07-28` pin; the override was removed and the pinned toolchain passes `check:rs` on unmodified upstream code
- net effect: no retained patch touches native contract paths; auto native mode resolves npm; rollback tag `fork/pre-restack-v17.2.5`

### 2026-08-03 — v17.2.4 → v17.2.5

- kept 8c8a68b41 feat(ai): enforce Cursor execution policy rejections
- kept 21c3e6fb2 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 4b4d53920 chore(dev): preserve fork-local development configuration
- kept a739d2eb8 fix(natives): diagnose and safely promote workspace addons
- kept 58b9f4d73 build(natives): keep local Bazel builds working on macOS 27
- kept 7ad02557a chore(fork): automate parentless syncs with verified npm natives
- kept 4474715e2 build(natives): refresh Bazel lock for v17.2.5
- note: 4b4d53920 chore(dev): preserve fork-local development configuration (no owned tests — manual review)
- note: 58b9f4d73 build(natives): keep local Bazel builds working on macOS 27 (no owned tests — manual review)
- note: 4474715e2 build(natives): refresh Bazel lock for v17.2.5 (no owned tests — manual review)

### 2026-08-02 — v17.2.2 → v17.2.4

- kept 346ee517e feat(ai): introduce policy rejections for exec handlers
- kept 4b2ca1be1 fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 7fe8d5bb7 chore(dev): add local config example and gitignore entries
- kept 4eb04f556 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept e72f7866e chore(fork): sync log for v17.0.7
- kept e8b4e97dc chore(fork): formalize upstream sync process knowledge and concepts
- kept 0d1059793 chore(fork): sync log for v17.1.0
- kept 9e8fb9fdb chore(fork): sync log for v17.1.1
- kept 48f0703af chore(fork): sync log for v17.1.3
- kept 3c389ef76 fix(fork): accept nullable model context metadata
- kept ec3768351 chore(fork): sync log for v17.1.4
- kept 6a7747dfc docs(fork): record v17.1.4 supersession review
- kept fb31d3033 chore(fork): sync log for v17.1.5
- kept de221d9f6 fix(fork): capture sync-upstream status test output via file in worktrees
- kept 162441e67 chore(fork): sync log for v17.1.6
- kept 3a3ef3910 docs(fork): add v17.1.6 sync resolution playbook
- kept 6dc59577b fix(natives): provide actionable rebuild guidance for stale workspace addons
- kept 5f00f28b1 fix(fork): rebuild and promote native addons to prevent stale binaries
- kept 009971e3c docs(natives): document native addon loading and resolution diagnostics
- kept 34514203f chore(fork): sync log for v17.1.7
- kept 90c74e6ef fix(fork): make upstream sync resumable
- kept 47fcf2a35 chore(fork): sync log for v17.1.8
- kept 5b17c5d28 test(coding-agent): narrow Cursor exec rejection results
- kept 45c8a02c7 chore(fork): sync log for v17.2.0
- kept ae77039f0 fix(coding-agent): reject Cursor delete policy denials
- kept 646b8651e docs: define Contract Drift and document Cursor delete policy error
- kept 5e7510308 chore(fork): sync log for v17.2.1
- kept 48156e5c3 fix(fork): harden sync worktree promotion
- kept ece31e6dc docs(sync-upstream): document isolation of Git fixture identities
- kept e3920be02 chore(mcp): configure JetBrains MCP server and disable idea
- kept 46880b3dd fix(fork): retire generated lock patches during replant
- kept d94d9032c chore(fork): sync log for v17.2.2
- kept d4a4cd306 refactor(fork): harden generated lock refresh classification and replant
- kept 28b93536c build(natives): update Rust nightly for macOS 27 dylibs
- note: 7fe8d5bb7 chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: 3c389ef76 fix(fork): accept nullable model context metadata (no owned tests — manual review)
- note: 646b8651e docs: define Contract Drift and document Cursor delete policy error (no owned tests — manual review)
- note: ece31e6dc docs(sync-upstream): document isolation of Git fixture identities (no owned tests — manual review)
- note: e3920be02 chore(mcp): configure JetBrains MCP server and disable idea (no owned tests — manual review)
- note: 28b93536c build(natives): update Rust nightly for macOS 27 dylibs (no owned tests — manual review)

### 2026-07-31 — v17.2.1 → v17.2.2

- kept 21a0d6cc1 feat(ai): introduce policy rejections for exec handlers
- kept 49e9fa1f5 fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept a2bcccb7f chore(dev): add local config example and gitignore entries
- kept 41cbaf10d chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept c2c63774a chore(fork): sync log for v17.0.7
- kept cca0c15b5 chore(fork): formalize upstream sync process knowledge and concepts
- kept ad1c07eb6 chore(fork): sync log for v17.1.0
- kept 55efac272 chore(fork): sync log for v17.1.1
- kept 391856660 chore(fork): sync log for v17.1.3
- kept 7106a67c2 fix(fork): accept nullable model context metadata
- kept c8834bc1c chore(fork): sync log for v17.1.4
- kept b31b8b217 docs(fork): record v17.1.4 supersession review
- kept 92f98f409 chore(fork): sync log for v17.1.5
- kept 9bd432ab2 fix(fork): capture sync-upstream status test output via file in worktrees
- kept db33835de chore(fork): sync log for v17.1.6
- kept 2ff07265a docs(fork): add v17.1.6 sync resolution playbook
- kept b089cf1b8 fix(natives): provide actionable rebuild guidance for stale workspace addons
- kept 007432b66 fix(fork): rebuild and promote native addons to prevent stale binaries
- kept 135718af6 docs(natives): document native addon loading and resolution diagnostics
- kept 2ef8647d1 chore(fork): sync log for v17.1.7
- kept 32facc796 fix(fork): make upstream sync resumable
- kept 3842b545d chore(fork): sync log for v17.1.8
- kept b30a3eb2c test(coding-agent): narrow Cursor exec rejection results
- kept 51713917f chore(fork): sync log for v17.2.0
- kept 7942129f7 fix(coding-agent): reject Cursor delete policy denials
- kept c08f5fe31 docs: define Contract Drift and document Cursor delete policy error
- kept 2e32dbb86 chore(fork): sync log for v17.2.1
- kept 4eb453c41 fix(fork): harden sync worktree promotion
- kept c7b6271a6 docs(sync-upstream): document isolation of Git fixture identities
- kept 27af888bf chore(mcp): configure JetBrains MCP server and disable idea
- kept d863bbb55 fix(fork): retire generated lock patches during replant
- kept 1c8279514 build(natives): refresh Bazel lock for v17.2.2

### 2026-07-31 — v17.2.0 → v17.2.1

- kept a30a1bebc feat(ai): introduce policy rejections for exec handlers
- kept adfbbf5a4 fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 6cf81a0b3 chore(dev): add local config example and gitignore entries
- kept 54342bda2 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept b972f0c88 chore(fork): sync log for v17.0.7
- kept cc0fcd8d9 chore(fork): formalize upstream sync process knowledge and concepts
- kept 31eae8090 chore(fork): sync log for v17.1.0
- kept c6d00b87f chore(fork): sync log for v17.1.1
- kept f9ac159df chore(fork): sync log for v17.1.3
- kept 213a7582e fix(fork): accept nullable model context metadata
- kept c1751af38 chore(fork): sync log for v17.1.4
- kept 5b7447161 docs(fork): record v17.1.4 supersession review
- kept e72eb1912 chore(fork): sync log for v17.1.5
- kept 9997711cb fix(fork): capture sync-upstream status test output via file in worktrees
- kept 64a4b2256 chore(fork): sync log for v17.1.6
- kept ce723a4d9 docs(fork): add v17.1.6 sync resolution playbook
- kept 117c40a0d fix(natives): provide actionable rebuild guidance for stale workspace addons
- kept 5989b0514 fix(fork): rebuild and promote native addons to prevent stale binaries
- kept 59d844c5a docs(natives): document native addon loading and resolution diagnostics
- kept 53e417b16 chore(fork): sync log for v17.1.7
- kept ad62995e7 fix(fork): make upstream sync resumable
- kept c5d019534 chore(fork): sync log for v17.1.8
- kept b69a2dc61 build(natives): refresh Bazel lock for v17.2.0
- kept dd8401c66 test(coding-agent): narrow Cursor exec rejection results
- kept 9bd29ed56 chore(fork): sync log for v17.2.0
- kept a16dc2de6 fix(coding-agent): reject Cursor delete policy denials
- kept 95f7a2408 docs: define Contract Drift and document Cursor delete policy error
- kept b05e0e1a8 build(natives): refresh Bazel lock for v17.2.1
- note: 6cf81a0b3 chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: 213a7582e fix(fork): accept nullable model context metadata (no owned tests — manual review)
- note: b69a2dc61 build(natives): refresh Bazel lock for v17.2.0 (no owned tests — manual review)
- note: 95f7a2408 docs: define Contract Drift and document Cursor delete policy error (no owned tests — manual review)
- note: b05e0e1a8 build(natives): refresh Bazel lock for v17.2.1 (no owned tests — manual review)

### 2026-07-30 — v17.1.8 → v17.2.0

- kept 54a8b4e60 feat(ai): introduce policy rejections for exec handlers
- kept 73ecacbc4 fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept b9b772f8a chore(dev): add local config example and gitignore entries
- kept 4a94d0e2e chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept 6570d2260 chore(fork): sync log for v17.0.7
- kept ff270bc97 chore(fork): formalize upstream sync process knowledge and concepts
- kept 793970f6c chore(fork): sync log for v17.1.0
- kept d6db130af chore(fork): sync log for v17.1.1
- kept bba10bb49 chore(fork): sync log for v17.1.3
- kept e3694187b fix(fork): accept nullable model context metadata
- kept 40996aeae chore(fork): sync log for v17.1.4
- kept 8fa85eee2 docs(fork): record v17.1.4 supersession review
- kept a4ea99e49 chore(fork): sync log for v17.1.5
- kept c7b784171 fix(fork): capture sync-upstream status test output via file in worktrees
- kept f762df0ea chore(fork): sync log for v17.1.6
- kept 832a242a0 docs(fork): add v17.1.6 sync resolution playbook
- kept 444e01182 fix(natives): provide actionable rebuild guidance for stale workspace addons
- kept 1b2f26e05 fix(fork): rebuild and promote native addons to prevent stale binaries
- kept bcaaf027a docs(natives): document native addon loading and resolution diagnostics
- kept 7c83a88ec chore(fork): sync log for v17.1.7
- kept 5993a1f28 fix(fork): make upstream sync resumable
- kept db154ab86 chore(fork): sync log for v17.1.8
- kept c083a9cc7 build(natives): refresh Bazel lock for v17.2.0
- kept 3c14255ed test(coding-agent): narrow Cursor exec rejection results
- note: b9b772f8a chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: e3694187b fix(fork): accept nullable model context metadata (no owned tests — manual review)
- note: c083a9cc7 build(natives): refresh Bazel lock for v17.2.0 (no owned tests — manual review)

### 2026-07-28 — v17.1.7 → v17.1.8

- kept c2253e94e feat(ai): introduce policy rejections for exec handlers
- kept 377a2a702 fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 3504299f7 chore(dev): add local config example and gitignore entries
- kept f7e4be419 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept 0f00ed02a chore(fork): sync log for v17.0.7
- kept 2c5062b15 chore(fork): formalize upstream sync process knowledge and concepts
- kept fd241eb9f chore(fork): sync log for v17.1.0
- kept 79327ea02 chore(fork): sync log for v17.1.1
- kept b2ed8da23 chore(fork): sync log for v17.1.3
- kept 5bd6d08d6 fix(fork): accept nullable model context metadata
- kept 566a29aa2 chore(fork): sync log for v17.1.4
- kept 35aa2eb5e docs(fork): record v17.1.4 supersession review
- kept 15cc996a3 chore(fork): sync log for v17.1.5
- kept b1c144548 fix(fork): capture sync-upstream status test output via file in worktrees
- kept 900dad997 chore(fork): sync log for v17.1.6
- kept 45348d195 docs(fork): add v17.1.6 sync resolution playbook
- kept 2f6a3de0d fix(natives): provide actionable rebuild guidance for stale workspace addons
- kept 26c9790e3 fix(fork): rebuild and promote native addons to prevent stale binaries
- kept a7dd192b4 docs(natives): document native addon loading and resolution diagnostics
- kept 20b1b3bda chore(fork): sync log for v17.1.7
- kept ca1f1cd88 build(natives): refresh Bazel lock for v17.1.8
- kept 6ae279674 fix(fork): make upstream sync resumable
- note: 3504299f7 chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: 5bd6d08d6 fix(fork): accept nullable model context metadata (no owned tests — manual review)
- note: ca1f1cd88 build(natives): refresh Bazel lock for v17.1.8 (no owned tests — manual review)

### 2026-07-28 — v17.1.6 → v17.1.7

- kept 0af92c88d feat(ai): introduce policy rejections for exec handlers
- kept 9cae3902d fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 10c05f822 chore(dev): add local config example and gitignore entries
- kept 54991a355 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept 997fdd531 chore(fork): sync log for v17.0.7
- kept 560cff5de chore(fork): formalize upstream sync process knowledge and concepts
- kept e1b28e906 chore(fork): sync log for v17.1.0
- kept 80d5d6ef0 chore(fork): sync log for v17.1.1
- kept d6e3b6897 chore(fork): sync log for v17.1.3
- kept a709c0d83 fix(fork): accept nullable model context metadata
- kept 6314be72a chore(fork): sync log for v17.1.4
- kept 7b0031e37 docs(fork): record v17.1.4 supersession review
- kept e33dcfcf5 chore(fork): sync log for v17.1.5
- kept 521c5085f fix(fork): capture sync-upstream status test output via file in worktrees
- kept decb87caa chore(fork): sync log for v17.1.6
- kept 67e366b76 docs(fork): add v17.1.6 sync resolution playbook
- kept a6969db7f fix(natives): provide actionable rebuild guidance for stale workspace addons
- kept 6d6be45d0 fix(fork): rebuild and promote native addons to prevent stale binaries
- kept 4b5373c69 docs(natives): document native addon loading and resolution diagnostics
- note: 10c05f822 chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: 997fdd531 chore(fork): sync log for v17.0.7 (no owned tests — manual review)
- note: 560cff5de chore(fork): formalize upstream sync process knowledge and concepts (no owned tests — manual review)
- note: e1b28e906 chore(fork): sync log for v17.1.0 (no owned tests — manual review)
- note: 80d5d6ef0 chore(fork): sync log for v17.1.1 (no owned tests — manual review)
- note: d6e3b6897 chore(fork): sync log for v17.1.3 (no owned tests — manual review)
- note: a709c0d83 fix(fork): accept nullable model context metadata (no owned tests — manual review)
- note: 6314be72a chore(fork): sync log for v17.1.4 (no owned tests — manual review)
- note: 7b0031e37 docs(fork): record v17.1.4 supersession review (no owned tests — manual review)
- note: e33dcfcf5 chore(fork): sync log for v17.1.5 (no owned tests — manual review)
- note: decb87caa chore(fork): sync log for v17.1.6 (no owned tests — manual review)
- note: 67e366b76 docs(fork): add v17.1.6 sync resolution playbook (no owned tests — manual review)
- note: 4b5373c69 docs(natives): document native addon loading and resolution diagnostics (no owned tests — manual review)

### 2026-07-27 — v17.1.5 → v17.1.6

- kept 0161f719a feat(ai): introduce policy rejections for exec handlers
- kept 08c164616 fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept cb235771c chore(dev): add local config example and gitignore entries
- kept a1c236143 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept 0bd5b2c52 chore(fork): sync log for v17.0.7
- kept 19e3327d0 chore(fork): formalize upstream sync process knowledge and concepts
- kept 4c3af610c chore(fork): sync log for v17.1.0
- kept cda3a78f4 chore(fork): sync log for v17.1.1
- kept 4ea28295c chore(fork): sync log for v17.1.3
- kept 2f1c28a4a fix(fork): accept nullable model context metadata
- kept d60020f2d chore(fork): sync log for v17.1.4
- kept 52a38f61b docs(fork): record v17.1.4 supersession review
- kept 9375c9039 chore(fork): sync log for v17.1.5
- kept 96ae53d7f fix(fork): capture sync-upstream status test output via file in worktrees
- note: cb235771c chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: 0bd5b2c52 chore(fork): sync log for v17.0.7 (no owned tests — manual review)
- note: 19e3327d0 chore(fork): formalize upstream sync process knowledge and concepts (no owned tests — manual review)
- note: 4c3af610c chore(fork): sync log for v17.1.0 (no owned tests — manual review)
- note: cda3a78f4 chore(fork): sync log for v17.1.1 (no owned tests — manual review)
- note: 4ea28295c chore(fork): sync log for v17.1.3 (no owned tests — manual review)
- note: 2f1c28a4a fix(fork): accept nullable model context metadata (no owned tests — manual review)
- note: d60020f2d chore(fork): sync log for v17.1.4 (no owned tests — manual review)
- note: 52a38f61b docs(fork): record v17.1.4 supersession review (no owned tests — manual review)
- note: 9375c9039 chore(fork): sync log for v17.1.5 (no owned tests — manual review)

### 2026-07-27 — v17.1.4 → v17.1.5

- kept fed12a66a feat(ai): introduce policy rejections for exec handlers
- kept 3281294e9 fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 4b1ffed7f chore(dev): add local config example and gitignore entries
- kept b5b8ce248 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept 9c2d64031 chore(fork): sync log for v17.0.7
- kept 6e41aea67 chore(fork): formalize upstream sync process knowledge and concepts
- kept dde2a53f2 chore(fork): sync log for v17.1.0
- kept c7391ef61 chore(fork): sync log for v17.1.1
- kept d224f5066 chore(fork): sync log for v17.1.3
- kept d2d612cc7 fix(fork): accept nullable model context metadata
- kept a5a3279a4 chore(fork): sync log for v17.1.4
- kept 32f925398 docs(fork): record v17.1.4 supersession review
- note: 4b1ffed7f chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: 9c2d64031 chore(fork): sync log for v17.0.7 (no owned tests — manual review)
- note: 6e41aea67 chore(fork): formalize upstream sync process knowledge and concepts (no owned tests — manual review)
- note: dde2a53f2 chore(fork): sync log for v17.1.0 (no owned tests — manual review)
- note: c7391ef61 chore(fork): sync log for v17.1.1 (no owned tests — manual review)
- note: d224f5066 chore(fork): sync log for v17.1.3 (no owned tests — manual review)
- note: d2d612cc7 fix(fork): accept nullable model context metadata (no owned tests — manual review)
- note: a5a3279a4 chore(fork): sync log for v17.1.4 (no owned tests — manual review)
- note: 32f925398 docs(fork): record v17.1.4 supersession review (no owned tests — manual review)

### 2026-07-27 — v17.1.3 → v17.1.4

- kept c7c12268f feat(ai): introduce policy rejections for exec handlers
- kept 42261e5a7 fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept ed7d23654 chore(dev): add local config example and gitignore entries
- kept 4f6a79f15 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept 412f59f11 chore(fork): sync log for v17.0.7
- kept d100d0df0 chore(fork): formalize upstream sync process knowledge and concepts
- kept 11deeee47 chore(fork): sync log for v17.1.0
- kept 013e43c8a chore(fork): sync log for v17.1.1
- kept 6eb7fe33c chore(fork): sync log for v17.1.3
- kept ea9d25813 fix(fork): accept nullable model context metadata
- note: ed7d23654 chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: 412f59f11 chore(fork): sync log for v17.0.7 (no owned tests — manual review)
- note: d100d0df0 chore(fork): formalize upstream sync process knowledge and concepts (no owned tests — manual review)
- note: 11deeee47 chore(fork): sync log for v17.1.0 (no owned tests — manual review)
- note: 013e43c8a chore(fork): sync log for v17.1.1 (no owned tests — manual review)
- note: 6eb7fe33c chore(fork): sync log for v17.1.3 (no owned tests — manual review)

### 2026-07-25 — v17.1.1 → v17.1.3

- kept 5a794cda5 feat(ai): introduce policy rejections for exec handlers
- kept 1cfe8cbfe fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept a0655bce5 chore(dev): add local config example and gitignore entries
- kept 77b670a36 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept 39e14596d chore(fork): sync log for v17.0.7
- kept e938d17b7 chore(fork): formalize upstream sync process knowledge and concepts
- kept 02c266bed chore(fork): sync log for v17.1.0
- kept f1f48d5a6 chore(fork): sync log for v17.1.1
- note: a0655bce5 chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: 39e14596d chore(fork): sync log for v17.0.7 (no owned tests — manual review)
- note: e938d17b7 chore(fork): formalize upstream sync process knowledge and concepts (no owned tests — manual review)
- note: 02c266bed chore(fork): sync log for v17.1.0 (no owned tests — manual review)
- note: f1f48d5a6 chore(fork): sync log for v17.1.1 (no owned tests — manual review)

### 2026-07-24 — v17.1.0 → v17.1.1

- kept 2408ea9a1 feat(ai): introduce policy rejections for exec handlers
- kept 405eb462d fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 5f6b09d31 chore(dev): add local config example and gitignore entries
- kept 987750302 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept 1d641a6d9 chore(fork): sync log for v17.0.7
- kept 64123bfc8 chore(fork): formalize upstream sync process knowledge and concepts
- kept 342f4188c chore(fork): sync log for v17.1.0

### 2026-07-24 — v17.0.7 → v17.1.0

- kept d52878f68 feat(ai): introduce policy rejections for exec handlers
- kept 1fd4d437d fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept b6b147414 chore(dev): add local config example and gitignore entries
- kept 2266c4537 chore(fork): add upstream sync process (runbook + sync-upstream script)
- kept a17b9c57f chore(fork): sync log for v17.0.7
- kept a9f2e150c chore(fork): formalize upstream sync process knowledge and concepts
- note: b6b147414 chore(dev): add local config example and gitignore entries (no owned tests — manual review)
- note: a17b9c57f chore(fork): sync log for v17.0.7 (no owned tests — manual review)
- note: a9f2e150c chore(fork): formalize upstream sync process knowledge and concepts (no owned tests — manual review)

### 2026-07-22 — v17.0.6 → v17.0.7

- kept 5a6ec1bb3 feat(ai): introduce policy rejections for exec handlers
- kept ae1db605e fix(ai,coding-agent): stop doubling /v1/models entries, add context window fields
- kept 50c843278 chore(dev): add local config example and gitignore entries
- kept 658659ce6 chore(fork): add upstream sync process (runbook + sync-upstream script)
