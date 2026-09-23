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

### 2026-09-23 — v18.2.10 → v18.2.11

- kept c66a78a979 feat(ai): enforce Cursor execution policy rejections
- kept 37b235caa5 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 70fa69fc78 chore(dev): preserve fork-local development configuration
- kept 73d0d3e489 fix(natives): diagnose and safely promote workspace addons
- kept f4b7e36edd chore(fork): automate parentless syncs with verified npm natives
- kept 1f0c2afd28 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 1c44fae199 chore(fork): promote automatically once sync verification passes
- kept d6f79cb855 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 1c6d167064 fix(sync): clear stale unregistered worktree directories
- kept 7915941cae fix(coding-agent): decide non-symlink containment by the parent directory
- kept c89c612fa0 docs(solutions): capture macOS hard-link realpath containment learning
- kept 71f495256b docs(solutions): record rejection of context-mode plugin for omp
- kept 7ae9b3a80c fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 0beb279d42 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept c673b6c0ea refactor(sync): classify fork records by file paths only, drop subject check
- kept 0d2508fe07 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept c3be3c22e8 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 24c83387ea feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 71a291174e chore(fork): consolidate sync log through v18.0.10
- kept 91b319e22d fix(sync): accept native leaves when the core meta publish lags
- kept 2f1f1553ea docs(ai): document Cloud Code Assist schema rejection workaround
- kept 3ea6fca24f fix: resolve Bun executable before setting omp process name
- kept a221b86aa9 chore(fork): record manual-review acceptances
- kept 9fea67274c chore(config): enable jbcontext MCP server
- kept 9124131bc1 chore(deps): pin Bun package manager to v1.4.2
- kept 5a96208d3f chore(fork): record manual-review acceptances
- kept 61f35e49d0 chore(fork): consolidate sync log through v18.2.0
- kept 9becb8dd6c chore(fork): ignore the sync-upstream resume checkpoint
- kept 0e252ed683 chore(fork): sync log for v18.2.1
- kept 3d1ba36e82 chore(fork): sync log for v18.2.2
- kept c7e06f6a77 chore(fork): sync log for v18.2.3
- kept f263c1337d chore(fork): sync log for v18.2.4
- kept bc187aa892 chore(fork): sync log for v18.2.5
- kept ddecd779a5 chore(fork): sync log for v18.2.6
- kept 8c22db2138 fix(auth-gateway): exclude MCP credentials from health checks
- kept 2364a9ad98 chore(fork): sync log for v18.2.7
- kept 17ca8b53e1 fix(fork): align gateway checks with v18.2.8 replant
- kept 1a06f99171 chore(fork): sync log for v18.2.8
- kept d0fcff77cd chore(fork): sync log for v18.2.9
- kept 9306aede26 chore(fork): sync log for v18.2.10

### 2026-09-22 — v18.2.9 → v18.2.10

- kept 7380bd34dd feat(ai): enforce Cursor execution policy rejections
- kept 8ba4588449 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept a5e0d8a2c8 chore(dev): preserve fork-local development configuration
- kept 66e415f5a0 fix(natives): diagnose and safely promote workspace addons
- kept 98d06679c8 chore(fork): automate parentless syncs with verified npm natives
- kept e0fee25bd2 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept ad651c182f chore(fork): promote automatically once sync verification passes
- kept f7b561c08c chore(dev): pin the shared mnemopi bank for worktree sessions
- kept b61a85c58c fix(sync): clear stale unregistered worktree directories
- kept e5692361d1 fix(coding-agent): decide non-symlink containment by the parent directory
- kept bfd29a0709 docs(solutions): capture macOS hard-link realpath containment learning
- kept aad694698e docs(solutions): record rejection of context-mode plugin for omp
- kept d418e875a1 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept c247058253 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept e9398f78b7 refactor(sync): classify fork records by file paths only, drop subject check
- kept e72fe2969b feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept fb193d48a0 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept a74c5a0ca6 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 825a89ba0e chore(fork): consolidate sync log through v18.0.10
- kept cc3d5e81f6 fix(sync): accept native leaves when the core meta publish lags
- kept 6cb1587216 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 728a456a22 fix: resolve Bun executable before setting omp process name
- kept 15b55d7e8c chore(fork): record manual-review acceptances
- kept af4c30580f chore(config): enable jbcontext MCP server
- kept c72d9d9d40 chore(deps): pin Bun package manager to v1.4.2
- kept cfa3ed6785 chore(fork): record manual-review acceptances
- kept 38cacbb2ac chore(fork): consolidate sync log through v18.2.0
- kept 276b3dff59 chore(fork): ignore the sync-upstream resume checkpoint
- kept 140fea6093 chore(fork): sync log for v18.2.1
- kept 2591d30578 chore(fork): sync log for v18.2.2
- kept 04c445a054 chore(fork): sync log for v18.2.3
- kept a08cbf54b2 chore(fork): sync log for v18.2.4
- kept cbcd05d9a4 chore(fork): sync log for v18.2.5
- kept 903f527442 chore(fork): sync log for v18.2.6
- kept 1d097fed67 fix(auth-gateway): exclude MCP credentials from health checks
- kept dff30a2090 chore(fork): sync log for v18.2.7
- kept daf2dcc8d0 fix(fork): align gateway checks with v18.2.8 replant
- kept d3a881b7b1 chore(fork): sync log for v18.2.8
- kept 2accdb4d92 chore(fork): sync log for v18.2.9

### 2026-09-22 — v18.2.8 → v18.2.9

- kept cab45d8233 feat(ai): enforce Cursor execution policy rejections
- kept 5d2ce783aa fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 1b403c5d10 chore(dev): preserve fork-local development configuration
- kept b6dd9d3375 fix(natives): diagnose and safely promote workspace addons
- kept 17c39df5d0 chore(fork): automate parentless syncs with verified npm natives
- kept 766414733a docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept c5c9e1794d chore(fork): promote automatically once sync verification passes
- kept 3b6b46067d chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 04db3d0a4a fix(sync): clear stale unregistered worktree directories
- kept 82700ad075 fix(coding-agent): decide non-symlink containment by the parent directory
- kept f9273ac068 docs(solutions): capture macOS hard-link realpath containment learning
- kept 05e7ef9969 docs(solutions): record rejection of context-mode plugin for omp
- kept 2909b31d1a fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 95593a1c94 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 52730c3ad6 refactor(sync): classify fork records by file paths only, drop subject check
- kept d1cb9b34e5 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 33af8b006e fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 573eb3a29d feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept f57e92b7ad chore(fork): consolidate sync log through v18.0.10
- kept 30a4753b35 fix(sync): accept native leaves when the core meta publish lags
- kept 6f567c0bbb docs(ai): document Cloud Code Assist schema rejection workaround
- kept fea495faaa fix: resolve Bun executable before setting omp process name
- kept f4800c7d13 chore(fork): record manual-review acceptances
- kept 282253d956 chore(config): enable jbcontext MCP server
- kept f6d83ae0e2 chore(deps): pin Bun package manager to v1.4.2
- kept 001173b505 chore(fork): record manual-review acceptances
- kept c0e3785acc chore(fork): consolidate sync log through v18.2.0
- kept e71634430b chore(fork): ignore the sync-upstream resume checkpoint
- kept d4e6cec250 chore(fork): sync log for v18.2.1
- kept f1ab05b3d9 chore(fork): sync log for v18.2.2
- kept cfb544a83c chore(fork): sync log for v18.2.3
- kept df7cd56a5e chore(fork): sync log for v18.2.4
- kept b06bfe5973 chore(fork): sync log for v18.2.5
- kept a59e22b189 chore(fork): sync log for v18.2.6
- kept 08872709f7 fix(auth-gateway): exclude MCP credentials from health checks
- kept 2274dace0c chore(fork): sync log for v18.2.7
- kept 6e02d06586 fix(fork): align gateway checks with v18.2.8 replant
- kept a027144f24 chore(fork): sync log for v18.2.8

### 2026-09-21 — v18.2.7 → v18.2.8

- kept 3143b063fc feat(ai): enforce Cursor execution policy rejections
- kept 03e08611cd fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 07893cb75f chore(dev): preserve fork-local development configuration
- kept d316dfa97e fix(natives): diagnose and safely promote workspace addons
- kept 9c3e801dc6 chore(fork): automate parentless syncs with verified npm natives
- kept 8c2e508b9d docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 3070251c46 chore(fork): promote automatically once sync verification passes
- kept 931d4d6b6e chore(dev): pin the shared mnemopi bank for worktree sessions
- kept a8bfead40c fix(sync): clear stale unregistered worktree directories
- kept 9553c3c018 fix(coding-agent): decide non-symlink containment by the parent directory
- kept f67766d5ea docs(solutions): capture macOS hard-link realpath containment learning
- kept 71bdc38da5 docs(solutions): record rejection of context-mode plugin for omp
- kept b66d9cfc8c fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept bcfbdad13e fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 7943f63804 refactor(sync): classify fork records by file paths only, drop subject check
- kept f82f002489 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept e47064acde fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 3feadee48f feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 6432a34df3 chore(fork): consolidate sync log through v18.0.10
- kept ca22fedd84 fix(sync): accept native leaves when the core meta publish lags
- kept 0e493389c5 docs(ai): document Cloud Code Assist schema rejection workaround
- kept c7bcdf1e9f fix: resolve Bun executable before setting omp process name
- kept 638eff3d57 chore(fork): record manual-review acceptances
- kept c68cb8a8dd chore(config): enable jbcontext MCP server
- kept 6353c1affa chore(deps): pin Bun package manager to v1.4.2
- kept 1f9cb6829e chore(fork): record manual-review acceptances
- kept b6ed3951bd chore(fork): consolidate sync log through v18.2.0
- kept e6f1e067d5 chore(fork): ignore the sync-upstream resume checkpoint
- kept ee4c9ae9f9 chore(fork): sync log for v18.2.1
- kept 433a003f86 chore(fork): sync log for v18.2.2
- kept fd995c6bca chore(fork): sync log for v18.2.3
- kept f503aaa176 chore(fork): sync log for v18.2.4
- kept 2f9ee5be9b chore(fork): sync log for v18.2.5
- kept 73c4e31ec8 chore(fork): sync log for v18.2.6
- kept 2204da7a98 fix(auth-gateway): exclude MCP credentials from health checks
- kept 2c5913afe9 chore(fork): sync log for v18.2.7
- kept 3eebf3044a fix(fork): align gateway checks with v18.2.8 replant

### 2026-09-21 — v18.2.6 → v18.2.7

- kept 44e07e90b0 feat(ai): enforce Cursor execution policy rejections
- kept d288bc3f35 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 43ff107ef7 chore(dev): preserve fork-local development configuration
- kept 0166dd3c1e fix(natives): diagnose and safely promote workspace addons
- kept 595c8657fa chore(fork): automate parentless syncs with verified npm natives
- kept 7766bd8fed docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept ef141b213d chore(fork): promote automatically once sync verification passes
- kept 5ca0a4ee78 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept d31b521036 fix(sync): clear stale unregistered worktree directories
- kept 39de3b835b fix(coding-agent): decide non-symlink containment by the parent directory
- kept 1f49e93c66 docs(solutions): capture macOS hard-link realpath containment learning
- kept 33ae25fbd2 docs(solutions): record rejection of context-mode plugin for omp
- kept 339c9d6782 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 3eed986ba0 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 9c8868522f refactor(sync): classify fork records by file paths only, drop subject check
- kept 134203f66d feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 3f693c0a48 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 5bc40dfc60 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept bf41635d6a chore(fork): consolidate sync log through v18.0.10
- kept a58814561e fix(sync): accept native leaves when the core meta publish lags
- kept dc71b92093 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 7181e88fd6 fix: resolve Bun executable before setting omp process name
- kept 2d798056c9 chore(fork): record manual-review acceptances
- kept 299f625316 chore(config): enable jbcontext MCP server
- kept 1f5c858e8b chore(deps): pin Bun package manager to v1.4.2
- kept 345bbd861d chore(fork): record manual-review acceptances
- kept 3fbb0feffb chore(fork): consolidate sync log through v18.2.0
- kept 005126b089 chore(fork): ignore the sync-upstream resume checkpoint
- kept e1434b7a08 chore(fork): sync log for v18.2.1
- kept e759198738 chore(fork): sync log for v18.2.2
- kept f5cee4ad4b chore(fork): sync log for v18.2.3
- kept 3311a1816b chore(fork): sync log for v18.2.4
- kept 1940c8d672 chore(fork): sync log for v18.2.5
- kept b249d5572e chore(fork): sync log for v18.2.6
- kept 17c23e1d65 fix(auth-gateway): exclude MCP credentials from health checks

### 2026-09-18 — v18.2.5 → v18.2.6

- kept 0dc99d164d feat(ai): enforce Cursor execution policy rejections
- kept 7c71861fc8 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 6ea9edc8b1 chore(dev): preserve fork-local development configuration
- kept d02f680ca0 fix(natives): diagnose and safely promote workspace addons
- kept b28d93a29b chore(fork): automate parentless syncs with verified npm natives
- kept dad5534ada docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept b088dbbe62 chore(fork): promote automatically once sync verification passes
- kept 4f86800511 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 2bcdffa543 fix(sync): clear stale unregistered worktree directories
- kept bf84e6e03f fix(coding-agent): decide non-symlink containment by the parent directory
- kept 57154e8344 docs(solutions): capture macOS hard-link realpath containment learning
- kept 460f5e1990 docs(solutions): record rejection of context-mode plugin for omp
- kept d13d936f25 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 0775065f23 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 06e12397c2 refactor(sync): classify fork records by file paths only, drop subject check
- kept aa56ae23f7 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 2139db3337 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 6bae0e5009 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 72ab7df394 chore(fork): consolidate sync log through v18.0.10
- kept 7ef015100b fix(sync): accept native leaves when the core meta publish lags
- kept e33b0aa54f docs(ai): document Cloud Code Assist schema rejection workaround
- kept 3fd5909c50 fix: resolve Bun executable before setting omp process name
- kept 8ff7feb7c4 chore(fork): record manual-review acceptances
- kept 92a76eee3e chore(config): enable jbcontext MCP server
- kept 6f3d29f001 chore(deps): pin Bun package manager to v1.4.2
- kept dff65834d6 chore(fork): record manual-review acceptances
- kept d78ff61c82 chore(fork): consolidate sync log through v18.2.0
- kept 529c7cd1e6 chore(fork): ignore the sync-upstream resume checkpoint
- kept 5c27e92b03 chore(fork): sync log for v18.2.1
- kept 52c553aa83 chore(fork): sync log for v18.2.2
- kept f969cd4421 chore(fork): sync log for v18.2.3
- kept dafc76a422 chore(fork): sync log for v18.2.4
- kept 06ca6c3994 chore(fork): sync log for v18.2.5

