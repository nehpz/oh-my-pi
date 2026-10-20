---
name: omp-sync-upstream-recovery
description: "Resume a failed bun scripts/sync-upstream ver run in the oh-my-pi fork: rebase conflicts, phantom conflicts from stale worktrees, npm natives publish lag, supersession probe failures, manual-review gates, and post-promotion health checks"
---

# oh-my-pi upstream sync recovery

Repo: `/Users/stephen/Projects/nehpz/oh-my-pi` (fork). Sync worktree: `../oh-my-pi-sync`. Script is resumable — re-run `bun scripts/sync-upstream <ver>` after fixing each blocker. Run it as a named `bash` service (e.g. `name: sync`, `pty: false`; the old `hub` tool is gone — inspect via `proc://`) so shell timeouts can't kill it mid-promotion.

## Failure → fix map

**"CONFLICTED  ? unknown" with every patch listed as applied — PHANTOM conflict**
- Check first: `git -C ../oh-my-pi-sync status --short` (clean, no markers) and `git rebase --show-current-patch` ("no rebase in progress"). If both, there is no conflict to resolve.
- Cause: a leftover worktree from an *abandoned earlier* sync is still checked out on `sync/<oldver>`. `replant()` logs "sync worktree already exists (resuming)" and skips `git worktree add -B sync/<newver>`, so `refs/heads/sync/<newver>` never exists; the rebase fails instantly, `applied` = the branch's existing commits, and `retained[applied.length]` is `undefined` → `? unknown`.
- Fix: `cd ../oh-my-pi-sync && git switch -C sync/<newver> main && git branch -D sync/<oldver>`, then re-run the script.

**"working tree not clean" at preflight (live checkout)**
- Check WHAT is dirty before blaming the sync. If it's a deletion of a tracked file the sync never touches (e.g. `packages/coding-agent/scripts/omp`, the dev launcher `~/.bun/bin/omp` symlinks to), it was likely deleted outside the sync. `git restore <file>` and re-run.
- If it's your own uncommitted fix, commit and push to main BEFORE the sync starts (safe: pre-snapshot).

**"a rebase is still in progress" / real replant conflict**
1. In `../oh-my-pi-sync`: inspect conflicts (`read <file>:conflicts`), resolve faithfully — fork's side is often a superset of upstream's change; for additive helper-vs-helper conflicts grep the merged file for both symbols and keep both if both are called.
2. **Superseded-workaround conflicts:** fork hunk is a workaround and upstream HEAD now carries its own fix on the same lines → take upstream's side. Confirm with `git show HEAD:<file>`.
3. **Condition-vs-body conflicts:** upstream refactored the guard condition, fork changed the guarded body → combine upstream's condition + fork's body; verify both symbols exist in the merged file.
4. **Do not run bun in the worktree mid-rebase** — later patches (e.g. the Bun `packageManager` pin) aren't applied yet. The worktree is normally cloned with `node_modules` (unless it logged "worktree clone fell back to plain checkout"); resolve markers only. The re-run of the script does install, `bun check`, patch tests and smoke after the replant completes.
5. **Upstream tests hitting fork-widened return types:** adapt in-place with the fork's existing patterns in the same file (`asToolResult(...)`, `if (!("rejected" in r)) throw`). Stage into the conflicted fork commit itself. Format touched files before continuing.
6. **Stage ONLY resolved files** — never `git add -A`: it sweeps the untracked `.sync-upstream-progress.json` into the fork patch, which later fails native preparation. Recovery: `git rm --cached .sync-upstream-progress.json && git commit --fixup=<adder>`, move the file aside, `GIT_EDITOR=true git -c sequence.editor=: rebase -i --autosquash <adder>^`.
7. `GIT_EDITOR=true git rebase --continue`, re-run script.

