---
title: Fix macOS 27 Bazel Native Addons with Misaligned LINKEDIT String Pools
date: 2026-08-01
category: build-errors
module: native-addon-build
problem_type: build_error
component: tooling
severity: high
symptoms:
  - "A freshly built pi_natives addon fails to load on macOS 27 with mis-aligned LINKEDIT string pool"
  - "LC_SYMTAB.stroff is 4 modulo 8 even though Bazel reports a successful build"
  - "Upstream sync verification stops when patch tests import the malformed native addon"
root_cause: config_error
resolution_type: dependency_update
related_components:
  - development_workflow
  - testing_framework
tags:
  - macos-27
  - bazel
  - rust-toolchain
  - mach-o
  - native-addon
  - dyld
  - upstream-sync
  - linkedit
---
> **Retirement Notice (2026-08-03):** As of 2026-08-03, the fork retired its macOS 27 Bazel toolchain overlay (fork patch `build(natives): keep local Bazel builds working on macOS 27`) after syncing to v17.2.5. The fork now consumes upstream-published `@oh-my-pi/pi-natives-*` npm leaves during syncs (sync script npm mode) and no longer builds natives locally. The remainder of this document is preserved as the working recipe if local Bazel builds are ever needed again; the retired overlay is recoverable from tag `fork/pre-restack-v17.2.5`.

# Fix macOS 27 Bazel Native Addons with Misaligned LINKEDIT String Pools

## Problem

The v17.2.4 upstream sync built `pi_natives` successfully, but macOS 27 refused to load the resulting Darwin arm64 addon:

```text
Failed to load pi_natives native addon for darwin-arm64
mis-aligned LINKEDIT string pool, fileOffset=0x0889F8A4
```

`otool -l` showed that the reported offset was `LC_SYMTAB.stroff` and that `stroff % 8 == 4`. The file existed and passed basic `file` and code-signature checks, but its Mach-O LINKEDIT string pool did not satisfy dyld's 8-byte alignment requirement.

The addon is built under a Bazel transition that always selects the release profile: optimized mode, thin LTO, 16 codegen units, and symbol stripping (`bazel/defs.bzl:1-24`). At the time of failure, the Bazel Rust toolchain was older than the Rust/LLVM fix for Mach-O string-pool alignment.

## Symptoms

- `bun run build:native` completed without an error, but importing `packages/natives/native/index.js` failed in dyld.
- Multiple patch-test files failed before their tests ran because importing the native package loaded the malformed addon.
- Rebuilding with the unchanged toolchain reproduced the same `mis-aligned LINKEDIT string pool` error.
- After manual rebuilds, unrelated Git-fixture tests sometimes failed because Bazel's workspace convenience symlink made Bun discover the same test file through two paths.

## What Didn't Work

- **Reusing the cached Bazel output:** another `bun run build:native` copied the same malformed bytes.
- **Cleaning Bazel without changing the Rust toolchain:** a full rebuild still produced a string-table offset that dyld rejected. This ruled out a merely stale output.
- **Selecting the classic Apple linker:** adding `-Wl,-ld_classic` did not change the invalid layout.
- **Removing the explicit `-Cstrip=symbols` flag:** the rebuilt image still had `stroff % 8 == 4`; changing one release-profile option did not fix the old toolchain's Mach-O production path.
- **Running Apple `strip` afterward:** post-processing an already malformed image did not realign the string pool. Fixing the producer was safer than patching signed Mach-O offsets after linking.

A secondary failure appeared after the successful toolchain experiment: the manual Bazel build recreated `bazel-oh-my-pi-sync`. Bun then reported that the same test set ran across eight files instead of seven, and the duplicated `scripts/sync-upstream.test.ts` executions interfered with temporary Git fixtures. Those failures were test-discovery noise, not evidence that the toolchain update had failed.

## Solution

### 1. Align the Bazel and workspace Rust nightlies

Update the `rules_rust` toolchain in `MODULE.bazel` to the verified nightly date and refresh every pinned archive checksum. The current tree uses `nightly/2026-07-28` and declares all 28 component hashes (`MODULE.bazel:35-78`), matching the nightly date in `rust-toolchain.toml:1-4`.

```starlark
rust.toolchain(
    edition = "2024",
    versions = ["nightly/2026-07-28"],
    sha256s = {
        # All cargo, clippy, llvm-tools, rust-src, rust-std, rustc,
        # and rustfmt archives use the same date.
    },
)
```