### 2026-09-18 — v18.2.4 → v18.2.5

- kept 75d3ff7310 feat(ai): enforce Cursor execution policy rejections
- kept a9600200f6 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept d39ae621f1 chore(dev): preserve fork-local development configuration
- kept 8a7466c7e3 fix(natives): diagnose and safely promote workspace addons
- kept 4e362b17af chore(fork): automate parentless syncs with verified npm natives
- kept 0dcedbaeca docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 73a607185d chore(fork): promote automatically once sync verification passes
- kept ee04ec9ec9 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 279db764cd fix(sync): clear stale unregistered worktree directories
- kept efcf3649db fix(coding-agent): decide non-symlink containment by the parent directory
- kept a0a48502a8 docs(solutions): capture macOS hard-link realpath containment learning
- kept eac38d47d6 docs(solutions): record rejection of context-mode plugin for omp
- kept b9c6a7d465 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 867e2c5a94 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 003125699a refactor(sync): classify fork records by file paths only, drop subject check
- kept 6a7256d052 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 58e8926b31 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 5bffb3df02 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 4cdb137323 chore(fork): consolidate sync log through v18.0.10
- kept 7ee987f937 fix(sync): accept native leaves when the core meta publish lags
- kept 984609955f docs(ai): document Cloud Code Assist schema rejection workaround
- kept 9b91e73a9b fix: resolve Bun executable before setting omp process name
- kept df6be3ef2e chore(fork): record manual-review acceptances
- kept 95eda837ae chore(config): enable jbcontext MCP server
- kept 54f9ba5779 chore(deps): pin Bun package manager to v1.4.2
- kept 268f4d1cd8 chore(fork): record manual-review acceptances
- kept 6a2281c2d2 chore(fork): consolidate sync log through v18.2.0
- kept a279ea2265 chore(fork): ignore the sync-upstream resume checkpoint
- kept 89de9ac553 chore(fork): sync log for v18.2.1
- kept c55d177aa3 chore(fork): sync log for v18.2.2
- kept fb415dfda0 chore(fork): sync log for v18.2.3
- kept 4f8bc65e0c chore(fork): sync log for v18.2.4

### 2026-09-17 — v18.2.3 → v18.2.4

- kept d75338d88e feat(ai): enforce Cursor execution policy rejections
- kept 1f5cc43c5c fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 6a8a6d5639 chore(dev): preserve fork-local development configuration
- kept 14553a37fc fix(natives): diagnose and safely promote workspace addons
- kept 87c56e6431 chore(fork): automate parentless syncs with verified npm natives
- kept 41a6034cf4 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept b6929dc579 chore(fork): promote automatically once sync verification passes
- kept d92be10b80 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 7e3a9c203d fix(sync): clear stale unregistered worktree directories
- kept 6152d977e8 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 403a6fbf38 docs(solutions): capture macOS hard-link realpath containment learning
- kept fd6af1e3e9 docs(solutions): record rejection of context-mode plugin for omp
- kept 8afccedd2d fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 4cfb06b46f fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 1f16d87803 refactor(sync): classify fork records by file paths only, drop subject check
- kept f6282919b6 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 27d818c130 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 6d7489ea33 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 68ddfef480 chore(fork): consolidate sync log through v18.0.10
- kept cfb256ced7 fix(sync): accept native leaves when the core meta publish lags
- kept 7255222be1 docs(ai): document Cloud Code Assist schema rejection workaround
- kept cacfac311c fix: resolve Bun executable before setting omp process name
- kept ff6d7fee62 chore(fork): record manual-review acceptances
- kept c2339038f8 chore(config): enable jbcontext MCP server
- kept 1e028d39de chore(deps): pin Bun package manager to v1.4.2
- kept befec97d22 chore(fork): record manual-review acceptances
- kept cb10d7bc2e chore(fork): consolidate sync log through v18.2.0
- kept 9835c22209 chore(fork): ignore the sync-upstream resume checkpoint
- kept 45f0894b30 chore(fork): sync log for v18.2.1
- kept 1c1282819b chore(fork): sync log for v18.2.2
- kept 2ee5c0810f chore(fork): sync log for v18.2.3

### 2026-09-17 — v18.2.2 → v18.2.3

- kept f24f213a56 feat(ai): enforce Cursor execution policy rejections
- kept ff17f14a78 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 9427501ef7 chore(dev): preserve fork-local development configuration
- kept c2bf9c308e fix(natives): diagnose and safely promote workspace addons
- kept a14454c78d chore(fork): automate parentless syncs with verified npm natives
- kept 2468cf58d3 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 37e58f3972 chore(fork): promote automatically once sync verification passes
- kept b8ccaa37c4 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept a0410d091c fix(sync): clear stale unregistered worktree directories
- kept 82e1a84dcd fix(coding-agent): decide non-symlink containment by the parent directory
- kept 6c41696d34 docs(solutions): capture macOS hard-link realpath containment learning
- kept 828b29731c docs(solutions): record rejection of context-mode plugin for omp
- kept 2b86806c4a fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept d25dc8bfa7 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 9d64057e0b refactor(sync): classify fork records by file paths only, drop subject check
- kept 37bccaf0c4 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 8d684fda19 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept f2f6fbd5b9 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 4b55809cc6 chore(fork): consolidate sync log through v18.0.10
- kept 3e89a83781 fix(sync): accept native leaves when the core meta publish lags
- kept 5cd7ae0b36 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 2a8b37d75e fix: resolve Bun executable before setting omp process name
- kept 58eaffba88 chore(fork): record manual-review acceptances
- kept 7e0f147d7b chore(config): enable jbcontext MCP server
- kept 76ae8a7a1e chore(deps): pin Bun package manager to v1.4.2
- kept 234375452c chore(fork): record manual-review acceptances
- kept 2ab2ffabf7 chore(fork): consolidate sync log through v18.2.0
- kept 58baf01e15 chore(fork): ignore the sync-upstream resume checkpoint
- kept 00e2fbf51f chore(fork): sync log for v18.2.1
- kept 3fbc5c705c chore(fork): sync log for v18.2.2

### 2026-09-16 — v18.2.1 → v18.2.2

- kept 6353aab23d feat(ai): enforce Cursor execution policy rejections
- kept e81bd5537d fix(ai,coding-agent): normalize gateway model catalog metadata
- kept dceadf9587 chore(dev): preserve fork-local development configuration
- kept bef068dbcc fix(natives): diagnose and safely promote workspace addons
- kept 833856f599 chore(fork): automate parentless syncs with verified npm natives
- kept 81edec3a89 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept fa2748542a chore(fork): promote automatically once sync verification passes
- kept bba456c666 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 7c686123a3 fix(sync): clear stale unregistered worktree directories
- kept eebba7f35a fix(coding-agent): decide non-symlink containment by the parent directory
- kept 2076394736 docs(solutions): capture macOS hard-link realpath containment learning
- kept da40f97e6f docs(solutions): record rejection of context-mode plugin for omp
- kept 2c5e759825 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 1d538e0f1e fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 81b2672282 refactor(sync): classify fork records by file paths only, drop subject check
- kept 05dfe7af3f feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 3cf1f11561 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept c1463ca731 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept d8cbfbdd69 chore(fork): consolidate sync log through v18.0.10
- kept 419625343d fix(sync): accept native leaves when the core meta publish lags
- kept 63125340fc docs(ai): document Cloud Code Assist schema rejection workaround
- kept cff98f8471 fix: resolve Bun executable before setting omp process name
- kept 78d49e3ba0 chore(fork): record manual-review acceptances
- kept ba6f75ed32 chore(config): enable jbcontext MCP server
- kept 0780908213 chore(deps): pin Bun package manager to v1.4.2
- kept 87f99ef687 chore(fork): record manual-review acceptances
- kept 0bdfe6b987 chore(fork): consolidate sync log through v18.2.0
- kept 2d255f67db chore(fork): ignore the sync-upstream resume checkpoint
- kept daabc6b249 chore(fork): sync log for v18.2.1

### 2026-09-16 — v18.2.0 → v18.2.1

- kept 002818a867 feat(ai): enforce Cursor execution policy rejections
- kept 1db4c6352a fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 42a7c35184 chore(dev): preserve fork-local development configuration
- kept cf317fe7c4 fix(natives): diagnose and safely promote workspace addons
- kept 6ba8f41542 chore(fork): automate parentless syncs with verified npm natives
- kept c0445a8527 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 3c8f1783d8 chore(fork): promote automatically once sync verification passes
- kept d98f966186 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 785ca15f34 fix(sync): clear stale unregistered worktree directories
- kept 32df795870 fix(coding-agent): decide non-symlink containment by the parent directory
- kept fa1b8b9e89 docs(solutions): capture macOS hard-link realpath containment learning
- kept ddaf593dff docs(solutions): record rejection of context-mode plugin for omp
- kept fb790d7fcc fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 52f3b111b9 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 408d033340 refactor(sync): classify fork records by file paths only, drop subject check
- kept ca4109f635 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept ef29930dd0 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 19952140b9 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 4d827240e3 chore(fork): consolidate sync log through v18.0.10
- kept 5393e5a436 fix(sync): accept native leaves when the core meta publish lags
- kept 535d6be0d3 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 097a3f3005 fix: resolve Bun executable before setting omp process name
- kept 24c243fa25 chore(fork): record manual-review acceptances
- kept 8cf204cf27 chore(config): enable jbcontext MCP server
- kept 442772d4ba chore(deps): pin Bun package manager to v1.4.2
- kept c87a134265 chore(fork): record manual-review acceptances
- kept 5f6c73e7a7 chore(fork): consolidate sync log through v18.2.0
- kept a41ce9dc43 chore(fork): ignore the sync-upstream resume checkpoint

### 2026-09-15 — v18.1.22 → v18.2.0

- kept e5386105ce feat(ai): enforce Cursor execution policy rejections
- kept febb5ddad9 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept a4d00ed99b chore(dev): preserve fork-local development configuration
- kept b65f0e3e32 fix(natives): diagnose and safely promote workspace addons
- kept 8358949d91 chore(fork): automate parentless syncs with verified npm natives
- kept d5ac29dd45 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 499c9a05da chore(fork): promote automatically once sync verification passes
- kept 7ef28219de chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 3b22013825 fix(sync): clear stale unregistered worktree directories
- kept 45b5a5239d fix(coding-agent): decide non-symlink containment by the parent directory
- kept 6577ca94e0 docs(solutions): capture macOS hard-link realpath containment learning
- kept c595e586f3 docs(solutions): record rejection of context-mode plugin for omp
- kept 95104ea3da fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 9a1b3584e5 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 588d3b372b refactor(sync): classify fork records by file paths only, drop subject check
- kept 6e822c0e4b feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept ad55434968 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 44c453406c feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 9c4a557a63 chore(fork): consolidate sync log through v18.0.10
- kept 4eb810a368 chore(fork): sync log for v18.0.11
- kept fe11fbbe7e chore(fork): sync log for v18.1.0
- kept 182927c583 chore(fork): sync log for v18.1.1
- kept afc9cd64f7 chore(fork): sync log for v18.1.2
- kept 69e3d84c48 chore(fork): sync log for v18.1.3
- kept b176494c92 chore(fork): sync log for v18.1.4
- kept 75864cd4a3 chore(fork): sync log for v18.1.6
- kept 04f550bead fix(sync): accept native leaves when the core meta publish lags
- kept d2ffd38a5c chore(fork): sync log for v18.1.8
- kept 59d0047a22 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 95299c6414 chore(fork): sync log for v18.1.10
- kept f2de9d819b chore(fork): sync log for v18.1.11
- kept cc4cc72795 chore(fork): sync log for v18.1.13
- kept 3924d80c64 chore(fork): sync log for v18.1.14
- kept da12e0bd32 chore(fork): sync log for v18.1.15
- kept 31623bb943 fix: resolve Bun executable before setting omp process name
- kept 695d8ec32a chore(fork): record manual-review acceptances
- kept 8649861bc1 chore(fork): sync log for v18.1.16
- kept ab7f0a3cab chore(fork): sync log for v18.1.17
- kept b6e8e1eca5 chore(fork): sync log for v18.1.18
- kept 0438ad7f23 chore(fork): sync log for v18.1.19
- kept e6ac2ed312 chore(fork): sync log for v18.1.20
- kept e7e772f475 chore(config): enable jbcontext MCP server
- kept db93e6a399 chore(fork): sync log for v18.1.21
- kept 34d1d36059 chore(fork): sync log for v18.1.22
- kept a272f5224e chore(deps): pin Bun package manager to v1.4.2
- kept 039402e8ac chore(fork): record manual-review acceptances

### 2026-09-15 — v18.1.21 → v18.1.22

- kept bc6420e9af feat(ai): enforce Cursor execution policy rejections
- kept 3091de1825 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept c5723fa015 chore(dev): preserve fork-local development configuration
- kept d4d5e4107d fix(natives): diagnose and safely promote workspace addons
- kept 8a0e957b22 chore(fork): automate parentless syncs with verified npm natives
- kept b3b6afd59e docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept cc8b420968 chore(fork): promote automatically once sync verification passes
- kept 4b7b9486dc chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 04f339bb0d fix(sync): clear stale unregistered worktree directories
- kept 178bf6e390 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 094d7075a0 docs(solutions): capture macOS hard-link realpath containment learning
- kept b1ce1ca6c2 docs(solutions): record rejection of context-mode plugin for omp
- kept 7b85c8d986 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 2c9b098970 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 4d455946e8 refactor(sync): classify fork records by file paths only, drop subject check
- kept 33784b2f1d feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept bbadf2bb48 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 4966516272 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 5012fb501c chore(fork): consolidate sync log through v18.0.10
- kept ede24f223c chore(fork): sync log for v18.0.11
- kept f1880cc544 chore(fork): sync log for v18.1.0
- kept d0c75c79be chore(fork): sync log for v18.1.1
- kept 9e543b84dc chore(fork): sync log for v18.1.2
- kept c83c13ffb0 chore(fork): sync log for v18.1.3
- kept 8c5d6fbdb5 chore(fork): sync log for v18.1.4
- kept 7848edb557 chore(fork): sync log for v18.1.6
- kept 0d174e6631 fix(sync): accept native leaves when the core meta publish lags
- kept 212b45418a chore(fork): sync log for v18.1.8
- kept ed751fae57 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 0eff73244f chore(fork): sync log for v18.1.10
- kept 827d1e0570 chore(fork): sync log for v18.1.11
- kept 39e3fbd951 chore(fork): sync log for v18.1.13
- kept 0eb0ae35f6 chore(fork): sync log for v18.1.14
- kept 1277ffb817 chore(fork): sync log for v18.1.15
- kept 724efa86ca fix: resolve Bun executable before setting omp process name
- kept 41bf917b38 chore(fork): record manual-review acceptances
- kept a74761d481 chore(fork): sync log for v18.1.16
- kept 29a98b2ee0 chore(fork): sync log for v18.1.17
- kept 807bf50ad9 chore(fork): sync log for v18.1.18
- kept 2d76837172 chore(fork): sync log for v18.1.19
- kept 44dc179eeb chore(fork): sync log for v18.1.20
- kept 5b5599bffd chore(config): enable jbcontext MCP server
- kept ea28287ee9 chore(fork): sync log for v18.1.21