**"npm natives for v<ver> unavailable ...; building from probe source via bazel" then exit 1**
- The fallback runs the **probe tag's** `scripts/bazel-natives.ts host --dest …`. Current versions default a plain `host` build to the local Cargo/N-API builder (Bazel only with `OMP_NATIVE_BUILD_BACKEND=bazel`); older tags may still go through Bazel. Read the actual builder error rather than assuming it must fail. Then diagnose the npm side: `npm view @oh-my-pi/pi-natives-darwin-arm64@<ver> dist.tarball` vs `npm view @oh-my-pi/pi-natives@<ver> dist.tarball`.
- Upstream publishes the platform **leaf** before the **core meta** package, so the core 404s on a fresh tag while the leaf (which carries the `.node`) exists. `acquireNpmNativeAddon` must install core opportunistically and validate `coreManifest` only when present, falling back to a leaf-only install (fork commit 0d00169f53, v18.1.8). Leaf name/version/os/cpu + `expectedAddonFilenames` still pin the release contract.
- **A fix needed by the currently running sync must exist in main's copy of the script** — the script always executes `<repo>/scripts/sync-upstream.ts`. Commit it on the sync worktree branch (so it ships) AND `git cherry-pick` it onto main (so this run uses it). Safe: `promote()` force-resets main to the sync head, orphaning the cherry-pick. Give the commit an owned test in its own diff so the probe retains it instead of gating on manual review.

**Worktree natives fail with a native version error**
- The loader checks the addon's stamped release (`__piNativesBuildVersion()`; the old per-release `__piNativesV<ver>` export is only a fallback for pre-stamp addons) and its error tells you which side is stale (`packages/natives/native/loader-state.js` `validateLoadedBindings`):
  - **"…still resident in this process … restart omp … (reinstalling changes nothing)"** — the file on disk is already right; an old addon is loaded in the running process. Restart omp. Don't touch the `.node`.
  - **"The .node file on disk is from a different release…"** — the file on disk is wrong. In a workspace: `bun run build:native`, then restart omp; or fetch the matching npm prebuilt: `curl -sL https://registry.npmjs.org/@oh-my-pi/pi-natives-darwin-arm64/-/pi-natives-darwin-arm64-<ver>.tgz | tar xz` and copy `package/*.node` to `packages/natives/native/pi_natives.darwin-arm64.node`. Copying main's addon only works when versions match.

**Type errors in fork tests after rebase (`bun check` fails, not a marker conflict)**
- Cause: upstream added tests calling a handler whose return type the fork widened, or tsgo inference tightened.
- **NEVER commit a typecheck-only fix as a standalone fork commit touching test files** — the probe runs tests at RUNTIME on bare upstream; a compile-only fix passes there → judged superseded → drop loop. Fold it into an existing still-needed fork patch: `git reset --soft HEAD~1 && git commit --fixup=<host> && GIT_EDITOR=true git -c sequence.editor=: rebase -i --autosquash <host>^`.

**Supersession probe fails at "preparing bare upstream probe environment"**
- Usually the npm natives lag above. Probe worktree is `../oh-my-pi-supersession-probe`; remove with `git worktree remove --force` before re-running manually.

**"manual review is required before promotion"**
- A fork commit has no owned tests, isn't record-only, and its patch-id isn't in `scripts/sync-upstream-retained.json`. REVIEW, don't rubberstamp: add a test into the commit's own diff (graduates to probe bucket) or re-run with `--accept-manual-review` (writes durable ledger entry).

**"… /healthz not healthy within 60000ms" AFTER "promoting main ..."**
- NOT a rollback: promotion + push already happened. `curl http://127.0.0.1:4000/healthz`, then re-run — takes the alreadyBased path and finishes.

**Health check: "/v1/models entries missing context_length"**
- Every row must carry `context_length` and `max_tokens` as number|null — emit `?? null` (`packages/ai/src/auth-gateway/server.ts`).

**"promote failed" / push rejected**
- `git remote set-url origin https://github.com/nehpz/oh-my-pi.git`, re-run.

## Critical invariants

- **NEVER commit to main between snapshot and promotion** unless the commit is also on the sync branch — `promote()` force-resets main and orphans interim commits.
- Progress cache (`.sync-upstream-progress.json`) is keyed by branch head: any history rewrite invalidates verdicts and probes re-run (~1 min). It must stay untracked.
- After promotion, re-running takes the alreadyBased path ("fork already based on … — running post-promotion checks only"): promote any staged native addon, bun install, bounce services + health check, sync log. It prints no "complete" line.
- Verify completion: `git fetch origin` then `git rev-parse main origin/main` identical, plus either "sync to v<ver> complete" (normal run) or a clean exit-0 alreadyBased re-run. The `fork/pre-v<ver>` rollback tag stays.
