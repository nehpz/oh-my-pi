import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { Patch } from "./sync-upstream";
import {
	assertCleanTree,
	checkLocalIdentityPinned,
	classifyNativeContractImpact,
	classifyNoTestsPatch,
	classifyNpmNativeAcquisitionError,
	clearStaleWorktreeDirectory,
	expectedAddonFilenames,
	formatConflictReport,
	getStagedNativeAddonPath,
	hasNativeAddon,
	installAndCleanStagedNativeAddon,
	installVerifiedNativeAddon,
	isForkRecordPatch,
	isGeneratedLockRefreshPatch,
	isRecordFile,
	isTrackedClean,
	loadCommittedRetainedLedger,
	loadProgress,
	loadRetainedLedger,
	nativeVariantForAddonFilename,
	normalizeVersion,
	parseArgs,
	parseStack,
	prepareWorktree,
	REPLANT_REBASE_FLAGS,
	RETAINED_LEDGER_RELATIVE,
	removeBazelWorkspaceSymlink,
	removeSyncWorktree,
	rewriteRebaseTodo,
	saveProgress,
	saveRetainedLedger,
	sequenceEditorCommand,
	stageVerifiedNativeAddon,
	supersessionCheck,
	testFilesOf,
	upstreamTag,
	validateAcquiredNativePackage,
	validatePreparationEvidence,
} from "./sync-upstream";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseArgs", () => {
	it("parses valid version and flag arguments", () => {
		const res = parseArgs(["17.1.8", "--dry-run", "--verify-only", "--accept-manual-review", "--native-mode=bazel"]);
		expect(res.version).toBe("v17.1.8");
		expect(res.dryRun).toBe(true);
		expect(res.verifyOnly).toBe(true);
		expect(res.acceptManualReview).toBe(true);
		expect(res.status).toBe(false);
		expect(res.nativeMode).toBe("bazel");
		expect(parseArgs(["17.1.8"]).nativeMode).toBe("auto");
	});

	it("parses status command", () => {
		const res = parseArgs(["status"]);
		expect(res.status).toBe(true);
		expect(res.version).toBeUndefined();
	});

	it("rejects status combined with version or flags", () => {
		expect(() => parseArgs(["status", "v17.1.8"])).toThrow(/status command does not accept/);
		expect(() => parseArgs(["status", "--dry-run"])).toThrow(/status command does not accept/);
		expect(() => parseArgs(["status", "--verify-only"])).toThrow(/status command does not accept/);
	});

	it("rejects unknown flags", () => {
		expect(() => parseArgs(["v17.1.8", "--foo"])).toThrow("unknown flag: --foo");
	});

	it("rejects multiple version arguments", () => {
		expect(() => parseArgs(["v17.1.8", "v17.1.9"])).toThrow("unexpected positional argument: v17.1.9");
	});
});

describe("native contract impact", () => {
	const patch: Patch = { sha: "abc123", subject: "build(natives): update inputs" };

	it("uses npm for runtime-only changes and docs", () => {
		expect(
			classifyNativeContractImpact([
				{
					patch,
					changedFiles: ["packages/natives/native/loader-state.js", "docs/fork-maintenance.md"],
				},
			]).mode,
		).toBe("npm");
	});

	it("fails closed to Bazel for native source, build inputs, and MODULE changes", () => {
		for (const changedFiles of [
			["MODULE.bazel"],
			["crates/pi-shell/src/process.rs"],
			["crates/pi-natives/src/lib.rs"],
			["Cargo.lock"],
			["bazel/defs.bzl"],
			["packages/natives/native/index.d.ts"],
			["packages/natives/package.json"],
			["packages/natives/scripts/gen-npm-packages.ts"],
			["MODULE.bazel.lock"],
		]) {
			expect(classifyNativeContractImpact([{ patch, changedFiles }]).mode).toBe("bazel");
		}
	});
});