### 2026-09-14 — v18.1.20 → v18.1.21

- kept c6b0cbdfc9 feat(ai): enforce Cursor execution policy rejections
- kept bd7c0baa26 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 5025436df6 chore(dev): preserve fork-local development configuration
- kept 1dc9aad978 fix(natives): diagnose and safely promote workspace addons
- kept 5208feee6f chore(fork): automate parentless syncs with verified npm natives
- kept 5c4498cbd1 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept eb10b457b1 chore(fork): promote automatically once sync verification passes
- kept fa6208f540 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept f8af51f2ef fix(sync): clear stale unregistered worktree directories
- kept 41e41eccb3 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 9a36eba3e3 docs(solutions): capture macOS hard-link realpath containment learning
- kept 71981db56f docs(solutions): record rejection of context-mode plugin for omp
- kept 00c54a440d fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 5ae6c1df7a fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 8ac5599dfc refactor(sync): classify fork records by file paths only, drop subject check
- kept cab1399da6 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 4f0cf69ac7 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept e0d91debb6 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 4d86b3e036 chore(fork): consolidate sync log through v18.0.10
- kept 9fcdfa1324 chore(fork): sync log for v18.0.11
- kept 35b635f0de chore(fork): sync log for v18.1.0
- kept 1dd64b011b chore(fork): sync log for v18.1.1
- kept b334047acc chore(fork): sync log for v18.1.2
- kept 54feff3c17 chore(fork): sync log for v18.1.3
- kept c2fa27e98b chore(fork): sync log for v18.1.4
- kept de4409dc77 chore(fork): sync log for v18.1.6
- kept 6180bebcee fix(sync): accept native leaves when the core meta publish lags
- kept fb635c7490 chore(fork): sync log for v18.1.8
- kept 4792ccab01 docs(ai): document Cloud Code Assist schema rejection workaround
- kept fe838f1116 chore(fork): sync log for v18.1.10
- kept 8b0619b3ee chore(fork): sync log for v18.1.11
- kept 5b7470540d chore(fork): sync log for v18.1.13
- kept d9bce8efd5 chore(fork): sync log for v18.1.14
- kept 34f55ddb05 chore(fork): sync log for v18.1.15
- kept 8096038177 fix: resolve Bun executable before setting omp process name
- kept cf96009317 chore(fork): record manual-review acceptances
- kept 7535232d23 chore(fork): sync log for v18.1.16
- kept 88c786d173 chore(fork): sync log for v18.1.17
- kept f64a3de057 chore(fork): sync log for v18.1.18
- kept 7961436733 chore(fork): sync log for v18.1.19
- kept b4d80e9b4c chore(fork): sync log for v18.1.20
- kept 62219e1de0 chore(config): enable jbcontext MCP server

### 2026-09-13 — v18.1.19 → v18.1.20

- kept 6ce6bc5fdf feat(ai): enforce Cursor execution policy rejections
- kept 50abed0dad fix(ai,coding-agent): normalize gateway model catalog metadata
- kept c04f9f6e7e chore(dev): preserve fork-local development configuration
- kept 2ed2e915ae fix(natives): diagnose and safely promote workspace addons
- kept 01ce4e36ab chore(fork): automate parentless syncs with verified npm natives
- kept 60055ae010 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 25d95d5694 chore(fork): promote automatically once sync verification passes
- kept 23479cfa7d chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 6a4f777e7e fix(sync): clear stale unregistered worktree directories
- kept b190f5aa83 fix(coding-agent): decide non-symlink containment by the parent directory
- kept ab691e372c docs(solutions): capture macOS hard-link realpath containment learning
- kept 2d63eb75d6 docs(solutions): record rejection of context-mode plugin for omp
- kept 4bee727b8f fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 9d086b23b8 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 0b3990ffc9 refactor(sync): classify fork records by file paths only, drop subject check
- kept e7c5e13b6a feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept e7e9b09f8c fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept ab0de78953 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 6617805509 chore(fork): consolidate sync log through v18.0.10
- kept 03756f2790 chore(fork): sync log for v18.0.11
- kept 48572c10db chore(fork): sync log for v18.1.0
- kept 3d08c91b71 chore(fork): sync log for v18.1.1
- kept 6dcf084e07 chore(fork): sync log for v18.1.2
- kept f202ef30c1 chore(fork): sync log for v18.1.3
- kept 212dc9b2f6 chore(fork): sync log for v18.1.4
- kept b9165ca197 chore(fork): sync log for v18.1.6
- kept 5f5f8a52b8 fix(sync): accept native leaves when the core meta publish lags
- kept 60d0d59233 chore(fork): sync log for v18.1.8
- kept b30f3d8381 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 0a41dc49cc chore(fork): sync log for v18.1.10
- kept 8b7521d5c5 chore(fork): sync log for v18.1.11
- kept 3bc9ee2476 chore(fork): sync log for v18.1.13
- kept 8692bdff52 chore(fork): sync log for v18.1.14
- kept 27a971be61 chore(fork): sync log for v18.1.15
- kept 65a8b675e5 fix: resolve Bun executable before setting omp process name
- kept 9725d61163 chore(fork): record manual-review acceptances
- kept 97c506c1f5 chore(fork): sync log for v18.1.16
- kept 15e630c589 chore(fork): sync log for v18.1.17
- kept 4449cb391b chore(fork): sync log for v18.1.18
- kept 5796972abd chore(fork): sync log for v18.1.19

### 2026-09-13 — v18.1.18 → v18.1.19

- kept b10b4152e8 feat(ai): enforce Cursor execution policy rejections
- kept da56fa0b9e fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 14b3cbe3ee chore(dev): preserve fork-local development configuration
- kept 7fb5709f6b fix(natives): diagnose and safely promote workspace addons
- kept 6235876a68 chore(fork): automate parentless syncs with verified npm natives
- kept 0f7a462b86 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 50144f68b9 chore(fork): promote automatically once sync verification passes
- kept df1b698d93 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 7ba852fe81 fix(sync): clear stale unregistered worktree directories
- kept d1bf6f322f fix(coding-agent): decide non-symlink containment by the parent directory
- kept 1fe13b3dc9 docs(solutions): capture macOS hard-link realpath containment learning
- kept 47846b27d5 docs(solutions): record rejection of context-mode plugin for omp
- kept 30ed00b18b fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 43be86d4a4 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept bb7e14476d refactor(sync): classify fork records by file paths only, drop subject check
- kept fa94549642 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 104d1bec0a fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 8b5448f52f feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 34cf514492 chore(fork): consolidate sync log through v18.0.10
- kept 699c76f97f chore(fork): sync log for v18.0.11
- kept 14e3b3d305 chore(fork): sync log for v18.1.0
- kept 8df339185e chore(fork): sync log for v18.1.1
- kept 99102b4589 chore(fork): sync log for v18.1.2
- kept defe31270b chore(fork): sync log for v18.1.3
- kept 42935aff49 chore(fork): sync log for v18.1.4
- kept f050fa3620 chore(fork): sync log for v18.1.6
- kept 7051881dd6 fix(sync): accept native leaves when the core meta publish lags
- kept e11d9bb8ca chore(fork): sync log for v18.1.8
- kept 514eb905fe docs(ai): document Cloud Code Assist schema rejection workaround
- kept 15920ceb4d chore(fork): sync log for v18.1.10
- kept a42961920a chore(fork): sync log for v18.1.11
- kept e9ab3351fb chore(fork): sync log for v18.1.13
- kept 0af42a4b64 chore(fork): sync log for v18.1.14
- kept eedef82ac3 chore(fork): sync log for v18.1.15
- kept ba91cf853e fix: resolve Bun executable before setting omp process name
- kept 5e834b57e0 chore(fork): record manual-review acceptances
- kept eae61331ea chore(fork): sync log for v18.1.16
- kept e368608e8b chore(fork): sync log for v18.1.17
- kept e912116704 chore(fork): sync log for v18.1.18

### 2026-09-12 — v18.1.17 → v18.1.18

- kept 4834b94a2c feat(ai): enforce Cursor execution policy rejections
- kept 361807570d fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 606640c96b chore(dev): preserve fork-local development configuration
- kept dc2b1f74b9 fix(natives): diagnose and safely promote workspace addons
- kept fa80d3d334 chore(fork): automate parentless syncs with verified npm natives
- kept 047bc36f63 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 566d51023a chore(fork): promote automatically once sync verification passes
- kept 1f233e5bc4 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 7f8ebc4962 fix(sync): clear stale unregistered worktree directories
- kept dd2788f782 fix(coding-agent): decide non-symlink containment by the parent directory
- kept c29805a42f docs(solutions): capture macOS hard-link realpath containment learning
- kept ba280e578f docs(solutions): record rejection of context-mode plugin for omp
- kept a38a9693b5 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 913d6e9f71 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 8f0824e1c2 refactor(sync): classify fork records by file paths only, drop subject check
- kept f8e29fbe3e feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 0ae34f6b66 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept b02f03bd91 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 04981193f4 chore(fork): consolidate sync log through v18.0.10
- kept 92dc0f6f5f chore(fork): sync log for v18.0.11
- kept fd577d2cea chore(fork): sync log for v18.1.0
- kept 46f2642a3c chore(fork): sync log for v18.1.1
- kept 3dc38e4c22 chore(fork): sync log for v18.1.2
- kept e2c9517c05 chore(fork): sync log for v18.1.3
- kept 62f93458b4 chore(fork): sync log for v18.1.4
- kept 2ab4792663 chore(fork): sync log for v18.1.6
- kept 09e20bd91a fix(sync): accept native leaves when the core meta publish lags
- kept ebac4b49c1 chore(fork): sync log for v18.1.8
- kept f2757dc11e docs(ai): document Cloud Code Assist schema rejection workaround
- kept a94d7232a1 chore(fork): sync log for v18.1.10
- kept 799afc772f chore(fork): sync log for v18.1.11
- kept a41c360235 chore(fork): sync log for v18.1.13
- kept 41a4541f83 chore(fork): sync log for v18.1.14
- kept e81a779bd8 chore(fork): sync log for v18.1.15
- kept 9b20cc6f1f fix: resolve Bun executable before setting omp process name
- kept 2479d7a87d chore(fork): record manual-review acceptances
- kept aba5971e59 chore(fork): sync log for v18.1.16
- kept ede533f9d0 chore(fork): sync log for v18.1.17

### 2026-09-10 — v18.1.16 → v18.1.17

- kept 4d182d610a feat(ai): enforce Cursor execution policy rejections
- kept fe886d5da4 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 145ce4eed9 chore(dev): preserve fork-local development configuration
- kept a41b457cb8 fix(natives): diagnose and safely promote workspace addons
- kept 1a2d8eb83c chore(fork): automate parentless syncs with verified npm natives
- kept c43bb44c94 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 04306f3195 chore(fork): promote automatically once sync verification passes
- kept 17ed0070c0 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 3a9160fbad fix(sync): clear stale unregistered worktree directories
- kept d04feece28 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 1e2d2b7991 docs(solutions): capture macOS hard-link realpath containment learning
- kept ba4b0bce3f docs(solutions): record rejection of context-mode plugin for omp
- kept fa90c2a133 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 85bc238fbc fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 2663732f67 refactor(sync): classify fork records by file paths only, drop subject check
- kept fdf78a26db feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept b1ec38afe8 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 4d3068b9ea feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 1d68a72c56 chore(fork): consolidate sync log through v18.0.10
- kept 5853dde631 chore(fork): sync log for v18.0.11
- kept bab563546d chore(fork): sync log for v18.1.0
- kept fbeeed5e76 chore(fork): sync log for v18.1.1
- kept 5b4bb21ddd chore(fork): sync log for v18.1.2
- kept 8dce27f057 chore(fork): sync log for v18.1.3
- kept 4df8c97d60 chore(fork): sync log for v18.1.4
- kept aee006c792 chore(fork): sync log for v18.1.6
- kept 3eea01c8ba fix(sync): accept native leaves when the core meta publish lags
- kept 4f56bdc61f chore(fork): sync log for v18.1.8
- kept 6c3afbf1ae docs(ai): document Cloud Code Assist schema rejection workaround
- kept 009c1e5cd4 chore(fork): sync log for v18.1.10
- kept d8204e8964 chore(fork): sync log for v18.1.11
- kept 460d3e2409 chore(fork): sync log for v18.1.13
- kept 60bbef85d0 chore(fork): sync log for v18.1.14
- kept e29d13b5cd chore(fork): sync log for v18.1.15
- kept 301d1be5b6 fix: resolve Bun executable before setting omp process name
- kept 88f9418723 chore(fork): record manual-review acceptances
- kept cff5c5bb00 chore(fork): sync log for v18.1.16

### 2026-09-09 — v18.1.15 → v18.1.16

- kept 7b5794502f feat(ai): enforce Cursor execution policy rejections
- kept 93ee29c1fb fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 61730a6f4a chore(dev): preserve fork-local development configuration
- kept b2dc9e5226 fix(natives): diagnose and safely promote workspace addons
- kept 4e34019e15 chore(fork): automate parentless syncs with verified npm natives
- kept d1f87b1f0f docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept acfc6c86f1 chore(fork): promote automatically once sync verification passes
- kept 03ec6a67e0 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept ada67072dd fix(sync): clear stale unregistered worktree directories
- kept 5443cf7879 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 6184770661 docs(solutions): capture macOS hard-link realpath containment learning
- kept 020df22bf6 docs(solutions): record rejection of context-mode plugin for omp
- kept 512e192f9f fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept b0ac524090 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 002ba3ec22 refactor(sync): classify fork records by file paths only, drop subject check
- kept efd8ea4fd5 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 2b09d6b4c8 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept e90c4f1f09 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 4efe11a536 chore(fork): consolidate sync log through v18.0.10
- kept 3b8ab2b445 chore(fork): sync log for v18.0.11
- kept f0a3302f88 chore(fork): sync log for v18.1.0
- kept 8dcfeb108c chore(fork): sync log for v18.1.1
- kept 35d379de2e chore(fork): sync log for v18.1.2
- kept 26b115c6dd chore(fork): sync log for v18.1.3
- kept 7b73e6542b chore(fork): sync log for v18.1.4
- kept 2194e5cb48 chore(fork): sync log for v18.1.6
- kept 4e00fd2e93 fix(sync): accept native leaves when the core meta publish lags
- kept c587ebb271 chore(fork): sync log for v18.1.8
- kept f4b844686c docs(ai): document Cloud Code Assist schema rejection workaround
- kept ca256f6301 chore(fork): sync log for v18.1.10
- kept 6fa4984d78 chore(fork): sync log for v18.1.11
- kept 3d78310f3d chore(fork): sync log for v18.1.13
- kept bfeedd4077 chore(fork): sync log for v18.1.14
- kept 9f496154df chore(fork): sync log for v18.1.15
- kept ba0493fb50 fix: resolve Bun executable before setting omp process name
- kept 1ef2aeba8a chore(fork): record manual-review acceptances
- note: ba0493fb50 fix: resolve Bun executable before setting omp process name (no owned tests — manual review; patch-id 3907f1f30b99e11b734d3ce292219eb24dcaf193)