Do not change only `rustc`. The pinned map is part of the reproducible Bazel toolchain contract; `MODULE.bazel:40-48` documents how to obtain each dated archive checksum.

### 2. Invalidate old native outputs and rebuild

```bash
bazelisk clean
bun run build:native
bun -e 'await import("./packages/natives/native/index.js"); console.log("loaded")'
```

The import is the important proof: a successful Bazel action only proves that an output was produced, not that dyld accepts it.

### 3. Remove the Bazel workspace symlink before tests

A manual rebuild recreates `bazel-<workspace>`. Remove that convenience symlink before invoking Bun's test discovery. The normal sync path already does this: `removeBazelWorkspaceSymlink()` targets only the root convenience symlink (`scripts/sync-upstream.ts:256-264`), and `prepareWorktree()` calls it immediately after the native build (`scripts/sync-upstream.ts:536-545`).

### 4. Resume the normal verification and promotion path

The sync verifier runs the TypeScript check, the test files owned by retained patches, and the worktree smoke probe (`scripts/sync-upstream.ts:665-679`). Promotion then stages the verified addon outside the worktree, moves `main`, installs the staged addon, and pushes with `--force-with-lease` (`scripts/sync-upstream.ts:682-697`).

During the v17.2.4 recovery, this sequence passed 162 patch tests, the smoke probe, service health checks, and remote promotion.

## Why This Works

Mach-O stores symbol names in a string pool whose file location is recorded by `LC_SYMTAB.stroff`. On macOS 27, dyld rejects an affected 64-bit dylib or addon built against the Xcode 27 SDK when that LINKEDIT string pool begins at an offset that is not 8-byte aligned. The observed remainder of 4 therefore explains why JavaScript never reached an addon function: dyld rejected the image structure during load.

Rust tracked this defect in [rust-lang/rust#157750](https://github.com/rust-lang/rust/issues/157750). The underlying LLVM change, [llvm-project#203680](https://github.com/llvm/llvm-project/pull/203680), aligns Mach-O LINKEDIT entries to pointer size. During this recovery, a clean build with the repository's pinned `nightly/2026-07-28` produced an addon that loaded on macOS 27 while preserving the intended release profile in `bazel/defs.bzl:13-24`.

The symlink cleanup fixes a separate evidence problem. Bun does not honor `.gitignore` during test discovery (`bunfig.toml:15-18`), so a workspace reachable through both its real path and Bazel's convenience link can be traversed twice. Removing the link restores one path per test and makes Git-fixture failures trustworthy.

## Prevention

- Keep `MODULE.bazel`'s nightly date and all component hashes synchronized with the verified workspace toolchain.
- After changing the Rust/LLVM producer, clean Bazel and prove the resulting addon with an actual import on the target macOS version.
- Treat addon existence as insufficient. `hasNativeAddon()` checks only for a `.node` file (`scripts/sync-upstream.ts:245-253`); the later smoke and patch-test phases provide runtime evidence.
- Remove `bazel-<workspace>` after every manual native rebuild and before any Bun test command. The automated preparation path already enforces this ordering.
- Keep sync checkpoints tied to the current head and invalidate verification when the tree is dirty or the addon is missing (`scripts/sync-upstream.ts:858-889`). If a manual experiment changes the toolchain, rebuild before marking preparation complete.
- Verify later nightly updates independently. This incident proves `nightly/2026-07-28` for this repository and platform, not every subsequent nightly.

## Related Issues

- [rust-lang/rust#157750](https://github.com/rust-lang/rust/issues/157750) — Rust's macOS dylib LINKEDIT alignment failure.
- [llvm-project#203680](https://github.com/llvm/llvm-project/pull/203680) — LLVM's Mach-O LINKEDIT alignment fix.
- [`generated-bazel-lock-refresh-replant.md`](../workflow-issues/generated-bazel-lock-refresh-replant.md) — distinguishes release-scoped generated lock refreshes from durable `MODULE.bazel` toolchain changes and documents the sync symlink cleanup.
- [`edit-tool-stale-native-addon-diff-lines-undefined.md`](../runtime-errors/edit-tool-stale-native-addon-diff-lines-undefined.md) — related native-addon recovery for disk/process staleness; sentinel mismatch is distinct from a structurally malformed Mach-O.
- [`CONCEPTS.md`](../../../CONCEPTS.md) — Replant, Promotion, Generated Lock Refresh, and native-addon staleness vocabulary.
