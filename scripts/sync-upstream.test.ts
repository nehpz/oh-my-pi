import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	assertCleanTree,
	formatConflictReport,
	normalizeVersion,
	parseStack,
	testFilesOf,
	upstreamTag,
} from "./sync-upstream";

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

describe("assertCleanTree", () => {
	it("allows untracked files but refuses tracked changes with a named error", () => {
		expect(() => assertCleanTree("?? docs/plans/\n")).not.toThrow();
		expect(() => assertCleanTree(" M packages/ai/src/types.ts\n?? scratch.txt\n")).toThrow(/working tree not clean/);
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

describe("status subcommand", () => {
	it("reports setup instructions instead of throwing when no upstream remote exists", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-upstream-status-"));
		try {
			await $`git init -q -b main`.cwd(dir).quiet();
			// Run the real script against a repo with no upstream remote. The script
			// resolves the repo root from its own location, so run it via a copy whose
			// parent is the temp repo.
			await fs.mkdir(path.join(dir, "scripts"));
			await fs.copyFile(
				path.resolve(import.meta.dir, "sync-upstream.ts"),
				path.join(dir, "scripts", "sync-upstream.ts"),
			);
			const res = await $`bun scripts/sync-upstream.ts status`.cwd(dir).quiet().nothrow();
			expect(res.exitCode).toBe(0);
			expect(res.text()).toContain("no 'upstream' remote configured");
			expect(res.text()).toContain("git remote add upstream");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