### 2026-09-09 — v18.1.14 → v18.1.15

- kept 062759fb3b feat(ai): enforce Cursor execution policy rejections
- kept 7a9d746032 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 284f78e529 chore(dev): preserve fork-local development configuration
- kept 756857ee22 fix(natives): diagnose and safely promote workspace addons
- kept 270af33742 chore(fork): automate parentless syncs with verified npm natives
- kept 553cfea476 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 24319c4ef3 chore(fork): promote automatically once sync verification passes
- kept 7505d553c7 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept b85acd73d2 fix(sync): clear stale unregistered worktree directories
- kept 7d1df022f2 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 68ae098dee docs(solutions): capture macOS hard-link realpath containment learning
- kept 7b4adf0205 docs(solutions): record rejection of context-mode plugin for omp
- kept 4019c7725c fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 26a7a2fe94 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept e8846f9e6d refactor(sync): classify fork records by file paths only, drop subject check
- kept aad42ce62b feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 36e51e0c8a fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept e12b940720 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 7438cb834b chore(fork): consolidate sync log through v18.0.10
- kept 99a79f8a75 chore(fork): sync log for v18.0.11
- kept 01690fc298 chore(fork): sync log for v18.1.0
- kept d5b561fbf8 chore(fork): sync log for v18.1.1
- kept 6b398e2e83 chore(fork): sync log for v18.1.2
- kept 6ae250ae6e chore(fork): sync log for v18.1.3
- kept 7ce6a13a2e chore(fork): sync log for v18.1.4
- kept ee72b6cbb8 chore(fork): sync log for v18.1.6
- kept 8d37d054cc fix(sync): accept native leaves when the core meta publish lags
- kept 48f633a217 chore(fork): sync log for v18.1.8
- kept d246ad1fe6 docs(ai): document Cloud Code Assist schema rejection workaround
- kept bdbb19dbea chore(fork): sync log for v18.1.10
- kept 9571855a91 chore(fork): sync log for v18.1.11
- kept 4ca1267c3e chore(fork): sync log for v18.1.13
- kept 20c0337dd3 chore(fork): sync log for v18.1.14

### 2026-09-08 — v18.1.13 → v18.1.14

- kept 98373d2881 feat(ai): enforce Cursor execution policy rejections
- kept 0498615b21 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 39de24bdf5 chore(dev): preserve fork-local development configuration
- kept bbaf464f5d fix(natives): diagnose and safely promote workspace addons
- kept 885be00416 chore(fork): automate parentless syncs with verified npm natives
- kept 2442e9180e docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept a061d90efc chore(fork): promote automatically once sync verification passes
- kept 38f7d7de3c chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 5a6b96ee1b fix(sync): clear stale unregistered worktree directories
- kept ba456d0e84 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 9fc4fd9ccb docs(solutions): capture macOS hard-link realpath containment learning
- kept f7e3b46d48 docs(solutions): record rejection of context-mode plugin for omp
- kept f70989fe93 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 8be9fdb830 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept e7e2b31f9b refactor(sync): classify fork records by file paths only, drop subject check
- kept a3f27bdd86 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 21826f6bb4 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept c1e2ad3998 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 8c2e419e60 chore(fork): consolidate sync log through v18.0.10
- kept 12724d5b7a chore(fork): sync log for v18.0.11
- kept d4bcbb628b chore(fork): sync log for v18.1.0
- kept eb9f0235ed chore(fork): sync log for v18.1.1
- kept 1023da7b3a chore(fork): sync log for v18.1.2
- kept 47da37aff3 chore(fork): sync log for v18.1.3
- kept ff02ea35c4 chore(fork): sync log for v18.1.4
- kept 50f558d91e chore(fork): sync log for v18.1.6
- kept 9618115271 fix(sync): accept native leaves when the core meta publish lags
- kept c100d4d233 chore(fork): sync log for v18.1.8
- kept 86cd8f2a00 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 36366590ce chore(fork): sync log for v18.1.10
- kept 9c5ed45391 chore(fork): sync log for v18.1.11
- kept ce2e556cbd chore(fork): sync log for v18.1.13

### 2026-09-07 — v18.1.11 → v18.1.13

- kept 82c8d7f36a feat(ai): enforce Cursor execution policy rejections
- kept 16dcae0d1a fix(ai,coding-agent): normalize gateway model catalog metadata
- kept ac9f406077 chore(dev): preserve fork-local development configuration
- kept 5b0808469c fix(natives): diagnose and safely promote workspace addons
- kept b6c8d986fa chore(fork): automate parentless syncs with verified npm natives
- kept 777b7d3c61 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept ae81ebdd38 chore(fork): promote automatically once sync verification passes
- kept 5accfe00f2 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept b1b8124c9a fix(sync): clear stale unregistered worktree directories
- kept f2804d2328 fix(coding-agent): decide non-symlink containment by the parent directory
- kept f22539890b docs(solutions): capture macOS hard-link realpath containment learning
- kept b044139302 docs(solutions): record rejection of context-mode plugin for omp
- kept 072c712a1a fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept aa46d16366 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 49ba4ee0a0 refactor(sync): classify fork records by file paths only, drop subject check
- kept bde3cd3aaf feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 9a0e0842c8 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept d1a7ac6e87 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept bb2f0defcd chore(fork): consolidate sync log through v18.0.10
- kept c3b85636db chore(fork): sync log for v18.0.11
- kept 047392f55b chore(fork): sync log for v18.1.0
- kept a5e2871088 chore(fork): sync log for v18.1.1
- kept 4b94601f2d chore(fork): sync log for v18.1.2
- kept 7941d2e1b2 chore(fork): sync log for v18.1.3
- kept 1c6df96bb0 chore(fork): sync log for v18.1.4
- kept 9c2744dbf7 chore(fork): sync log for v18.1.6
- kept 96db6f160e fix(sync): accept native leaves when the core meta publish lags
- kept 020ef07ae3 chore(fork): sync log for v18.1.8
- kept 82ab199a40 docs(ai): document Cloud Code Assist schema rejection workaround
- kept e87f792460 chore(fork): sync log for v18.1.10
- kept 5e6ff4ff88 chore(fork): sync log for v18.1.11

### 2026-09-05 — v18.1.10 → v18.1.11

- kept 26c4a035f6 feat(ai): enforce Cursor execution policy rejections
- kept aa31618be4 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 8cfb0cc435 chore(dev): preserve fork-local development configuration
- kept e5c807ec27 fix(natives): diagnose and safely promote workspace addons
- kept f7b25177e9 chore(fork): automate parentless syncs with verified npm natives
- kept b35a07c01d docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 00b99a6ef7 chore(fork): promote automatically once sync verification passes
- kept 37ea2e1228 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 9522848a37 fix(sync): clear stale unregistered worktree directories
- kept 64b6b8cf6c fix(coding-agent): decide non-symlink containment by the parent directory
- kept 4fe407d9cd docs(solutions): capture macOS hard-link realpath containment learning
- kept be58cba1fc docs(solutions): record rejection of context-mode plugin for omp
- kept 1328a9d492 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept d43f74db07 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 17e94df0dd refactor(sync): classify fork records by file paths only, drop subject check
- kept 2e1d4e4341 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 4d6db1b531 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 8ae4184fee feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 209673d0f5 chore(fork): consolidate sync log through v18.0.10
- kept bf1fe22ea6 chore(fork): sync log for v18.0.11
- kept 077d4219a5 chore(fork): sync log for v18.1.0
- kept cbd5dbab13 chore(fork): sync log for v18.1.1
- kept ecbb1e10db chore(fork): sync log for v18.1.2
- kept 9228a8ae63 chore(fork): sync log for v18.1.3
- kept cd2eaded3f chore(fork): sync log for v18.1.4
- kept 242c32862a chore(fork): sync log for v18.1.6
- kept 02373cde3b fix(sync): accept native leaves when the core meta publish lags
- kept e0c50a785a chore(fork): sync log for v18.1.8
- kept 417dd7c5a1 docs(ai): document Cloud Code Assist schema rejection workaround
- kept 9fac35a765 chore(fork): sync log for v18.1.10

### 2026-09-04 — v18.1.8 → v18.1.10

- kept 8618c74a25 feat(ai): enforce Cursor execution policy rejections
- kept 3ba089b0b2 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept c09b0925a1 chore(dev): preserve fork-local development configuration
- kept 21c6a72648 fix(natives): diagnose and safely promote workspace addons
- kept ef0ab331d7 chore(fork): automate parentless syncs with verified npm natives
- kept 9742319260 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 27d45b9f66 chore(fork): promote automatically once sync verification passes
- kept 1b5f876c05 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 6ce7140638 fix(sync): clear stale unregistered worktree directories
- kept 4dd10c113b fix(coding-agent): decide non-symlink containment by the parent directory
- kept 791d6435ab docs(solutions): capture macOS hard-link realpath containment learning
- kept 5badebc84f docs(solutions): record rejection of context-mode plugin for omp
- kept d69b1df36a fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 8289a1cce8 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 0babb34dec refactor(sync): classify fork records by file paths only, drop subject check
- kept 5f2a339ca2 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept e2d0db6979 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept d1178fc352 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept a5ad027383 chore(fork): consolidate sync log through v18.0.10
- kept 446a5b3628 chore(fork): sync log for v18.0.11
- kept 406e7207c2 chore(fork): sync log for v18.1.0
- kept 608d1cbd73 chore(fork): sync log for v18.1.1
- kept a979875481 chore(fork): sync log for v18.1.2
- kept 82edcc4c60 chore(fork): sync log for v18.1.3
- kept fb05910157 chore(fork): sync log for v18.1.4
- kept b045ed7d4e chore(fork): sync log for v18.1.6
- kept f9fa4676aa fix(sync): accept native leaves when the core meta publish lags
- kept f33ad7f9d9 chore(fork): sync log for v18.1.8
- kept 2a241df3b0 docs(ai): document Cloud Code Assist schema rejection workaround

### 2026-09-03 — v18.1.6 → v18.1.8

- kept b743f85a44 feat(ai): enforce Cursor execution policy rejections
- kept 046a41dd46 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 220370857c chore(dev): preserve fork-local development configuration
- kept 351dfd6dd9 fix(natives): diagnose and safely promote workspace addons
- kept 407627194b chore(fork): automate parentless syncs with verified npm natives
- kept 75faa6d4f4 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 4409439198 chore(fork): promote automatically once sync verification passes
- kept 0ec3c283a3 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept ad7325948e fix(sync): clear stale unregistered worktree directories
- kept 8ca3d70d9c fix(coding-agent): decide non-symlink containment by the parent directory
- kept d8df933cf1 docs(solutions): capture macOS hard-link realpath containment learning
- kept f18d951d2d docs(solutions): record rejection of context-mode plugin for omp
- kept 4b7bd6e20d fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 20339adcc7 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 057f83b260 refactor(sync): classify fork records by file paths only, drop subject check
- kept e84e67e845 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept edcbd828b4 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 96a895da11 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 33af4c8410 chore(fork): consolidate sync log through v18.0.10
- kept 0133780083 chore(fork): sync log for v18.0.11
- kept ff574cb33b chore(fork): sync log for v18.1.0
- kept 390390dc09 chore(fork): sync log for v18.1.1
- kept 3e839111de chore(fork): sync log for v18.1.2
- kept b972f1f900 chore(fork): sync log for v18.1.3
- kept b39fde0398 chore(fork): sync log for v18.1.4
- kept c14084e801 chore(fork): sync log for v18.1.6
- kept 0d00169f53 fix(sync): accept native leaves when the core meta publish lags

### 2026-09-03 — v18.1.5 → v18.1.6

- kept 042b83dce0 feat(ai): enforce Cursor execution policy rejections
- kept bfe1bb667f fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 11856841b9 chore(dev): preserve fork-local development configuration
- kept 14aead6516 fix(natives): diagnose and safely promote workspace addons
- kept cec3439bf8 chore(fork): automate parentless syncs with verified npm natives
- kept 65424fb8f0 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 91cc0de9ea chore(fork): promote automatically once sync verification passes
- kept ef538e30d0 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 9aff26d9e4 fix(sync): clear stale unregistered worktree directories
- kept 8fc8af8110 fix(coding-agent): decide non-symlink containment by the parent directory
- kept c4cc746569 docs(solutions): capture macOS hard-link realpath containment learning
- kept f389983302 docs(solutions): record rejection of context-mode plugin for omp
- kept 011d0fc826 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 121c5e6a51 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 5f9483423a refactor(sync): classify fork records by file paths only, drop subject check
- kept 7d724a979e feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 82ae2f103c fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 1b0ec8c3eb feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 07b76ccf32 chore(fork): consolidate sync log through v18.0.10
- kept 6d34924421 chore(fork): sync log for v18.0.11
- kept 0651cac071 chore(fork): sync log for v18.1.0
- kept edd30582fa chore(fork): sync log for v18.1.1
- kept bf4779f0f1 chore(fork): sync log for v18.1.2
- kept 2b9942540e chore(fork): sync log for v18.1.3
- kept 311df99531 chore(fork): sync log for v18.1.4

### 2026-09-02 — v18.1.3 → v18.1.4

- kept 1afee10e36 feat(ai): enforce Cursor execution policy rejections
- kept dea2d098cc fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 37c7646597 chore(dev): preserve fork-local development configuration
- kept 6fb1fb9600 fix(natives): diagnose and safely promote workspace addons
- kept 0dd2b02d92 chore(fork): automate parentless syncs with verified npm natives
- kept 5f7cd39c39 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept c764b73dbe chore(fork): promote automatically once sync verification passes
- kept c41db6840b chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 8c6e584fb0 fix(sync): clear stale unregistered worktree directories
- kept 50c3f0c057 fix(coding-agent): decide non-symlink containment by the parent directory
- kept d04a2266e8 docs(solutions): capture macOS hard-link realpath containment learning
- kept 603763c785 docs(solutions): record rejection of context-mode plugin for omp
- kept 938b025264 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 959ed9b896 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 1bbb1f4174 refactor(sync): classify fork records by file paths only, drop subject check
- kept 51e9b443c2 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 86399517ff fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 484547206d feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept f5e332c0d2 chore(fork): consolidate sync log through v18.0.10
- kept 6f449d2606 chore(fork): sync log for v18.0.11
- kept 596f9f3e2c chore(fork): sync log for v18.1.0
- kept de7158ff0e chore(fork): sync log for v18.1.1
- kept 4498c3fc30 chore(fork): sync log for v18.1.2
- kept 32711abf14 chore(fork): sync log for v18.1.3