describe("expectedAddonFilenames", () => {
	it("returns the baseline, modern, and plain addon filenames for x64 targets", () => {
		expect(expectedAddonFilenames("linux-x64")).toEqual([
			"pi_natives.linux-x64-baseline.node",
			"pi_natives.linux-x64-modern.node",
			"pi_natives.linux-x64.node",
		]);
	});

	it("returns the single plain addon filename for non-x64 targets", () => {
		expect(expectedAddonFilenames("darwin-arm64")).toEqual(["pi_natives.darwin-arm64.node"]);
	});
});
describe("validateAcquiredNativePackage", () => {
	const valid = {
		packageVersion: "17.2.4",
		leafName: "@oh-my-pi/pi-natives-darwin-arm64",
		tag: "darwin-arm64",
		targetOs: "darwin",
		targetCpu: "arm64",
		coreManifest: { name: "@oh-my-pi/pi-natives", version: "17.2.4" },
		leafManifest: {
			name: "@oh-my-pi/pi-natives-darwin-arm64",
			version: "17.2.4",
			os: ["darwin"],
			cpu: ["arm64"],
		},
		addonFiles: ["pi_natives.darwin-arm64.node"],
	};

	it("accepts only the exact core, leaf, platform, and expected addon identity", () => {
		expect(() => validateAcquiredNativePackage(valid)).not.toThrow();
		for (const invalid of [
			{ ...valid, coreManifest: { ...valid.coreManifest, version: "17.2.3" } },
			{ ...valid, leafManifest: { ...valid.leafManifest, cpu: ["arm64", "x64"] } },
			{ ...valid, leafManifest: { ...valid.leafManifest, os: ["darwin", "linux"] } },
			{ ...valid, leafManifest: { ...valid.leafManifest, cpu: ["x64"] } },
			{ ...valid, addonFiles: [] },
			{ ...valid, addonFiles: ["pi_natives.linux-arm64.node"] },
		]) {
			expect(() => validateAcquiredNativePackage(invalid)).toThrow(/metadata mismatch|unexpected or missing/);
		}
	});

	it("accepts a leaf whose core meta package is not published yet, still checking leaf identity", () => {
		expect(() => validateAcquiredNativePackage({ ...valid, coreManifest: undefined })).not.toThrow();
		expect(() =>
			validateAcquiredNativePackage({
				...valid,
				coreManifest: undefined,
				leafManifest: { ...valid.leafManifest, version: "17.2.3" },
			}),
		).toThrow(/metadata mismatch/);
	});
});

describe("native addon variant selection", () => {
	it("maps every shipped filename to its explicit loader variant", () => {
		expect(nativeVariantForAddonFilename("pi_natives.darwin-x64-baseline.node")).toBe("baseline");
		expect(nativeVariantForAddonFilename("pi_natives.darwin-x64-modern.node")).toBe("modern");
		expect(nativeVariantForAddonFilename("pi_natives.darwin-arm64.node")).toBeUndefined();
	});
});
describe("isTrackedClean", () => {
	it("returns true when porcelain has only untracked files and false when tracked files change", () => {
		expect(isTrackedClean("?? docs/plans/\n?? .sync-upstream-progress.json\n")).toBe(true);
		expect(isTrackedClean(" M packages/ai/src/types.ts\n?? scratch.txt\n")).toBe(false);
	});
});

describe("normalizeVersion", () => {
	it("maps bare and v-prefixed versions to the v-prefixed form", () => {
		expect(normalizeVersion("17.0.8")).toBe("v17.0.8");
		expect(normalizeVersion("v17.0.8")).toBe("v17.0.8");
		expect(upstreamTag(normalizeVersion("17.0.8"))).toBe("upstream/v17.0.8");
	});

	it("rejects non-release inputs", () => {
		for (const bad of ["17.0", "main", "v17.0.8-rc1", "", "17.0.8 --dry-run"]) {
			expect(() => normalizeVersion(bad)).toThrow(/invalid version/);
		}
	});
});

describe("parseStack", () => {
	it("excludes merge commits and returns application (oldest-first) order", () => {
		// git log order: newest first; 47d198fd8 and eafeb7c71 are merges (2 parents).
		const lines = [
			"daa999a2a\t1111111\tchore(dev): add local config example and gitignore entries",
			"eafeb7c71\t2222222 3333333\tMerge branch 'fix/auth-gateway-models-list'",
			"0ecb8b33a\t4444444\tfix(ai,coding-agent): stop doubling /v1/models entries",
			"47d198fd8\t5555555 6666666\tMerge remote-tracking branch 'origin/main'",
			"6f726bc17\t7777777\tfeat(ai): introduce policy rejections for exec handlers",
		];
		expect(parseStack(lines).map(p => p.sha)).toEqual(["6f726bc17", "0ecb8b33a", "daa999a2a"]);
	});
});