### 2026-09-02 — v18.1.2 → v18.1.3

- kept 321e317c1d feat(ai): enforce Cursor execution policy rejections
- kept 3e6a6d83d7 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 454e637ffa chore(dev): preserve fork-local development configuration
- kept 49fd791a22 fix(natives): diagnose and safely promote workspace addons
- kept 7474b665fc chore(fork): automate parentless syncs with verified npm natives
- kept 9ac62c8dc3 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 9471c7ca9b chore(fork): promote automatically once sync verification passes
- kept b0e1cec476 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 2c86e742b7 fix(sync): clear stale unregistered worktree directories
- kept 44460c87aa fix(coding-agent): decide non-symlink containment by the parent directory
- kept 5abacdd2dd docs(solutions): capture macOS hard-link realpath containment learning
- kept a70dc65ba7 docs(solutions): record rejection of context-mode plugin for omp
- kept f73463661d fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 21165fd561 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 5d85ca1b0b refactor(sync): classify fork records by file paths only, drop subject check
- kept 98d1c9a4e6 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 1b1dc6ea59 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 1b26f79898 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 7a5b73003a chore(fork): consolidate sync log through v18.0.10
- kept 6ff57b0ccb chore(fork): sync log for v18.0.11
- kept 18ab3b00b0 chore(fork): sync log for v18.1.0
- kept 2f0ee69402 chore(fork): sync log for v18.1.1
- kept 19caf91f62 chore(fork): sync log for v18.1.2

### 2026-09-02 — v18.1.1 → v18.1.2

- kept 5732e24e7b feat(ai): enforce Cursor execution policy rejections
- kept 2f07f83416 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept c21a787050 chore(dev): preserve fork-local development configuration
- kept 779b580e15 fix(natives): diagnose and safely promote workspace addons
- kept 2cced5c93b chore(fork): automate parentless syncs with verified npm natives
- kept 80fc123ff3 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 857ae4a7da chore(fork): promote automatically once sync verification passes
- kept 69f1aaf77e chore(dev): pin the shared mnemopi bank for worktree sessions
- kept e7f351edaf fix(sync): clear stale unregistered worktree directories
- kept 9ce640c1fe fix(coding-agent): decide non-symlink containment by the parent directory
- kept eda15ce7a2 docs(solutions): capture macOS hard-link realpath containment learning
- kept 34e356c545 docs(solutions): record rejection of context-mode plugin for omp
- kept 663f1ea976 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 88bf9659ee fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept f227776730 refactor(sync): classify fork records by file paths only, drop subject check
- kept 2ab5a09687 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 6ab6bb8c35 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept dc9171adf6 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 2cca9dd3a0 chore(fork): consolidate sync log through v18.0.10
- kept 41575765d9 chore(fork): sync log for v18.0.11
- kept 21c484c5d5 chore(fork): sync log for v18.1.0
- kept c288eef41f chore(fork): sync log for v18.1.1

### 2026-09-01 — v18.1.0 → v18.1.1

- kept df91d39932 feat(ai): enforce Cursor execution policy rejections
- kept 7140529174 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept b0c345c85e chore(dev): preserve fork-local development configuration
- kept 397a27d081 fix(natives): diagnose and safely promote workspace addons
- kept d9517e4899 chore(fork): automate parentless syncs with verified npm natives
- kept cd6fe212db docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept dffa08ed76 chore(fork): promote automatically once sync verification passes
- kept 0e9035ddc9 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 7a49fc934f fix(sync): clear stale unregistered worktree directories
- kept 259a90e2be fix(coding-agent): decide non-symlink containment by the parent directory
- kept 742bbbf8aa docs(solutions): capture macOS hard-link realpath containment learning
- kept 1234232393 docs(solutions): record rejection of context-mode plugin for omp
- kept b82bf02bd1 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 091d11b294 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 3f70e338e6 refactor(sync): classify fork records by file paths only, drop subject check
- kept 2b19408480 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 8b258a3c23 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 6f11c98a7a feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept c701a5c180 chore(fork): consolidate sync log through v18.0.10
- kept e40d83ec43 chore(fork): sync log for v18.0.11
- kept 8a85fae905 chore(fork): sync log for v18.1.0

### 2026-09-01 — v18.0.11 → v18.1.0

- kept c7e500fad8 feat(ai): enforce Cursor execution policy rejections
- kept d3ca4444bf fix(ai,coding-agent): normalize gateway model catalog metadata
- kept cb6425286f chore(dev): preserve fork-local development configuration
- kept 85207acb2c fix(natives): diagnose and safely promote workspace addons
- kept ed7a83473d chore(fork): automate parentless syncs with verified npm natives
- kept 2e83f3db6d docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 76733cc0d8 chore(fork): promote automatically once sync verification passes
- kept ba9b05cd65 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept b92f663e20 fix(sync): clear stale unregistered worktree directories
- kept f947849370 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 63f1740556 docs(solutions): capture macOS hard-link realpath containment learning
- kept a3960cd360 docs(solutions): record rejection of context-mode plugin for omp
- kept 6f983dbd34 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 696e786421 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 85bedd39ab refactor(sync): classify fork records by file paths only, drop subject check
- kept 110bbe74ab feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 7d78867f53 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 33a1732e01 feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept f62755ce09 chore(fork): consolidate sync log through v18.0.10
- kept 67a2acfabc chore(fork): sync log for v18.0.11

### 2026-08-29 — v18.0.10 → v18.0.11

- kept 4ccf5253c4 feat(ai): enforce Cursor execution policy rejections
- kept f4a14bbf1a fix(ai,coding-agent): normalize gateway model catalog metadata
- kept f09a597390 chore(dev): preserve fork-local development configuration
- kept d7ce31c1e6 fix(natives): diagnose and safely promote workspace addons
- kept 29f4cb41bf chore(fork): automate parentless syncs with verified npm natives
- kept c816c83c94 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 6c45361dc7 chore(fork): promote automatically once sync verification passes
- kept e6865f9624 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept c2841efb66 fix(sync): clear stale unregistered worktree directories
- kept 6c0bce240e fix(coding-agent): decide non-symlink containment by the parent directory
- kept e830aba3e1 docs(solutions): capture macOS hard-link realpath containment learning
- kept a73306a76d docs(solutions): record rejection of context-mode plugin for omp
- kept c5298326d5 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 034cebf3da fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 470abff79d refactor(sync): classify fork records by file paths only, drop subject check
- kept d1b57af916 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept ddaca1296c fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 14946bac7c feat(sync): require pinned repo-local git identity and add sync-log squash script
- kept 6cf78a53eb chore(fork): consolidate sync log through v18.0.10

### 2026-08-28 — v18.0.8 → v18.0.10

- kept 9654275572 feat(ai): enforce Cursor execution policy rejections
- kept 2c11bd65fa fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 39f42c854d chore(dev): preserve fork-local development configuration
- kept e28d4da72f fix(natives): diagnose and safely promote workspace addons
- kept f8780e0d2f chore(fork): automate parentless syncs with verified npm natives
- kept c0b22f8157 chore(fork): sync log for v17.2.5
- kept 76869d2846 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept aead6b50fc chore(fork): sync log for v17.2.7
- kept 2d4866834f chore(fork): sync log for v17.2.8
- kept 259d307950 chore(fork): promote automatically once sync verification passes
- kept f8b8f8453d chore(fork): sync log for v17.2.9
- kept 93cf18ca61 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 4c9c57d5f1 chore(fork): sync log for v17.2.10
- kept 615e09ef25 fix(sync): clear stale unregistered worktree directories
- kept f42732d1ff chore(fork): sync log for v17.2.11
- kept 3d2fbd47e5 chore(fork): sync log for v17.2.12
- kept 9ae28c92b1 chore(fork): sync log for v17.2.13
- kept 8a6e6c419a chore(fork): sync log for v17.2.14
- kept 710a054984 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 54329c2fdf chore(fork): sync log for v17.2.15
- kept f73915e068 docs(solutions): capture macOS hard-link realpath containment learning
- kept cebd4e3a3f docs(solutions): record rejection of context-mode plugin for omp
- kept 1ad37e82b5 chore(fork): sync log for v17.3.0
- kept 1195eb87a7 chore(fork): sync log for v17.3.1
- kept 2b58baa042 chore(fork): sync log for v17.3.2
- kept aab6bdddfc chore(fork): sync log for v17.3.3
- kept 7ebd61d7c9 chore(fork): sync log for v17.3.4
- kept 1625436376 chore(fork): sync log for v17.3.5
- kept 6572963e7d chore(fork): sync log for v17.3.7
- kept 95ef5ff750 chore(fork): sync log for v17.3.8
- kept 50c43d52ff fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 5be9b4b44e fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 723651ed00 chore(fork): sync log for v17.4.0
- kept 4f9c263e95 chore(fork): sync log for v17.4.1
- kept 4bd92e3cad refactor(sync): classify fork records by file paths only, drop subject check
- kept eade065d04 chore(fork): sync log for v17.4.2
- kept e4f10f44fd feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept ccc9b217aa chore(fork): sync log for v18.0.0
- kept 7e6607958c chore(fork): sync log for v18.0.3
- kept 11134949c7 chore(fork): sync log for v18.0.4
- kept 16e4c06e4c chore(fork): sync log for v18.0.5
- kept 6e38171aa3 chore(fork): sync log for v18.0.6
- kept 831ff58734 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 2f1dd99c6f chore(fork): sync log for v18.0.7
- kept e34762e39d chore(fork): sync log for v18.0.8

### 2026-08-27 — v18.0.7 → v18.0.8

- kept e4be82d1ab feat(ai): enforce Cursor execution policy rejections
- kept d96ff86aca fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 2acaae8439 chore(dev): preserve fork-local development configuration
- kept 0ff12bdd6a fix(natives): diagnose and safely promote workspace addons
- kept 112df4f769 chore(fork): automate parentless syncs with verified npm natives
- kept 416e845842 chore(fork): sync log for v17.2.5
- kept 26e266f478 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 41a8389ce3 chore(fork): sync log for v17.2.7
- kept c91608954b chore(fork): sync log for v17.2.8
- kept e339312349 chore(fork): promote automatically once sync verification passes
- kept 47a97cd171 chore(fork): sync log for v17.2.9
- kept 96ddf68c09 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 9a1866bffe chore(fork): sync log for v17.2.10
- kept 557b31395a fix(sync): clear stale unregistered worktree directories
- kept 6fa6fd61b7 chore(fork): sync log for v17.2.11
- kept e31fbae03e chore(fork): sync log for v17.2.12
- kept 0e19ad9664 chore(fork): sync log for v17.2.13
- kept 9004a0ae59 chore(fork): sync log for v17.2.14
- kept f7c54f2d4a fix(coding-agent): decide non-symlink containment by the parent directory
- kept adef2ef706 chore(fork): sync log for v17.2.15
- kept b28dccd41a docs(solutions): capture macOS hard-link realpath containment learning
- kept 160dbdf6cf docs(solutions): record rejection of context-mode plugin for omp
- kept fd8005ba28 chore(fork): sync log for v17.3.0
- kept 84cc6c1fde chore(fork): sync log for v17.3.1
- kept 11de147c59 chore(fork): sync log for v17.3.2
- kept 40c95ba9ea chore(fork): sync log for v17.3.3
- kept 95bb56c7c4 chore(fork): sync log for v17.3.4
- kept ffe57723a1 chore(fork): sync log for v17.3.5
- kept 88e1db1fe5 chore(fork): sync log for v17.3.7
- kept addc81c8d9 chore(fork): sync log for v17.3.8
- kept b66c65713a fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept d92e6217d8 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 20f4baef70 chore(fork): sync log for v17.4.0
- kept 442ce96059 chore(fork): sync log for v17.4.1
- kept 6084be60fe refactor(sync): classify fork records by file paths only, drop subject check
- kept 97a17d97a0 chore(fork): sync log for v17.4.2
- kept 6503430872 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept d6692e0574 chore(fork): sync log for v18.0.0
- kept a609f17805 chore(fork): sync log for v18.0.3
- kept 6973bc6a7c chore(fork): sync log for v18.0.4
- kept 9d3ed5e996 chore(fork): sync log for v18.0.5
- kept a76f7cb371 chore(fork): sync log for v18.0.6
- kept 7f9558fe55 fix(ai): strip uniqueItems from Google/Antigravity tool schemas
- kept 2dea07fb6c chore(fork): sync log for v18.0.7

### 2026-08-27 — v18.0.6 → v18.0.7

- kept 0659ebad41 feat(ai): enforce Cursor execution policy rejections
- kept c2dffabe22 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 71f4e988dc chore(dev): preserve fork-local development configuration
- kept 6979188671 fix(natives): diagnose and safely promote workspace addons
- kept 7e7dc5e4c5 chore(fork): automate parentless syncs with verified npm natives
- kept 164633c69f chore(fork): sync log for v17.2.5
- kept 11f326294b docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 0067b202c6 chore(fork): sync log for v17.2.7
- kept 00d4d40a1c chore(fork): sync log for v17.2.8
- kept b44e69c1f1 chore(fork): promote automatically once sync verification passes
- kept 4cdef8834e chore(fork): sync log for v17.2.9
- kept 14db6992c1 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 625ba034eb chore(fork): sync log for v17.2.10
- kept 2238c50781 fix(sync): clear stale unregistered worktree directories
- kept 7ae83dba60 chore(fork): sync log for v17.2.11
- kept c1f8e3fc2d chore(fork): sync log for v17.2.12
- kept 822b1d9b19 chore(fork): sync log for v17.2.13
- kept 0d9d676e9a chore(fork): sync log for v17.2.14
- kept 6aff194ea4 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 4b5c518c54 chore(fork): sync log for v17.2.15
- kept 1ec05cf527 docs(solutions): capture macOS hard-link realpath containment learning
- kept 1ba0d81422 docs(solutions): record rejection of context-mode plugin for omp
- kept 173107990a chore(fork): sync log for v17.3.0
- kept baf8e3afd0 chore(fork): sync log for v17.3.1
- kept 518098df5a chore(fork): sync log for v17.3.2
- kept 383affea14 chore(fork): sync log for v17.3.3
- kept f12b9c7471 chore(fork): sync log for v17.3.4
- kept 7774c8ce32 chore(fork): sync log for v17.3.5
- kept 83fc306162 chore(fork): sync log for v17.3.7
- kept fd649369c1 chore(fork): sync log for v17.3.8
- kept bfb9526da0 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept fdcb0f4e07 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 5160cca991 chore(fork): sync log for v17.4.0
- kept 0f529060c2 chore(fork): sync log for v17.4.1
- kept ad1aed3174 refactor(sync): classify fork records by file paths only, drop subject check
- kept 1c863b4522 chore(fork): sync log for v17.4.2
- kept bc0e151aa1 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 808edddf5d chore(fork): sync log for v18.0.0
- kept 5cd8bbb5ba chore(fork): sync log for v18.0.3
- kept 144e46e78d chore(fork): sync log for v18.0.4
- kept 68a078b687 chore(fork): sync log for v18.0.5
- kept d781df0ba6 chore(fork): sync log for v18.0.6
- kept 1883c786bc fix(ai): strip uniqueItems from Google/Antigravity tool schemas

### 2026-08-26 — v18.0.5 → v18.0.6

- kept f8f72319c1 feat(ai): enforce Cursor execution policy rejections
- kept 8536d5eeef fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 7ceb3c6147 chore(dev): preserve fork-local development configuration
- kept 959527e05b fix(natives): diagnose and safely promote workspace addons
- kept ebd8053a61 chore(fork): automate parentless syncs with verified npm natives
- kept 41e8732c5e chore(fork): sync log for v17.2.5
- kept 78e3717a7f docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 0a54936c92 chore(fork): sync log for v17.2.7
- kept 273d03240e chore(fork): sync log for v17.2.8
- kept b63956ea4f chore(fork): promote automatically once sync verification passes
- kept 10130cd6d7 chore(fork): sync log for v17.2.9
- kept d8b32fc848 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 99ade96ec9 chore(fork): sync log for v17.2.10
- kept b50dec327e fix(sync): clear stale unregistered worktree directories
- kept 5106bfc09c chore(fork): sync log for v17.2.11
- kept 9a1466bb3b chore(fork): sync log for v17.2.12
- kept 8bb9d36c64 chore(fork): sync log for v17.2.13
- kept cddccf308e chore(fork): sync log for v17.2.14
- kept dd97ab9bfa fix(coding-agent): decide non-symlink containment by the parent directory
- kept 24d02b9b04 chore(fork): sync log for v17.2.15
- kept 9d8621d95d docs(solutions): capture macOS hard-link realpath containment learning
- kept 71539c9e75 docs(solutions): record rejection of context-mode plugin for omp
- kept dc5976ede6 chore(fork): sync log for v17.3.0
- kept a7de8cd331 chore(fork): sync log for v17.3.1
- kept 437b9bba6e chore(fork): sync log for v17.3.2
- kept f9789a5bd2 chore(fork): sync log for v17.3.3
- kept 2777f28667 chore(fork): sync log for v17.3.4
- kept 9f637a919a chore(fork): sync log for v17.3.5
- kept 8bec11bf5a chore(fork): sync log for v17.3.7
- kept 94a3179541 chore(fork): sync log for v17.3.8
- kept fb08217ebe fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept fdf703ef44 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept d4cd16850d chore(fork): sync log for v17.4.0
- kept 6604ce692b chore(fork): sync log for v17.4.1
- kept 9421260270 refactor(sync): classify fork records by file paths only, drop subject check
- kept 728ed0cde8 chore(fork): sync log for v17.4.2
- kept ad8a31e81f feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 554ac51362 chore(fork): sync log for v18.0.0
- kept a21e17eaae chore(fork): sync log for v18.0.3
- kept c44cfcdec4 chore(fork): sync log for v18.0.4
- kept c5203f762a chore(fork): sync log for v18.0.5

### 2026-08-25 — v18.0.4 → v18.0.5

- kept 6f365b31ca feat(ai): enforce Cursor execution policy rejections
- kept 2d08d58d3c fix(ai,coding-agent): normalize gateway model catalog metadata
- kept b3725aac41 chore(dev): preserve fork-local development configuration
- kept dee7bce78c fix(natives): diagnose and safely promote workspace addons
- kept 187357ac64 chore(fork): automate parentless syncs with verified npm natives
- kept cc1e0bbe63 chore(fork): sync log for v17.2.5
- kept f02bb467b1 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 8491197608 chore(fork): sync log for v17.2.7
- kept 32ced49df2 chore(fork): sync log for v17.2.8
- kept 684974bcf9 chore(fork): promote automatically once sync verification passes
- kept d8a7461900 chore(fork): sync log for v17.2.9
- kept 5310c97fbb chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 1f68c6470c chore(fork): sync log for v17.2.10
- kept be7cfedfcd fix(sync): clear stale unregistered worktree directories
- kept c86880b919 chore(fork): sync log for v17.2.11
- kept 8f58ec2930 chore(fork): sync log for v17.2.12
- kept 91820490d2 chore(fork): sync log for v17.2.13
- kept 3cac8a96cb chore(fork): sync log for v17.2.14
- kept ca9c6206c3 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 02f4bd215b chore(fork): sync log for v17.2.15
- kept 3146657e03 docs(solutions): capture macOS hard-link realpath containment learning
- kept bfd37069fd docs(solutions): record rejection of context-mode plugin for omp
- kept dada5c4d57 chore(fork): sync log for v17.3.0
- kept 8a71e37de8 chore(fork): sync log for v17.3.1
- kept c51abef595 chore(fork): sync log for v17.3.2
- kept 85f0e45a60 chore(fork): sync log for v17.3.3
- kept 2133ee3246 chore(fork): sync log for v17.3.4
- kept 4568b3ec9f chore(fork): sync log for v17.3.5
- kept c7e8f4b64f chore(fork): sync log for v17.3.7
- kept 5572518cec chore(fork): sync log for v17.3.8
- kept 058cf60c91 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 2d4f68fa66 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept b6bae4ee41 chore(fork): sync log for v17.4.0
- kept 3d988d76ee chore(fork): sync log for v17.4.1
- kept d2631490c9 refactor(sync): classify fork records by file paths only, drop subject check
- kept 4b885c5004 chore(fork): sync log for v17.4.2
- kept 9e1263cf38 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 9573db0aef chore(fork): sync log for v18.0.0
- kept 0f8ba73877 chore(fork): sync log for v18.0.3
- kept 55ccc5fa88 chore(fork): sync log for v18.0.4

### 2026-08-24 — v18.0.3 → v18.0.4

- kept 846d8c127d feat(ai): enforce Cursor execution policy rejections
- kept 72f13234ab fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 0c4160de20 chore(dev): preserve fork-local development configuration
- kept 669c6583c3 fix(natives): diagnose and safely promote workspace addons
- kept 4e1aaa07f8 chore(fork): automate parentless syncs with verified npm natives
- kept 221f96eb50 chore(fork): sync log for v17.2.5
- kept ae5edab208 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 31458b0e93 chore(fork): sync log for v17.2.7
- kept 755602b6e5 chore(fork): sync log for v17.2.8
- kept 3b675a4904 chore(fork): promote automatically once sync verification passes
- kept 91314560c0 chore(fork): sync log for v17.2.9
- kept 8666528a8e chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 88017cb16f chore(fork): sync log for v17.2.10
- kept b001b0c2b5 fix(sync): clear stale unregistered worktree directories
- kept fbbc8272b0 chore(fork): sync log for v17.2.11
- kept 0f27bc51b4 chore(fork): sync log for v17.2.12
- kept b9915026ff chore(fork): sync log for v17.2.13
- kept bdd25a4189 chore(fork): sync log for v17.2.14
- kept 6ace01d319 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 4131159e70 chore(fork): sync log for v17.2.15
- kept 60f75e976a docs(solutions): capture macOS hard-link realpath containment learning
- kept c24899da00 docs(solutions): record rejection of context-mode plugin for omp
- kept cb5b32ec66 chore(fork): sync log for v17.3.0
- kept 1fa1af0cfa chore(fork): sync log for v17.3.1
- kept 4387d924c3 chore(fork): sync log for v17.3.2
- kept cef1fc75f4 chore(fork): sync log for v17.3.3
- kept d42a3a4203 chore(fork): sync log for v17.3.4
- kept dd13b34985 chore(fork): sync log for v17.3.5
- kept 837a2f6d3a chore(fork): sync log for v17.3.7
- kept f3dd3bbd14 chore(fork): sync log for v17.3.8
- kept bb37799190 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 156cd89274 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 76f2834a32 chore(fork): sync log for v17.4.0
- kept eaa4a20c22 chore(fork): sync log for v17.4.1
- kept 54650d53cf refactor(sync): classify fork records by file paths only, drop subject check
- kept 6b9442a4af chore(fork): sync log for v17.4.2
- kept 27a037e721 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept a898ff6b0c chore(fork): sync log for v18.0.0
- kept 86b1c0b815 chore(fork): sync log for v18.0.3

### 2026-08-23 — v18.0.0 → v18.0.3

- kept df5f6001fc feat(ai): enforce Cursor execution policy rejections
- kept 07fb62a850 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 87282ac07b chore(dev): preserve fork-local development configuration
- kept 876f55f790 fix(natives): diagnose and safely promote workspace addons
- kept 6c515a7e9a chore(fork): automate parentless syncs with verified npm natives
- kept c368884f17 chore(fork): sync log for v17.2.5
- kept 159375a545 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 0cebeaf858 chore(fork): sync log for v17.2.7
- kept 6fd31f08ea chore(fork): sync log for v17.2.8
- kept 2ff6d526a7 chore(fork): promote automatically once sync verification passes
- kept b6d5cf7cfc chore(fork): sync log for v17.2.9
- kept 79e4d8e854 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept e253ad37cd chore(fork): sync log for v17.2.10
- kept c4ebc8d232 fix(sync): clear stale unregistered worktree directories
- kept ebc67a6f35 chore(fork): sync log for v17.2.11
- kept 60b1aa5883 chore(fork): sync log for v17.2.12
- kept bfefe642e6 chore(fork): sync log for v17.2.13
- kept c87b7751e7 chore(fork): sync log for v17.2.14
- kept 2a52f56a38 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 63bcacf8e9 chore(fork): sync log for v17.2.15
- kept b3a8c4661f docs(solutions): capture macOS hard-link realpath containment learning
- kept 554e6af83d docs(solutions): record rejection of context-mode plugin for omp
- kept 0b06946a3c chore(fork): sync log for v17.3.0
- kept 0d886d0262 chore(fork): sync log for v17.3.1
- kept ed6ba55c49 chore(fork): sync log for v17.3.2
- kept 889f1d044f chore(fork): sync log for v17.3.3
- kept afcf4dc7e9 chore(fork): sync log for v17.3.4
- kept 2dceae1489 chore(fork): sync log for v17.3.5
- kept b6c1ab681c chore(fork): sync log for v17.3.7
- kept 313428d1fc chore(fork): sync log for v17.3.8
- kept e9f37ce349 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 7ea8cf9d6b fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept c269775d83 chore(fork): sync log for v17.4.0
- kept 60478a7d25 chore(fork): sync log for v17.4.1
- kept 37efbf895b refactor(sync): classify fork records by file paths only, drop subject check
- kept 5aa8091010 chore(fork): sync log for v17.4.2
- kept cb427bc5d2 feat(sync): record manual-review acceptances in a durable patch-id ledger
- kept 68f73a9f2c chore(fork): sync log for v18.0.0

### 2026-08-22 — v17.4.2 → v18.0.0

- kept 8e8256e3b3 feat(ai): enforce Cursor execution policy rejections
- kept 61b845ea01 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 776613bdf8 chore(dev): preserve fork-local development configuration
- kept d252b1ff45 fix(natives): diagnose and safely promote workspace addons
- kept f92927ad4d chore(fork): automate parentless syncs with verified npm natives
- kept 1c4bc67323 chore(fork): sync log for v17.2.5
- kept 38484cbd52 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 5ecc431b59 chore(fork): sync log for v17.2.7
- kept 94209d9fb2 chore(fork): sync log for v17.2.8
- kept c3e1dbc5a0 chore(fork): promote automatically once sync verification passes
- kept 4adf7c9607 chore(fork): sync log for v17.2.9
- kept 40270ce76a chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 42ef79e0b1 chore(fork): sync log for v17.2.10
- kept a2cda1fa02 fix(sync): clear stale unregistered worktree directories
- kept 75dd8cccd5 chore(fork): sync log for v17.2.11
- kept 88879a3f8b chore(fork): sync log for v17.2.12
- kept 2f03576233 chore(fork): sync log for v17.2.13
- kept a0e30d41b4 chore(fork): sync log for v17.2.14
- kept d573457f1c fix(coding-agent): decide non-symlink containment by the parent directory
- kept 2f1073c6e0 chore(fork): sync log for v17.2.15
- kept dadb4d3ffd docs(solutions): capture macOS hard-link realpath containment learning
- kept bc3edd22e4 docs(solutions): record rejection of context-mode plugin for omp
- kept 581fd18774 chore(fork): sync log for v17.3.0
- kept 12731a7cf0 chore(fork): sync log for v17.3.1
- kept 3b4d56e150 chore(fork): sync log for v17.3.2
- kept b44baa35c3 chore(fork): sync log for v17.3.3
- kept ef6b58821c chore(fork): sync log for v17.3.4
- kept 85d7fbef63 chore(fork): sync log for v17.3.5
- kept f17ce4a105 chore(fork): sync log for v17.3.7
- kept f5e887cf50 chore(fork): sync log for v17.3.8
- kept cac6900c42 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 5871df0964 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 8046238e38 chore(fork): sync log for v17.4.0
- kept a387d0890a chore(fork): sync log for v17.4.1
- kept cc9db382dd refactor(sync): classify fork records by file paths only, drop subject check
- kept f6b59042b1 chore(fork): sync log for v17.4.2
- kept 1be47539c9 feat(sync): record manual-review acceptances in a durable patch-id ledger

### 2026-08-21 — v17.4.1 → v17.4.2