describe("generated Bazel lock refresh patches", () => {
	const patch: Patch = {
		sha: "b69a2dc61",
		subject: "build(natives): refresh Bazel lock for v17.2.0",
	};

	it("classifies only versioned MODULE.bazel.lock-only refreshes as disposable", () => {
		expect(isGeneratedLockRefreshPatch(patch, ["MODULE.bazel.lock"])).toBe(true);
		expect(isGeneratedLockRefreshPatch(patch, ["MODULE.bazel.lock", "Cargo.lock"])).toBe(false);
		expect(
			isGeneratedLockRefreshPatch({ ...patch, subject: "build(natives): update Bazel configuration" }, [
				"MODULE.bazel.lock",
			]),
		).toBe(false);
	});

	it("drops classified patches from an interactive rebase todo", () => {
		const todo = [
			"pick a30a1be feat(ai): introduce policy rejections",
			"p b69a2dc build(natives): refresh Bazel lock for v17.2.0",
			"pick dd8401c test(coding-agent): narrow Cursor exec rejection results",
			"",
		].join("\n");

		expect(rewriteRebaseTodo(todo, [patch.sha])).toBe(
			[
				"pick a30a1be feat(ai): introduce policy rejections",
				"drop b69a2dc build(natives): refresh Bazel lock for v17.2.0",
				"pick dd8401c test(coding-agent): narrow Cursor exec rejection results",
				"",
			].join("\n"),
		);
	});

	it("executes the generated sequence editor during a real Git rebase", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-lock-rebase-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			for (const [file, subject] of [
				["base.txt", "base"],
				["lock.txt", patch.subject],
				["feature.txt", "fixup! base"],
			]) {
				await Bun.write(path.join(dir, file), subject);
				await $`git add ${file}`.cwd(dir).quiet();
				await $`git -c user.name=Test -c user.email=test@example.invalid commit -m ${subject}`.cwd(dir).quiet();
			}
			const lockSha = (await $`git rev-parse HEAD~1`.cwd(dir).quiet()).text().trim();

			await $`git -c rebase.abbreviateCommands=true -c rebase.autoSquash=true -c sequence.editor=${sequenceEditorCommand([lockSha])} rebase ${REPLANT_REBASE_FLAGS} --root`
				.cwd(dir)
				.quiet();

			const subjects = (await $`git log --format=%s`.cwd(dir).quiet()).text().trim().split("\n");
			expect(subjects).toEqual(["fixup! base", "base"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("assertCleanTree", () => {
	it("allows untracked files but refuses tracked changes with a named error", () => {
		expect(() => assertCleanTree("?? docs/plans/\n")).not.toThrow();
		expect(() => assertCleanTree(" M packages/ai/src/types.ts\n?? scratch.txt\n")).toThrow(/working tree not clean/);
	});
});

describe("checkLocalIdentityPinned", () => {
	it("requires a repo-local identity so ambient config cannot leak into fork commits", () => {
		expect(checkLocalIdentityPinned("Fork Bot", "fork@example.invalid")).toBeNull();
		expect(checkLocalIdentityPinned("", "")).toMatch(/no repo-local git identity[\s\S]*git config --local/);
		expect(checkLocalIdentityPinned("Fork Bot", "")).toMatch(/no repo-local git identity/);
		expect(checkLocalIdentityPinned("", "fork@example.invalid")).toMatch(/no repo-local git identity/);
	});
});

describe("formatConflictReport", () => {
	it("names the conflicted patch by short sha and subject", () => {
		const report = formatConflictReport(
			{ sha: "0ecb8b33a", subject: "fix(ai,coding-agent): stop doubling /v1/models entries" },
			[{ sha: "6f726bc17", subject: "feat(ai): policy rejections" }],
			[{ sha: "daa999a2a", subject: "chore(dev): config example" }],
		);
		expect(report).toContain("CONFLICTED  0ecb8b33a fix(ai,coding-agent): stop doubling /v1/models entries");
		expect(report).toContain("applied     6f726bc17");
		expect(report).toContain("remaining   daa999a2a");
		expect(report).toMatch(/rebase --continue|rebase --skip/);
	});
});

describe("testFilesOf", () => {
	it("selects owned test files from a patch's changed paths", () => {
		expect(
			testFilesOf([
				"packages/ai/src/auth-gateway/server.ts",
				"packages/ai/test/auth-gateway-models-list.test.ts",
				"packages/coding-agent/test/auth-gateway-model-catalog.test.ts",
				"docs/fork-maintenance.md",
			]),
		).toEqual([
			"packages/ai/test/auth-gateway-models-list.test.ts",
			"packages/coding-agent/test/auth-gateway-model-catalog.test.ts",
		]);
	});
});

describe("installVerifiedNativeAddon", () => {
	it("replaces the complete addon set while preserving loader files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-native-"));
		const worktreeRoot = path.join(dir, "worktree");
		const liveRoot = path.join(dir, "live");
		const nativePath = path.join("packages", "natives", "native");
		try {
			await Bun.write(path.join(worktreeRoot, nativePath, "pi_natives.test.node"), "verified-addon");
			await Bun.write(path.join(liveRoot, nativePath, "pi_natives.test.node"), "stale-addon");
			await Bun.write(path.join(liveRoot, nativePath, "obsolete.node"), "obsolete");
			await Bun.write(path.join(liveRoot, nativePath, "loader.js"), "preserved-loader");

			await installVerifiedNativeAddon(worktreeRoot, liveRoot);

			expect(await Bun.file(path.join(liveRoot, nativePath, "pi_natives.test.node")).text()).toBe("verified-addon");
			expect(await Bun.file(path.join(liveRoot, nativePath, "obsolete.node")).exists()).toBe(false);
			expect(await Bun.file(path.join(liveRoot, nativePath, "loader.js")).text()).toBe("preserved-loader");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("restores the complete prior addon directory when the commit rename fails", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-native-rollback-"));
		const worktreeRoot = path.join(dir, "worktree");
		const liveRoot = path.join(dir, "live");
		const nativePath = path.join("packages", "natives", "native");
		const rename = fs.rename;
		let renameCalls = 0;
		try {
			await Bun.write(path.join(worktreeRoot, nativePath, "pi_natives.new.node"), "new-addon");
			await Bun.write(path.join(liveRoot, nativePath, "pi_natives.old.node"), "old-addon");
			await Bun.write(path.join(liveRoot, nativePath, "loader.js"), "old-loader");
			vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
				renameCalls++;
				if (renameCalls === 2) throw new Error("injected commit failure");
				await rename(...args);
			});

			await expect(installVerifiedNativeAddon(worktreeRoot, liveRoot)).rejects.toThrow("injected commit failure");

			expect(await Bun.file(path.join(liveRoot, nativePath, "pi_natives.old.node")).text()).toBe("old-addon");
			expect(await Bun.file(path.join(liveRoot, nativePath, "pi_natives.new.node")).exists()).toBe(false);
			expect(await Bun.file(path.join(liveRoot, nativePath, "loader.js")).text()).toBe("old-loader");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rolls back the prior addon directory when installed validation fails", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-native-validation-"));
		const worktreeRoot = path.join(dir, "worktree");
		const liveRoot = path.join(dir, "live");
		const nativePath = path.join("packages", "natives", "native");
		try {
			await Bun.write(path.join(worktreeRoot, nativePath, "pi_natives.new.node"), "new-addon");
			await Bun.write(path.join(liveRoot, nativePath, "pi_natives.old.node"), "old-addon");

			await expect(
				installVerifiedNativeAddon(worktreeRoot, liveRoot, async () => {
					throw new Error("injected validation failure");
				}),
			).rejects.toThrow("injected validation failure");

			expect(await Bun.file(path.join(liveRoot, nativePath, "pi_natives.old.node")).text()).toBe("old-addon");
			expect(await Bun.file(path.join(liveRoot, nativePath, "pi_natives.new.node")).exists()).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("removes a newly installed addon directory when validation fails without a prior target", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-native-new-validation-"));
		const worktreeRoot = path.join(dir, "worktree");
		const liveRoot = path.join(dir, "live");
		const nativePath = path.join("packages", "natives", "native");
		try {
			await Bun.write(path.join(worktreeRoot, nativePath, "pi_natives.new.node"), "new-addon");

			await expect(
				installVerifiedNativeAddon(worktreeRoot, liveRoot, async () => {
					throw new Error("injected validation failure");
				}),
			).rejects.toThrow("injected validation failure");

			expect(await Bun.file(path.join(liveRoot, nativePath)).exists()).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("restores a stable backup left by an interrupted swap", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-native-interrupted-"));
		const worktreeRoot = path.join(dir, "worktree");
		const liveRoot = path.join(dir, "live");
		const nativePath = path.join("packages", "natives", "native");
		const target = path.join(liveRoot, nativePath);
		try {
			await Bun.write(path.join(worktreeRoot, nativePath, "new.node"), "new");
			await Bun.write(path.join(liveRoot, `${nativePath}.backup`, "old.node"), "old");
			await installVerifiedNativeAddon(worktreeRoot, liveRoot);
			expect(await Bun.file(path.join(target, "new.node")).text()).toBe("new");
			expect(await Bun.file(path.join(target, "old.node")).exists()).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("refuses promotion when the verified worktree has no addon", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-native-empty-"));
		const worktreeRoot = path.join(dir, "worktree");
		try {
			await fs.mkdir(path.join(worktreeRoot, "packages", "natives", "native"), { recursive: true });
			await expect(installVerifiedNativeAddon(worktreeRoot, path.join(dir, "live"))).rejects.toThrow(
				"verified worktree has no native addon",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("stageVerifiedNativeAddon and recovery flow", () => {
	it("stages in version-keyed location outside worktree, removes stale staging, and installs after worktree removal", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-native-recovery-"));
		const worktreeRoot = path.join(tmpDir, "worktree");
		const liveRoot = path.join(tmpDir, "live");
		const relativeAddonPath = path.join("packages", "natives", "native", "pi_natives.test.node");
		const stagedRoot = getStagedNativeAddonPath("17.0.8", tmpDir);
		try {
			// Pre-populate stale file in staging location
			await Bun.write(path.join(stagedRoot, "packages", "natives", "native", "stale.node"), "stale");
			await Bun.write(path.join(worktreeRoot, relativeAddonPath), "verified-v17.0.8");
			await Bun.write(path.join(liveRoot, relativeAddonPath), "stale-addon");

			const actualStagedRoot = await stageVerifiedNativeAddon(worktreeRoot, "17.0.8", tmpDir);
			expect(actualStagedRoot).toBe(stagedRoot);
			expect(await hasNativeAddon(stagedRoot)).toBe(true);
			expect(await Bun.file(path.join(stagedRoot, "packages", "natives", "native", "stale.node")).exists()).toBe(
				false,
			);

			// Source worktree disappears before install
			await fs.rm(worktreeRoot, { recursive: true, force: true });
			expect(await Bun.file(path.join(worktreeRoot, relativeAddonPath)).exists()).toBe(false);

			// Production helper installs from staged addon and cleans up staging
			await installAndCleanStagedNativeAddon(stagedRoot, liveRoot);
			expect(await Bun.file(path.join(liveRoot, relativeAddonPath)).text()).toBe("verified-v17.0.8");
			expect(await hasNativeAddon(stagedRoot)).toBe(false);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
			await fs.rm(stagedRoot, { recursive: true, force: true });
		}
	});

	it("preserves version-keyed staged addon and throws actionable error when installAndCleanStagedNativeAddon fails", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-native-fail-"));
		const worktreeRoot = path.join(tmpDir, "worktree");
		const badLiveRoot = path.join(tmpDir, "invalid-target-file");
		const relativeAddonPath = path.join("packages", "natives", "native", "pi_natives.test.node");
		try {
			await Bun.write(path.join(worktreeRoot, relativeAddonPath), "verified-v17.0.8");
			// Block target directory creation by creating a file where package directory will go
			await Bun.write(badLiveRoot, "not a directory");

			const stagedRoot = await stageVerifiedNativeAddon(worktreeRoot, "17.0.8", tmpDir);
			expect(await hasNativeAddon(stagedRoot)).toBe(true);

			// Remove source worktree
			await fs.rm(worktreeRoot, { recursive: true, force: true });

			// Install failure via helper
			await expect(installAndCleanStagedNativeAddon(stagedRoot, badLiveRoot)).rejects.toThrow(
				`failed to install verified native addon from ${stagedRoot}`,
			);

			// Staged addon is preserved despite install failure
			expect(await hasNativeAddon(stagedRoot)).toBe(true);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("status subcommand", () => {
	it("reports setup instructions instead of throwing when no upstream remote exists", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-status-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			// Run the real script against a repo with no upstream remote. The script
			// resolves the repo root from its own location, so run it via a copy whose
			// parent is the temp repo.
			await fs.mkdir(path.join(dir, "scripts"));
			await fs.mkdir(path.join(dir, "packages", "natives", "scripts"), { recursive: true });
			await fs.copyFile(
				path.resolve(import.meta.dir, "sync-upstream.ts"),
				path.join(dir, "scripts", "sync-upstream.ts"),
			);
			await fs.copyFile(
				path.resolve(import.meta.dir, "../packages/natives/scripts/gen-npm-packages.ts"),
				path.join(dir, "packages", "natives", "scripts", "gen-npm-packages.ts"),
			);
			await fs.symlink(path.resolve(import.meta.dir, "../node_modules"), path.join(dir, "node_modules"), "dir");
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
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
describe("fork record classification", () => {
	it("identifies record-only files", () => {
		expect(isRecordFile("docs/fork-maintenance.md")).toBe(true);
		expect(isRecordFile("AGENTS.md")).toBe(true);
		expect(isRecordFile("CONCEPTS.md")).toBe(true);
		expect(isRecordFile("README.md")).toBe(true);
		expect(isRecordFile("CHANGELOG.md")).toBe(true);
		expect(isRecordFile(".omp/logs/omp.log")).toBe(true);
		expect(isRecordFile(".compound-engineering/spec.md")).toBe(true);
		expect(isRecordFile(".gitignore")).toBe(true);
		expect(isRecordFile("scripts/sync-upstream-retained.json")).toBe(true);

		expect(isRecordFile("LICENSE")).toBe(false);
		expect(isRecordFile("scripts/sync-upstream.ts")).toBe(false);
		expect(isRecordFile("packages/coding-agent/src/cli.ts")).toBe(false);
		expect(isRecordFile("bun.lock")).toBe(false);
		expect(isRecordFile("package.json")).toBe(false);
	});

	it("classifies patches as fork records by files alone, regardless of subject", () => {
		expect(isForkRecordPatch(["docs/solutions/x.md", "CONCEPTS.md"])).toBe(true);

		const recordFiles = [".gitignore", ".omp/mcp.json", ".compound-engineering/config.local.example.yaml"];
		expect(isForkRecordPatch(recordFiles)).toBe(true);

		expect(isForkRecordPatch(["docs/note.md", "scripts/sync-upstream.ts"])).toBe(false);
		expect(isForkRecordPatch([])).toBe(false);
	});
});

describe("retained ledger no-tests classification", () => {
	const patchId = "00a0e90f95ada4778ef7492f02c922acb28b281d";
	const codeFiles = ["scripts/sync-upstream.ts"];
	const recordFiles = ["docs/fork-maintenance.md"];
	const ledger = {
		[patchId]: {
			subject: "fix(sync): fall back to bazel-built natives when npm publish lags the upstream tag",
			reason: "script-only sync tooling fix; fallback decision logic now covered by tests",
			date: "2026-08-21",
		},
	};

	it("treats a no-tests non-record patch as ledger-retained when its patch-id is present", () => {
		expect(classifyNoTestsPatch(codeFiles, patchId, ledger)).toBe("ledger-retained");
	});

	it("treats a no-tests non-record patch as manual-review when the ledger is empty", () => {
		expect(classifyNoTestsPatch(codeFiles, patchId, {})).toBe("manual-review");
	});

	it("treats a record-only diff as a fork record regardless of the ledger", () => {
		expect(classifyNoTestsPatch(recordFiles, patchId, ledger)).toBe("fork-record");
		expect(classifyNoTestsPatch(recordFiles, patchId, {})).toBe("fork-record");
	});

	it("returns an empty ledger when the retained file is missing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-ledger-"));
		try {
			expect(await loadRetainedLedger(dir)).toEqual({});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("classification reads only the committed ledger, ignoring uncommitted working-tree writes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-ledger-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			// No commit yet: missing HEAD path -> empty ledger.
			expect(await loadCommittedRetainedLedger(dir)).toEqual({});

			await saveRetainedLedger(dir, ledger);
			// Written but uncommitted (the crash window between save and commit):
			// the gate must still see an empty ledger and re-fire.
			expect(await loadCommittedRetainedLedger(dir)).toEqual({});

			await $`git add ${RETAINED_LEDGER_RELATIVE} && git -c user.name=Test -c user.email=test@example.invalid commit -q -m ledger`
				.cwd(dir)
				.quiet();
			expect(await loadCommittedRetainedLedger(dir)).toEqual(ledger);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("npm native acquisition fallback decision", () => {
	it("falls back to bazel for npm 404 and publish-lag errors", () => {
		expect(
			classifyNpmNativeAcquisitionError(new Error("GET https://registry.npmjs.org/@oh-my-pi/pi-natives - 404")),
		).toBe("fallback");
		expect(classifyNpmNativeAcquisitionError("error: @oh-my-pi/pi-natives@17.4.3 failed to resolve")).toBe(
			"fallback",
		);
		expect(classifyNpmNativeAcquisitionError(new Error("npm publish lags the upstream tag"))).toBe("fallback");
		expect(classifyNpmNativeAcquisitionError(new Error("E404 Not Found"))).toBe("fallback");
	});

	it("classifies real bun-install ShellError shapes via stderr, not the fixed message", () => {
		const shellError = (stderr: string) =>
			Object.assign(new Error("Failed with exit code 1"), { stderr: Buffer.from(stderr) });
		expect(
			classifyNpmNativeAcquisitionError(
				shellError(
					'error: No version matching "17.4.3" found for specifier "@oh-my-pi/pi-natives"\nerror: @oh-my-pi/pi-natives@17.4.3 failed to resolve\n',
				),
			),
		).toBe("fallback");
		expect(
			classifyNpmNativeAcquisitionError(
				shellError("error: GET https://registry.npmjs.org/@oh-my-pi/pi-natives - 404\n"),
			),
		).toBe("fallback");
		expect(classifyNpmNativeAcquisitionError(shellError("error: tarball checksum mismatch\n"))).toBe("rethrow");
	});

	it("rethrows unrelated acquisition failures", () => {
		expect(classifyNpmNativeAcquisitionError(new Error("npm native package metadata mismatch"))).toBe("rethrow");
		expect(classifyNpmNativeAcquisitionError(new Error("ECONNREFUSED"))).toBe("rethrow");
		expect(classifyNpmNativeAcquisitionError(new Error("permission denied"))).toBe("rethrow");
	});
});

describe("progress persistence and invalidation", () => {
	it("returns fresh progress when no file exists or when head/version change", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-progress-"));
		try {
			const p1 = await loadProgress(dir, "v17.1.8", "sha1");
			expect(p1.preparation).toBeUndefined();
			expect(p1.verified).toBe(false);
			expect(p1.head).toBe("sha1");

			p1.preparation = {
				version: "v17.1.8",
				head: "sha1",
				mode: "npm",
				platform: `${process.platform}-${process.arch}`,
				leafName: `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`,
				leafVersion: "17.1.8",
				addonFiles: [`pi_natives.${process.platform}-${process.arch}.node`],
				verified: true,
			};
			p1.verified = true;
			await saveProgress(dir, p1);

			const loaded = await loadProgress(dir, "v17.1.8", "sha1");
			expect(loaded.preparation?.mode).toBe("npm");
			expect(loaded.verified).toBe(true);

			const mismatchHead = await loadProgress(dir, "v17.1.8", "sha2");
			expect(mismatchHead.preparation).toBeUndefined();
			expect(mismatchHead.head).toBe("sha2");

			const mismatchVersion = await loadProgress(dir, "v17.1.9", "sha1");
			expect(mismatchVersion.preparation).toBeUndefined();
			expect(mismatchVersion.version).toBe("v17.1.9");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("invalidates preparation evidence when its package identity no longer matches", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-evidence-"));
		try {
			const addonFile = `pi_natives.${process.platform}-${process.arch}.node`;
			await Bun.write(path.join(dir, "packages", "natives", "native", addonFile), "not-loaded");
			expect(
				await validatePreparationEvidence(dir, {
					version: "v17.2.4",
					head: "sha",
					mode: "npm",
					platform: `${process.platform}-${process.arch}`,
					leafName: `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`,
					leafVersion: "17.2.3",
					addonFiles: [addonFile],
					verified: true,
				}),
			).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("phase skip and native addon contracts", () => {
	it("detects presence of native addon files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-addon-"));
		const addonDir = path.join(dir, "packages", "natives", "native");
		try {
			expect(await hasNativeAddon(dir)).toBe(false);

			await fs.mkdir(addonDir, { recursive: true });
			expect(await hasNativeAddon(dir)).toBe(false);

			await Bun.write(path.join(addonDir, "pi_natives.node"), "binary");
			expect(await hasNativeAddon(dir)).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("removes every Bazel output symlink without touching its targets", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-bazel-link-"));
		const execRoot = path.join(dir, "execroot");
		const symlinkPaths = [
			path.join(dir, `bazel-${path.basename(dir)}`),
			path.join(dir, "bazel-bin"),
			path.join(dir, "bazel-out"),
			path.join(dir, "bazel-testlogs"),
		];
		try {
			await fs.mkdir(execRoot);
			await Promise.all(symlinkPaths.map(symlinkPath => fs.symlink(execRoot, symlinkPath)));

			await removeBazelWorkspaceSymlink(dir);

			for (const symlinkPath of symlinkPaths) {
				await expect(fs.lstat(symlinkPath)).rejects.toMatchObject({ code: "ENOENT" });
			}
			expect((await fs.stat(execRoot)).isDirectory()).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("removes a locked sync worktree", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-locked-worktree-"));
		const worktreeDir = path.join(dir, "sync");
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await Bun.write(path.join(dir, "tracked.txt"), "tracked");
			await $`git add tracked.txt && git -c user.name=Test -c user.email=test@example.invalid commit -m init`
				.cwd(dir)
				.quiet();
			const localEmail = await $`git config --local --get user.email`.cwd(dir).quiet().nothrow();
			const localName = await $`git config --local --get user.name`.cwd(dir).quiet().nothrow();
			expect(localEmail.exitCode).not.toBe(0);
			expect(localName.exitCode).not.toBe(0);
			await $`git worktree add -q -b sync ${worktreeDir}`.cwd(dir).quiet();
			await $`git worktree lock ${worktreeDir}`.cwd(dir).quiet();

			await removeSyncWorktree(worktreeDir, dir);

			expect(await Bun.file(worktreeDir).exists()).toBe(false);
			expect((await $`git worktree list --porcelain`.cwd(dir).quiet()).text()).not.toContain(worktreeDir);
		} finally {
			await $`git worktree remove --force --force ${worktreeDir}`.cwd(dir).quiet().nothrow();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("clears a stale unregistered directory but refuses one holding a .git entry", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-stale-dir-"));
		const staleDir = path.join(dir, "sync");
		try {
			// Missing path is a no-op.
			await clearStaleWorktreeDirectory(staleDir);

			// Leftover junk (e.g. a recreated .omp/) is removed.
			await fs.mkdir(path.join(staleDir, ".omp"), { recursive: true });
			await clearStaleWorktreeDirectory(staleDir);
			await expect(fs.stat(staleDir)).rejects.toMatchObject({ code: "ENOENT" });

			// A directory with a .git entry is never clobbered.
			await fs.mkdir(staleDir, { recursive: true });
			await Bun.write(path.join(staleDir, ".git"), "gitdir: elsewhere");
			await expect(clearStaleWorktreeDirectory(staleDir)).rejects.toThrow(/not a registered worktree/);
			expect(await Bun.file(path.join(staleDir, ".git")).text()).toBe("gitdir: elsewhere");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses prepared state when native build leaves dirty tracked files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-dirty-build-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await Bun.write(path.join(dir, "tracked.txt"), "v1");
			await $`git add tracked.txt && git -c user.name=Test -c user.email=test@example.invalid commit -m init`
				.cwd(dir)
				.quiet();

			await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
			await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name: "test-pkg", private: true }));
			await Bun.write(
				path.join(dir, "scripts", "bazel-natives.ts"),
				[
					"const destination = Bun.argv.at(-1);",
					'if (!destination) throw new Error("missing destination");',
					'await Bun.write(destination + "/pi_natives.test.node", "fake-addon");',
					'await Bun.write("tracked.txt", "modified");',
				].join("\n"),
			);

			await expect(prepareWorktree(dir, "17.1.8", "bazel")).rejects.toThrow("working tree not clean");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("processes fork records silently, flags non-record changes, and uses cached test verdicts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-supersession-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			await Bun.write(path.join(dir, "base.txt"), "base");
			await $`git add base.txt && git -c user.name=Test -c user.email=test@example.invalid commit -m init`
				.cwd(dir)
				.quiet();
			await $`git tag upstream/v17.1.6`.cwd(dir).quiet();

			await fs.mkdir(path.join(dir, "docs"), { recursive: true });
			await Bun.write(path.join(dir, "docs", "fork-maintenance.md"), "log");
			await $`git add docs/fork-maintenance.md && git -c user.name=Test -c user.email=test@example.invalid commit -m "docs(fork): sync log for v17.1.6"`
				.cwd(dir)
				.quiet();

			await Bun.write(path.join(dir, "config.example.json"), "{}");
			await $`git add config.example.json && git -c user.name=Test -c user.email=test@example.invalid commit -m "chore(dev): update config example"`
				.cwd(dir)
				.quiet();

			await fs.mkdir(path.join(dir, "test"), { recursive: true });
			await Bun.write(path.join(dir, "test", "foo.test.ts"), "test");
			await $`git add test/foo.test.ts && git -c user.name=Test -c user.email=test@example.invalid commit -m "fix(test): update test"`
				.cwd(dir)
				.quiet();

			await $`git branch sync/v17.1.6`.cwd(dir).quiet();

			const logFormat = "--format=%h\t%p\t%s";
			const log = await $`git log ${logFormat} upstream/v17.1.6..sync/v17.1.6`.cwd(dir).quiet();
			const patches = parseStack(log.text().split("\n"));
			const [forkRec, devPatch, testPatch] = patches;

			const head = (await $`git rev-parse HEAD`.cwd(dir).quiet()).text().trim();
			const progress = await loadProgress(dir, "v17.1.6", head);
			progress.supersessionVerdicts[testPatch.sha] = {
				sha: testPatch.sha,
				subject: testPatch.subject,
				result: "superseded",
				note: `${testPatch.sha} ${testPatch.subject} (SUPERSEDED — tests pass without it on v17.1.6)`,
			};
			const result = await supersessionCheck("v17.1.6", progress, dir);
			expect(result.notes.length).toBe(2);
			expect(result.notes[0]).toContain("no owned tests — manual review");
			expect(result.notes[0]).toContain(devPatch.sha);
			expect(result.notes[1]).toContain("SUPERSEDED");
			expect(result.notes[1]).toContain(testPatch.sha);
			expect(result.supersededShas).toEqual([testPatch.sha]);
			expect(result.notes.some(n => n.includes(forkRec.sha))).toBe(false);

			const loaded = await loadProgress(dir, "v17.1.6", head);
			expect(loaded.supersessionVerdicts[forkRec.sha].result).toBe("retained");
			expect(loaded.supersessionVerdicts[devPatch.sha].result).toBe("manual-review");
			expect(loaded.supersessionVerdicts[testPatch.sha].result).toBe("superseded");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