- kept 2353e3f6bf feat(ai): enforce Cursor execution policy rejections
- kept 467684a513 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 06b2839a13 chore(dev): preserve fork-local development configuration
- kept 2974be1fc2 fix(natives): diagnose and safely promote workspace addons
- kept 62ae28680c chore(fork): automate parentless syncs with verified npm natives
- kept d118010378 chore(fork): sync log for v17.2.5
- kept b925de0f63 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept a8b0bb6f35 chore(fork): sync log for v17.2.7
- kept 9339017cfb chore(fork): sync log for v17.2.8
- kept b89875de12 chore(fork): promote automatically once sync verification passes
- kept 4a8999d499 chore(fork): sync log for v17.2.9
- kept 5bc8867bfc chore(dev): pin the shared mnemopi bank for worktree sessions
- kept f2fa1fce5a chore(fork): sync log for v17.2.10
- kept 8e77b7f45b fix(sync): clear stale unregistered worktree directories
- kept 0d9035ae88 chore(fork): sync log for v17.2.11
- kept 18841a9871 chore(fork): sync log for v17.2.12
- kept 8b4afb7b30 chore(fork): sync log for v17.2.13
- kept b911459e9b chore(fork): sync log for v17.2.14
- kept 4ae9fb6cdc fix(coding-agent): decide non-symlink containment by the parent directory
- kept 4d2d987744 chore(fork): sync log for v17.2.15
- kept 23620178de docs(solutions): capture macOS hard-link realpath containment learning
- kept 5ab6638173 docs(solutions): record rejection of context-mode plugin for omp
- kept 53bf934d5e chore(fork): sync log for v17.3.0
- kept 34df59597b chore(fork): sync log for v17.3.1
- kept 1224b5b0e0 chore(fork): sync log for v17.3.2
- kept fd5c0574c6 chore(fork): sync log for v17.3.3
- kept bc25b12396 chore(fork): sync log for v17.3.4
- kept c15006e633 chore(fork): sync log for v17.3.5
- kept bca62cc930 chore(fork): sync log for v17.3.7
- kept d43fde2122 chore(fork): sync log for v17.3.8
- kept 58327fe1a3 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept eac082cb71 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept fb113f34df chore(fork): sync log for v17.4.0
- kept b3506d46d9 chore(fork): sync log for v17.4.1
- kept ba38134bfa refactor(sync): classify fork records by file paths only, drop subject check
- note: eac082cb71 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag (no owned tests — manual review)

### 2026-08-21 — v17.4.0 → v17.4.1

- kept 27c70672c5 feat(ai): enforce Cursor execution policy rejections
- kept cbc66274c4 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept e35830a2d9 chore(dev): preserve fork-local development configuration
- kept 2971060211 fix(natives): diagnose and safely promote workspace addons
- kept de932fba19 chore(fork): automate parentless syncs with verified npm natives
- kept 508081a58a chore(fork): sync log for v17.2.5
- kept f82084f913 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 97d0cb134b chore(fork): sync log for v17.2.7
- kept ba2d016a9b chore(fork): sync log for v17.2.8
- kept 85b371f435 chore(fork): promote automatically once sync verification passes
- kept 1b25a7c9bb chore(fork): sync log for v17.2.9
- kept 40e7298347 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept b114fc5cd6 chore(fork): sync log for v17.2.10
- kept 7fca17b0ab fix(sync): clear stale unregistered worktree directories
- kept 7241acfeba chore(fork): sync log for v17.2.11
- kept 21b756be8a chore(fork): sync log for v17.2.12
- kept 14d5aa4495 chore(fork): sync log for v17.2.13
- kept 091edb540a chore(fork): sync log for v17.2.14
- kept 60264f9310 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 472729ae75 chore(fork): sync log for v17.2.15
- kept 71672ca473 docs(solutions): capture macOS hard-link realpath containment learning
- kept d3c5995d24 docs(solutions): record rejection of context-mode plugin for omp
- kept 9df0f0d2c4 chore(fork): sync log for v17.3.0
- kept de62affac2 chore(fork): sync log for v17.3.1
- kept 4bee9e45e5 chore(fork): sync log for v17.3.2
- kept 26c516845f chore(fork): sync log for v17.3.3
- kept 97bb8de7aa chore(fork): sync log for v17.3.4
- kept 22870d8822 chore(fork): sync log for v17.3.5
- kept 9cd8b6f061 chore(fork): sync log for v17.3.7
- kept 4c99a96e84 chore(fork): sync log for v17.3.8
- kept 75930d9402 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 568503d2e2 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag
- kept 858e0d4784 chore(fork): sync log for v17.4.0

### 2026-08-20 — v17.3.8 → v17.4.0

- kept 93ab0042b7 feat(ai): enforce Cursor execution policy rejections
- kept 0b4a91f8be fix(ai,coding-agent): normalize gateway model catalog metadata
- kept a9f2112e35 chore(dev): preserve fork-local development configuration
- kept aa92c9842a fix(natives): diagnose and safely promote workspace addons
- kept a3b431b685 chore(fork): automate parentless syncs with verified npm natives
- kept 5599221f73 chore(fork): sync log for v17.2.5
- kept adc913be1f docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 8e609bcdce chore(fork): sync log for v17.2.7
- kept 3738d095a0 chore(fork): sync log for v17.2.8
- kept e74852484a chore(fork): promote automatically once sync verification passes
- kept ed5f554093 chore(fork): sync log for v17.2.9
- kept f9059aae44 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept e07f07a7b5 chore(fork): sync log for v17.2.10
- kept 2bcf74a630 fix(sync): clear stale unregistered worktree directories
- kept c3bde09874 chore(fork): sync log for v17.2.11
- kept 9ccfc7cb18 chore(fork): sync log for v17.2.12
- kept 76916237c1 chore(fork): sync log for v17.2.13
- kept 3b85f596ca chore(fork): sync log for v17.2.14
- kept 785f9a4d17 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 659c739d26 chore(fork): sync log for v17.2.15
- kept 7932c8216e docs(solutions): capture macOS hard-link realpath containment learning
- kept 8704f94345 docs(solutions): record rejection of context-mode plugin for omp
- kept 6a95df8480 chore(fork): sync log for v17.3.0
- kept 6aa1ca3092 chore(fork): sync log for v17.3.1
- kept 43e9112f73 chore(fork): sync log for v17.3.2
- kept e1e29f6a7e chore(fork): sync log for v17.3.3
- kept 35d74a00e3 chore(fork): sync log for v17.3.4
- kept 193e5f5961 chore(fork): sync log for v17.3.5
- kept f48bc612ca chore(fork): sync log for v17.3.7
- kept 4470dcd605 chore(fork): sync log for v17.3.8
- kept 097958a196 fix(ai): always emit context_length/max_tokens (null fallback) on gateway /v1/models
- kept 1edec27723 fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag

### 2026-08-19 — v17.3.7 → v17.3.8

- kept 71fc9b05da feat(ai): enforce Cursor execution policy rejections
- kept d174efbbe3 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept a3fa3a4f17 chore(dev): preserve fork-local development configuration
- kept af12267e57 fix(natives): diagnose and safely promote workspace addons
- kept 80d6141f4e chore(fork): automate parentless syncs with verified npm natives
- kept 87ac53fc17 chore(fork): sync log for v17.2.5
- kept 89f8784ce2 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 39f581c808 chore(fork): sync log for v17.2.7
- kept a04fa3f994 chore(fork): sync log for v17.2.8
- kept 22e338f9f7 chore(fork): promote automatically once sync verification passes
- kept 3f0ec95953 chore(fork): sync log for v17.2.9
- kept 6e3b9037cd chore(dev): pin the shared mnemopi bank for worktree sessions
- kept a7ec147aeb chore(fork): sync log for v17.2.10
- kept 12705f904e fix(sync): clear stale unregistered worktree directories
- kept f984c364b3 chore(fork): sync log for v17.2.11
- kept 8b9952890a chore(fork): sync log for v17.2.12
- kept 37681d1d84 chore(fork): sync log for v17.2.13
- kept 4dafc25396 chore(fork): sync log for v17.2.14
- kept 71b131d6b7 fix(coding-agent): decide non-symlink containment by the parent directory
- kept d9b550e866 chore(fork): sync log for v17.2.15
- kept cc1aef742e docs(solutions): capture macOS hard-link realpath containment learning
- kept 09fb417dee docs(solutions): record rejection of context-mode plugin for omp
- kept f609992700 chore(fork): sync log for v17.3.0
- kept 14addfb159 chore(fork): sync log for v17.3.1
- kept 6a296e7aaf chore(fork): sync log for v17.3.2
- kept a5e79bd47f chore(fork): sync log for v17.3.3
- kept ad05e5cef4 chore(fork): sync log for v17.3.4
- kept 51428f1d9d chore(fork): sync log for v17.3.5
- kept fd19848f1a chore(fork): sync log for v17.3.7
- note: cc1aef742e docs(solutions): capture macOS hard-link realpath containment learning (no owned tests — manual review)
- note: 09fb417dee docs(solutions): record rejection of context-mode plugin for omp (no owned tests — manual review)

### 2026-08-18 — v17.3.5 → v17.3.7

- kept 600d1a2fc5 feat(ai): enforce Cursor execution policy rejections
- kept bbccf74750 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 26dedf29da chore(dev): preserve fork-local development configuration
- kept 5556ad1fcb fix(natives): diagnose and safely promote workspace addons
- kept eb0f8e975a chore(fork): automate parentless syncs with verified npm natives
- kept 1bfd1aadf9 chore(fork): sync log for v17.2.5
- kept f274e2c9d8 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 7ac9569d07 chore(fork): sync log for v17.2.7
- kept 83ed573ef5 chore(fork): sync log for v17.2.8
- kept 562ddb253e chore(fork): promote automatically once sync verification passes
- kept b6a49a2cc1 chore(fork): sync log for v17.2.9
- kept c05a5ecbfc chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 1d54b8cff6 chore(fork): sync log for v17.2.10
- kept df3cac0dc1 fix(sync): clear stale unregistered worktree directories
- kept 1614e58fcc chore(fork): sync log for v17.2.11
- kept 8c639a7704 chore(fork): sync log for v17.2.12
- kept 504198be6c chore(fork): sync log for v17.2.13
- kept 49a26f131f chore(fork): sync log for v17.2.14
- kept 4128de205d fix(coding-agent): decide non-symlink containment by the parent directory
- kept 58139d163f chore(fork): sync log for v17.2.15
- kept 550e120120 docs(solutions): capture macOS hard-link realpath containment learning
- kept bd59b56b91 docs(solutions): record rejection of context-mode plugin for omp
- kept 55a44dcf17 chore(fork): sync log for v17.3.0
- kept 1e0a88867c chore(fork): sync log for v17.3.1
- kept 2f06cb595d chore(fork): sync log for v17.3.2
- kept b522ebf1bc chore(fork): sync log for v17.3.3
- kept 49b771f429 chore(fork): sync log for v17.3.4
- kept 02aae10be2 chore(fork): sync log for v17.3.5
- note: 550e120120 docs(solutions): capture macOS hard-link realpath containment learning (no owned tests — manual review)
- note: bd59b56b91 docs(solutions): record rejection of context-mode plugin for omp (no owned tests — manual review)

### 2026-08-16 — v17.3.4 → v17.3.5

- kept 04ebe14645 feat(ai): enforce Cursor execution policy rejections
- kept f14765d63f fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 3744f9dfac chore(dev): preserve fork-local development configuration
- kept 3cf8f3c636 fix(natives): diagnose and safely promote workspace addons
- kept b126e5d42f chore(fork): automate parentless syncs with verified npm natives
- kept 9b2a7cc4b0 chore(fork): sync log for v17.2.5
- kept aa8d61b4c4 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept cc3c9699b5 chore(fork): sync log for v17.2.7
- kept 82e9a4c0be chore(fork): sync log for v17.2.8
- kept e02422184c chore(fork): promote automatically once sync verification passes
- kept de82a0012c chore(fork): sync log for v17.2.9
- kept 9ac3191a3f chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 86bf49df4d chore(fork): sync log for v17.2.10
- kept 90b31f3a81 fix(sync): clear stale unregistered worktree directories
- kept d66d6c6577 chore(fork): sync log for v17.2.11
- kept 9845dc24d4 chore(fork): sync log for v17.2.12
- kept 98fcf6782d chore(fork): sync log for v17.2.13
- kept 1a2b394312 chore(fork): sync log for v17.2.14
- kept 256df3589f fix(coding-agent): decide non-symlink containment by the parent directory
- kept 103535705c chore(fork): sync log for v17.2.15
- kept d647fb8c5e docs(solutions): capture macOS hard-link realpath containment learning
- kept e207e02aa1 docs(solutions): record rejection of context-mode plugin for omp
- kept 3fa89cf0e8 chore(fork): sync log for v17.3.0
- kept 46f1d163be chore(fork): sync log for v17.3.1
- kept a88ffc357e chore(fork): sync log for v17.3.2
- kept 90c5904dbb chore(fork): sync log for v17.3.3
- kept ac76104244 chore(fork): sync log for v17.3.4
- note: d647fb8c5e docs(solutions): capture macOS hard-link realpath containment learning (no owned tests — manual review)
- note: e207e02aa1 docs(solutions): record rejection of context-mode plugin for omp (no owned tests — manual review)

### 2026-08-14 — v17.3.3 → v17.3.4

- kept 38a30a2b01 feat(ai): enforce Cursor execution policy rejections
- kept bf3b015c88 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept fd56572ef6 chore(dev): preserve fork-local development configuration
- kept f822b60c29 fix(natives): diagnose and safely promote workspace addons
- kept 6a8e49fa26 chore(fork): automate parentless syncs with verified npm natives
- kept 2c85ba373a chore(fork): sync log for v17.2.5
- kept d85156c3c6 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept a291977750 chore(fork): sync log for v17.2.7
- kept 1a7d592273 chore(fork): sync log for v17.2.8
- kept 47a89dbb3d chore(fork): promote automatically once sync verification passes
- kept f23585ca3b chore(fork): sync log for v17.2.9
- kept 1741dcf3eb chore(dev): pin the shared mnemopi bank for worktree sessions
- kept b92d680cec chore(fork): sync log for v17.2.10
- kept 51dfad44e6 fix(sync): clear stale unregistered worktree directories
- kept e7c8c9ce9e chore(fork): sync log for v17.2.11
- kept d16da57143 chore(fork): sync log for v17.2.12
- kept 5d50584309 chore(fork): sync log for v17.2.13
- kept fb5a3b073d chore(fork): sync log for v17.2.14
- kept 886572c5bd fix(coding-agent): decide non-symlink containment by the parent directory
- kept eae8fa49c3 chore(fork): sync log for v17.2.15
- kept 43d405d551 docs(solutions): capture macOS hard-link realpath containment learning
- kept c5387c0e1b docs(solutions): record rejection of context-mode plugin for omp
- kept 773c5c25ff chore(fork): sync log for v17.3.0
- kept 9bceedde95 chore(fork): sync log for v17.3.1
- kept 17a01efb5d chore(fork): sync log for v17.3.2
- kept e9c41d2323 chore(fork): sync log for v17.3.3
- note: 43d405d551 docs(solutions): capture macOS hard-link realpath containment learning (no owned tests — manual review)
- note: c5387c0e1b docs(solutions): record rejection of context-mode plugin for omp (no owned tests — manual review)

### 2026-08-14 — v17.3.2 → v17.3.3

- kept 81c06638b5 feat(ai): enforce Cursor execution policy rejections
- kept 0ff7d4825a fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 29f658beaa chore(dev): preserve fork-local development configuration
- kept 063ff0c395 fix(natives): diagnose and safely promote workspace addons
- kept c22159171b chore(fork): automate parentless syncs with verified npm natives
- kept fada5c5627 chore(fork): sync log for v17.2.5
- kept 3e0e5f14c8 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 2f9a126c0a chore(fork): sync log for v17.2.7
- kept 8a08936e24 chore(fork): sync log for v17.2.8
- kept 248083dabb chore(fork): promote automatically once sync verification passes
- kept 41cbb40e15 chore(fork): sync log for v17.2.9
- kept 3289223caf chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 043e9b4cba chore(fork): sync log for v17.2.10
- kept 2204f79cd9 fix(sync): clear stale unregistered worktree directories
- kept a60f3f6b73 chore(fork): sync log for v17.2.11
- kept 0074298cb6 chore(fork): sync log for v17.2.12
- kept 0e2e46a277 chore(fork): sync log for v17.2.13
- kept 0cb91557bf chore(fork): sync log for v17.2.14
- kept 9360c7ed3a fix(coding-agent): decide non-symlink containment by the parent directory
- kept bbf516720b chore(fork): sync log for v17.2.15
- kept d07b148db4 docs(solutions): capture macOS hard-link realpath containment learning
- kept e4ea00827e docs(solutions): record rejection of context-mode plugin for omp
- kept 89dbf53c8e chore(fork): sync log for v17.3.0
- kept 43acef283c chore(fork): sync log for v17.3.1
- kept efa80d60dc chore(fork): sync log for v17.3.2
- note: d07b148db4 docs(solutions): capture macOS hard-link realpath containment learning (no owned tests — manual review)
- note: e4ea00827e docs(solutions): record rejection of context-mode plugin for omp (no owned tests — manual review)

### 2026-08-14 — v17.3.1 → v17.3.2

- kept 6f8aa0f36f feat(ai): enforce Cursor execution policy rejections
- kept 627d7b6dac fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 610df39e94 chore(dev): preserve fork-local development configuration
- kept 155557d2c3 fix(natives): diagnose and safely promote workspace addons
- kept a39a06c12a chore(fork): automate parentless syncs with verified npm natives
- kept 329e17aabe chore(fork): sync log for v17.2.5
- kept 3f8855cb17 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept daf80f2088 chore(fork): sync log for v17.2.7
- kept 67ee693a64 chore(fork): sync log for v17.2.8
- kept 28fb39d0cd chore(fork): promote automatically once sync verification passes
- kept 7dcdbcf100 chore(fork): sync log for v17.2.9
- kept 3b7dde0f00 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 46cf44fb8c chore(fork): sync log for v17.2.10
- kept 8e7829700b fix(sync): clear stale unregistered worktree directories
- kept c62a69f193 chore(fork): sync log for v17.2.11
- kept c9e5488010 chore(fork): sync log for v17.2.12
- kept 7f2cdf59eb chore(fork): sync log for v17.2.13
- kept bd891b6df0 chore(fork): sync log for v17.2.14
- kept 3b87ff4b75 fix(coding-agent): decide non-symlink containment by the parent directory
- kept 10367f173e chore(fork): sync log for v17.2.15
- kept 03e5d821e6 docs(solutions): capture macOS hard-link realpath containment learning
- kept 0e222c615c docs(solutions): record rejection of context-mode plugin for omp
- kept 0e4bf353a7 chore(fork): sync log for v17.3.0
- kept e83fe7bbe9 chore(fork): sync log for v17.3.1
- note: 03e5d821e6 docs(solutions): capture macOS hard-link realpath containment learning (no owned tests — manual review)
- note: 0e222c615c docs(solutions): record rejection of context-mode plugin for omp (no owned tests — manual review)

### 2026-08-13 — v17.3.0 → v17.3.1

- kept 6b0ae3ab4 feat(ai): enforce Cursor execution policy rejections
- kept 2d183bb43 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept e85d6cc13 chore(dev): preserve fork-local development configuration
- kept d5f9e1ee3 fix(natives): diagnose and safely promote workspace addons
- kept 23d015874 chore(fork): automate parentless syncs with verified npm natives
- kept 32c2688f6 chore(fork): sync log for v17.2.5
- kept 336f06bfb docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 92efd8834 chore(fork): sync log for v17.2.7
- kept b9e5a1e62 chore(fork): sync log for v17.2.8
- kept d9b65a41e chore(fork): promote automatically once sync verification passes
- kept 3f0311c72 chore(fork): sync log for v17.2.9
- kept 50a8a60e2 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 9e1b8663a chore(fork): sync log for v17.2.10
- kept d26d551fe fix(sync): clear stale unregistered worktree directories
- kept a366a641f chore(fork): sync log for v17.2.11
- kept eaf8fd9ef chore(fork): sync log for v17.2.12
- kept 03d6eae6b chore(fork): sync log for v17.2.13
- kept 2319c56f4 chore(fork): sync log for v17.2.14
- kept 2b9645d8d fix(coding-agent): decide non-symlink containment by the parent directory
- kept 54d1be6fa chore(fork): sync log for v17.2.15
- kept c74083e95 docs(solutions): capture macOS hard-link realpath containment learning
- kept a4388db50 docs(solutions): record rejection of context-mode plugin for omp
- kept 6ffe6047e chore(fork): sync log for v17.3.0

### 2026-08-13 — v17.2.15 → v17.3.0

- kept 2b525c8b4 feat(ai): enforce Cursor execution policy rejections
- kept 28e3df98c fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 8e1655584 chore(dev): preserve fork-local development configuration
- kept c87b3d1ce fix(natives): diagnose and safely promote workspace addons
- kept 8b05d81ce chore(fork): automate parentless syncs with verified npm natives
- kept f350c5d0c chore(fork): sync log for v17.2.5
- kept b7dd9165a docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 2ccfbde0d chore(fork): sync log for v17.2.7
- kept 74d41f1a6 chore(fork): sync log for v17.2.8
- kept f773f7b2c chore(fork): promote automatically once sync verification passes
- kept c3fca59d8 chore(fork): sync log for v17.2.9
- kept 1dadc6df4 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept ca0344709 chore(fork): sync log for v17.2.10
- kept 7f1db79f2 fix(sync): clear stale unregistered worktree directories
- kept 2868cb166 chore(fork): sync log for v17.2.11
- kept 7a3627cdb chore(fork): sync log for v17.2.12
- kept 2c437c200 chore(fork): sync log for v17.2.13
- kept 88ebd9e92 chore(fork): sync log for v17.2.14
- kept 06db3ca6f fix(coding-agent): decide non-symlink containment by the parent directory
- kept 11664c38b chore(fork): sync log for v17.2.15
- kept 2b2bcaeab docs(solutions): capture macOS hard-link realpath containment learning
- kept 57cd65839 docs(solutions): record rejection of context-mode plugin for omp
- note: 2b2bcaeab docs(solutions): capture macOS hard-link realpath containment learning (no owned tests — manual review)
- note: 57cd65839 docs(solutions): record rejection of context-mode plugin for omp (no owned tests — manual review)

### 2026-08-12 — v17.2.14 → v17.2.15

- kept 7bfa4aa7a feat(ai): enforce Cursor execution policy rejections
- kept a61272fe2 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept e02647655 chore(dev): preserve fork-local development configuration
- kept 95eb1e802 fix(natives): diagnose and safely promote workspace addons
- kept 13e005a13 chore(fork): automate parentless syncs with verified npm natives
- kept 1d856808f chore(fork): sync log for v17.2.5
- kept cd822c872 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept d048c61ff chore(fork): sync log for v17.2.7
- kept c07f95732 chore(fork): sync log for v17.2.8
- kept b111bde66 chore(fork): promote automatically once sync verification passes
- kept 39ddc7b84 chore(fork): sync log for v17.2.9
- kept bfc9d3274 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 3f133f264 chore(fork): sync log for v17.2.10
- kept 6715a5068 fix(sync): clear stale unregistered worktree directories
- kept e082d2b16 chore(fork): sync log for v17.2.11
- kept 467372b2d chore(fork): sync log for v17.2.12
- kept a9379cbd7 chore(fork): sync log for v17.2.13
- kept de12b2826 chore(fork): sync log for v17.2.14
- kept 095fd020b fix(coding-agent): decide non-symlink containment by the parent directory

### 2026-08-11 — v17.2.13 → v17.2.14

- kept ca06be677 feat(ai): enforce Cursor execution policy rejections
- kept 023476c49 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 69afe2fab chore(dev): preserve fork-local development configuration
- kept b64dd4b0d fix(natives): diagnose and safely promote workspace addons
- kept 07caa2bbc chore(fork): automate parentless syncs with verified npm natives
- kept 2bef39f4e chore(fork): sync log for v17.2.5
- kept 2df250ab7 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept ec0c8fca2 chore(fork): sync log for v17.2.7
- kept 45774c6db chore(fork): sync log for v17.2.8
- kept 65096e862 chore(fork): promote automatically once sync verification passes
- kept 3c2fa65c9 chore(fork): sync log for v17.2.9
- kept 563f5cbce chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 27cce5c7c chore(fork): sync log for v17.2.10
- kept c022b1b3d fix(sync): clear stale unregistered worktree directories
- kept c60f00aca chore(fork): sync log for v17.2.11
- kept 6676ccb2a chore(fork): sync log for v17.2.12
- kept 7abe7e8c7 chore(fork): sync log for v17.2.13

### 2026-08-11 — v17.2.12 → v17.2.13

- kept e17b4dad9 feat(ai): enforce Cursor execution policy rejections
- kept 50f4f5be6 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 8a1a8542b chore(dev): preserve fork-local development configuration
- kept b6b2a97a7 fix(natives): diagnose and safely promote workspace addons
- kept a2f972ea5 chore(fork): automate parentless syncs with verified npm natives
- kept aa069783b chore(fork): sync log for v17.2.5
- kept 11666b8bd docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 606398279 chore(fork): sync log for v17.2.7
- kept 1b063a171 chore(fork): sync log for v17.2.8
- kept 1c15a5afb chore(fork): promote automatically once sync verification passes
- kept 3f76b8cfd chore(fork): sync log for v17.2.9
- kept b15178309 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 4f144df84 chore(fork): sync log for v17.2.10
- kept ed2fcfe79 fix(sync): clear stale unregistered worktree directories
- kept 0a9db45a6 chore(fork): sync log for v17.2.11
- kept 2a994f593 chore(fork): sync log for v17.2.12

### 2026-08-09 — v17.2.11 → v17.2.12

- kept 448f2dfdf feat(ai): enforce Cursor execution policy rejections
- kept a9a8ca072 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 9c5ea9af3 chore(dev): preserve fork-local development configuration
- kept 8e0bbadfc fix(natives): diagnose and safely promote workspace addons
- kept e26a758c0 chore(fork): automate parentless syncs with verified npm natives
- kept 219a7880b chore(fork): sync log for v17.2.5
- kept 7737a4ff7 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept c1d66ad19 chore(fork): sync log for v17.2.7
- kept 6d98619e1 chore(fork): sync log for v17.2.8
- kept 25beefd64 chore(fork): promote automatically once sync verification passes
- kept 08a1cb335 chore(fork): sync log for v17.2.9
- kept 444c32724 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept eff1f7618 chore(fork): sync log for v17.2.10
- kept 1d31b9f3d fix(sync): clear stale unregistered worktree directories
- kept 01e36f14a chore(fork): sync log for v17.2.11

### 2026-08-07 — v17.2.10 → v17.2.11

- kept f3246b09c feat(ai): enforce Cursor execution policy rejections
- kept c6e2f57fc fix(ai,coding-agent): normalize gateway model catalog metadata
- kept c9f9e6598 chore(dev): preserve fork-local development configuration
- kept 4b24e312b fix(natives): diagnose and safely promote workspace addons
- kept 57f7a13b6 chore(fork): automate parentless syncs with verified npm natives
- kept bf87b2f78 chore(fork): sync log for v17.2.5
- kept 5f30e9295 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept d1a48d32c chore(fork): sync log for v17.2.7
- kept ab6b715a1 chore(fork): sync log for v17.2.8
- kept 71eee6c9f chore(fork): promote automatically once sync verification passes
- kept 559f9de99 chore(fork): sync log for v17.2.9
- kept d4fcaf841 chore(dev): pin the shared mnemopi bank for worktree sessions
- kept 89985ea93 chore(fork): sync log for v17.2.10
- kept 6e9974ebe fix(sync): clear stale unregistered worktree directories

### 2026-08-06 — v17.2.9 → v17.2.10

- kept 8328eb3b3 feat(ai): enforce Cursor execution policy rejections
- kept 080024f0f fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 26755674a chore(dev): preserve fork-local development configuration
- kept b9db612f4 fix(natives): diagnose and safely promote workspace addons
- kept bc19c210a chore(fork): automate parentless syncs with verified npm natives
- kept 0380cd34c chore(fork): sync log for v17.2.5
- kept ee82707eb docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept d6bfc287e chore(fork): sync log for v17.2.7
- kept a82b63b76 chore(fork): sync log for v17.2.8
- kept b4a6350ab chore(fork): promote automatically once sync verification passes
- kept 8a0fc0d29 chore(fork): sync log for v17.2.9
- kept 10a1712c5 chore(dev): pin the shared mnemopi bank for worktree sessions

### 2026-08-05 — v17.2.8 → v17.2.9

- kept 9086b3fab feat(ai): enforce Cursor execution policy rejections
- kept befc98147 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept f8d4e8a08 chore(dev): preserve fork-local development configuration
- kept dd839aa07 fix(natives): diagnose and safely promote workspace addons
- kept 39d0b6924 chore(fork): automate parentless syncs with verified npm natives
- kept 33d11a182 chore(fork): sync log for v17.2.5
- kept 2e498c54c docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 0abbb3e1e chore(fork): sync log for v17.2.7
- kept 06b3471bf chore(fork): sync log for v17.2.8
- kept 7ed339386 chore(fork): promote automatically once sync verification passes

### 2026-08-04 — v17.2.7 → v17.2.8

- kept 94c60b79a feat(ai): enforce Cursor execution policy rejections
- kept 6f316f672 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 66bb77f77 chore(dev): preserve fork-local development configuration
- kept 92c105355 fix(natives): diagnose and safely promote workspace addons
- kept 3686a9eb3 chore(fork): automate parentless syncs with verified npm natives
- kept c70e51ac8 chore(fork): sync log for v17.2.5
- kept 066a76254 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs
- kept 9e7e61bdf chore(fork): sync log for v17.2.7

### 2026-08-04 — v17.2.5 → v17.2.7

- kept adabf10db feat(ai): enforce Cursor execution policy rejections
- kept cc71d71d1 fix(ai,coding-agent): normalize gateway model catalog metadata
- kept 66d1162cf chore(dev): preserve fork-local development configuration
- kept 4a4ff73bf fix(natives): diagnose and safely promote workspace addons
- kept 5a3fad538 chore(fork): automate parentless syncs with verified npm natives
- kept 09f09387b chore(fork): sync log for v17.2.5
- kept 6e4da7314 docs(fork): retire macOS 27 Bazel overlay in favor of npm-native syncs

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
