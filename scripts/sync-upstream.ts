#!/usr/bin/env bun
/**
 * Fork upstream sync: replant the fork's patch stack onto a new upstream
 * release snapshot. See docs/fork-maintenance.md for the process and the
 * judgment rules applied when this script stops.
 *
 * Usage:
 *   bun scripts/sync-upstream.ts status
 *   bun scripts/sync-upstream.ts <version> [--dry-run]
 *
 * The script is deliberately mechanical: it never resolves conflicts. On a
 * conflicted replant it prints per-patch state and exits nonzero; the runbook
 * owns what happens next.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { $ } from "bun";
import { LEAF_TARGETS } from "../packages/natives/scripts/gen-npm-packages.ts";

export const UPSTREAM_URL = "https://github.com/can1357/oh-my-pi.git";
const SERVICE_LABELS = ["com.omp.auth-broker", "com.omp.auth-gateway"] as const;
const GATEWAY_MODELS_URL = "http://127.0.0.1:4000/v1/models";

const repoRoot = path.resolve(import.meta.dir, "..");
const worktreePath = path.resolve(repoRoot, "../oh-my-pi-sync");
const NATIVE_RELATIVE_DIR = path.join("packages", "natives", "native");

function git(args: readonly string[], cwd: string = repoRoot) {
	return $`git -c core.fsmonitor=false ${args}`.cwd(cwd);
}

// =============================================================================
// Pure helpers (unit-tested in sync-upstream.test.ts)
// =============================================================================

/** "17.0.8" | "v17.0.8" -> "v17.0.8"; throws on anything else. */
export function normalizeVersion(input: string): string {
	const m = /^v?(\d+\.\d+\.\d+)$/.exec(input.trim());
	if (!m) throw new Error(`invalid version: ${JSON.stringify(input)} (expected e.g. 17.0.8 or v17.0.8)`);
	return `v${m[1]}`;
}
export type NativeMode = "auto" | "npm" | "bazel";
export type ResolvedNativeMode = Exclude<NativeMode, "auto">;

export interface SyncOptions {
	version?: string;
	status: boolean;
	dryRun: boolean;
	verifyOnly: boolean;
	acceptManualReview: boolean;
	help: boolean;
	nativeMode: NativeMode;
}

export function parseArgs(args: readonly string[]): SyncOptions {
	let status = false;
	let dryRun = false;
	let verifyOnly = false;
	let acceptManualReview = false;
	let help = false;
	let version: string | undefined;
	let nativeMode: NativeMode = "auto";

	for (const arg of args) {
		if (arg === "status") status = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--verify-only") verifyOnly = true;
		else if (arg === "--accept-manual-review") acceptManualReview = true;
		else if (arg === "--help" || arg === "-h") help = true;
		else if (arg.startsWith("--native-mode=")) {
			const value = arg.slice("--native-mode=".length);
			if (value !== "auto" && value !== "npm" && value !== "bazel") throw new Error(`invalid native mode: ${value}`);
			nativeMode = value;
		} else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		else {
			if (version !== undefined) throw new Error(`unexpected positional argument: ${arg}`);
			version = normalizeVersion(arg);
		}
	}
	if (status && (version !== undefined || dryRun || verifyOnly || acceptManualReview || nativeMode !== "auto")) {
		throw new Error("status command does not accept a version or sync flags");
	}
	return { version, status, dryRun, verifyOnly, acceptManualReview, help, nativeMode };
}

export const upstreamTag = (v: string) => `upstream/${v}`;
export const preTag = (v: string) => `fork/pre-${v}`;

export interface Patch {
	sha: string;
	subject: string;
}

/**
 * Parse `git log --format='%h%x09%p%x09%s'` lines into the substantive patch
 * list: merge commits (2+ parents) are excluded. Input is newest-first (git
 * log order); output is oldest-first (application order).
 */
export function parseStack(logLines: string[]): Patch[] {
	const patches: Patch[] = [];
	for (const line of logLines) {
		if (!line.trim()) continue;
		const [sha, parents, ...subject] = line.split("\t");
		if (!sha || parents === undefined) continue;
		if (parents.trim().split(/\s+/).filter(Boolean).length > 1) continue; // merge commit
		patches.push({ sha, subject: subject.join("\t") });
	}
	return patches.reverse();
}

/** A version-scoped generated lock refresh is replaced by the target snapshot and rebuilt after replanting. */
export function isGeneratedLockRefreshPatch(patch: Patch, changedFiles: string[]): boolean {
	return (
		/^build\(natives\): refresh Bazel lock for v\d+\.\d+\.\d+$/i.test(patch.subject.trim()) &&
		changedFiles.length === 1 &&
		changedFiles[0] === "MODULE.bazel.lock"
	);
}

export interface NativeImpactInput {
	patch: Patch;
	changedFiles: readonly string[];
}

export interface NativeImpact {
	mode: ResolvedNativeMode;
	reasons: string[];
}

const nativeBuildInputs: Record<string, true> = {
	"BUILD.bazel": true,
	"Cargo.lock": true,
	"Cargo.toml": true,
	"MODULE.bazel": true,
	"MODULE.bazel.lock": true,
};
const nativePackagingInputs: Record<string, true> = {
	"packages/natives/native/desktop.d.ts": true,
	"packages/natives/native/embedded-addon.js": true,
	"packages/natives/native/index.d.ts": true,
	"packages/natives/native/index.js": true,
	"packages/natives/package.json": true,
	"packages/natives/scripts/build-bindings.ts": true,
	"packages/natives/scripts/embed-native.ts": true,
	"packages/natives/scripts/gen-npm-packages.ts": true,
	"scripts/ci-release-publish.ts": true,
};

/** Fail closed for native artifact-contract edits. */
export function classifyNativeContractImpact(inputs: readonly NativeImpactInput[]): NativeImpact {
	const reasons: string[] = [];
	let requiresBazel = false;
	for (const input of inputs) {
		for (const file of input.changedFiles) {
			if (
				nativeBuildInputs[file] === true ||
				nativePackagingInputs[file] === true ||
				file.startsWith("bazel/") ||
				file.startsWith("crates/")
			) {
				reasons.push(`${input.patch.sha}: native artifact contract ${file}`);
				requiresBazel = true;
				break;
			}
		}
	}
	return { mode: requiresBazel ? "bazel" : "npm", reasons };
}

/** Change selected commits from `pick` to `drop` in an interactive rebase todo. */
export function rewriteRebaseTodo(todo: string, droppedShas: readonly string[]): string {
	return todo.replace(/^(\s*)(?:pick|p)(\s+)([0-9a-f]+)(\s+.*)$/gim, (line, indent, spacing, sha, suffix) => {
		const shouldDrop = droppedShas.some(dropped => dropped.startsWith(sha) || sha.startsWith(dropped));
		return shouldDrop ? `${indent}drop${spacing}${sha}${suffix}` : line;
	});
}

/** Returns true if git status --porcelain shows no tracked changes (ignoring untracked ?? lines). */
export function isTrackedClean(porcelain: string): boolean {
	const dirty = porcelain.split("\n").filter(l => l.trim() && !l.startsWith("??"));
	return dirty.length === 0;
}

/** Throws a named error when `git status --porcelain` shows tracked changes. */
export function assertCleanTree(porcelain: string): void {
	if (!isTrackedClean(porcelain)) {
		const dirty = porcelain.split("\n").filter(l => l.trim() && !l.startsWith("??"));
		throw new Error(`working tree not clean:\n${dirty.join("\n")}\ncommit or stash tracked changes before syncing`);
	}
}

/**
 * Null when a repo-local git identity is pinned, else an actionable error message.
 * Fork commits must never pick up ambient (global/includeIf) identity — a local
 * pin always wins, so requiring one makes identity drift impossible.
 */
export function checkLocalIdentityPinned(localName: string, localEmail: string): string | null {
	if (localName && localEmail) return null;
	return [
		"no repo-local git identity pinned; ambient config can leak the wrong identity into fork commits.",
		"pin the fork identity before syncing:",
		"  git config --local user.name <name> && git config --local user.email <email>",
	].join("\n");
}

/** Human-readable conflict report naming the stuck patch. */
export function formatConflictReport(patch: Patch, applied: Patch[], remaining: Patch[]): string {
	const lines = [
		`replant stopped: conflict while applying ${patch.sha} ${patch.subject}`,
		"",
		...applied.map(p => `  applied     ${p.sha} ${p.subject}`),
		`  CONFLICTED  ${patch.sha} ${patch.subject}`,
		...remaining.map(p => `  remaining   ${p.sha} ${p.subject}`),
		"",
		`resolve in the sync worktree (${worktreePath}) per docs/fork-maintenance.md:`,
		"  mechanical drift -> fix markers, `git rebase --continue`, re-run this script",
		"  semantic drift   -> `git rebase --skip`, re-implement from the commit message intent",
	];
	return lines.join("\n");
}

/** Test files owned by a patch (paths under test/ or *.test.ts). */
export function testFilesOf(changedFiles: string[]): string[] {
	return changedFiles.filter(f => /(^|\/)test\//.test(f) || f.endsWith(".test.ts"));
}

/** Addon filenames the published npm leaf must ship for a platform tag (mirrors gen-npm-packages). */
export function expectedAddonFilenames(tag: string): string[] {
	return tag.endsWith("-x64")
		? [`pi_natives.${tag}-baseline.node`, `pi_natives.${tag}-modern.node`, `pi_natives.${tag}.node`]
		: [`pi_natives.${tag}.node`];
}

export const RETAINED_LEDGER_RELATIVE = "scripts/sync-upstream-retained.json";

export interface RetainedLedgerEntry {
	subject: string;
	reason: string;
	date: string;
}

export type RetainedLedger = Record<string, RetainedLedgerEntry>;

export type NoTestsPatchVerdict = "fork-record" | "ledger-retained" | "manual-review";

export type NpmNativeAcquisitionAction = "fallback" | "rethrow";

/** Check if a file is a documentation, gitignore, or fork record file. */
export function isRecordFile(filePath: string): boolean {
	const p = filePath.trim();
	return (
		p.startsWith("docs/") ||
		p.startsWith(".omp/") ||
		p.startsWith(".compound-engineering/") ||
		p.endsWith(".md") ||
		p === ".gitignore" ||
		p === RETAINED_LEDGER_RELATIVE
	);
}

/** Check if a patch is a pure fork record: every changed file is record-only (docs/markdown/config records). Subject prefix is irrelevant — record-only diffs cannot be superseded by upstream code, so they never need manual review. */
export function isForkRecordPatch(changedFiles: string[]): boolean {
	return changedFiles.length > 0 && changedFiles.every(isRecordFile);
}

/** Decide how a no-owned-tests patch should be treated given the retained ledger. */
export function classifyNoTestsPatch(
	changedFiles: string[],
	patchId: string,
	ledger: RetainedLedger,
): NoTestsPatchVerdict {
	if (isForkRecordPatch(changedFiles)) return "fork-record";
	if (patchId && ledger[patchId]) return "ledger-retained";
	return "manual-review";
}

/**
 * npm leaf acquisition can 404 when publish lags the git tag; those errors
 * fall back to a bazel-built native. Unrelated failures must not be swallowed.
 */
export function classifyNpmNativeAcquisitionError(err: unknown): NpmNativeAcquisitionAction {
	// Bun ShellError carries a fixed message ("Failed with exit code 1"); the
	// registry diagnostics live in .stderr/.stdout, so classify over all of them.
	const parts = [err instanceof Error ? err.message : String(err)];
	if (err && typeof err === "object") {
		const shell = err as { stderr?: { toString(): string }; stdout?: { toString(): string } };
		if (shell.stderr) parts.push(shell.stderr.toString());
		if (shell.stdout) parts.push(shell.stdout.toString());
	}
	const msg = parts.join("\n");
	if (
		/\b404\b/.test(msg) ||
		/\bE404\b/i.test(msg) ||
		/not found/i.test(msg) ||
		/failed to resolve/i.test(msg) ||
		/no matching version/i.test(msg) ||
		/version not found/i.test(msg) ||
		/publish lags/i.test(msg)
	) {
		return "fallback";
	}
	return "rethrow";
}

function parseRetainedLedger(raw: string): RetainedLedger {
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	return parsed as RetainedLedger;
}

export async function loadRetainedLedger(root: string): Promise<RetainedLedger> {
	try {
		return parseRetainedLedger(await Bun.file(path.resolve(root, RETAINED_LEDGER_RELATIVE)).text());
	} catch (err) {
		if (isEnoent(err)) return {};
		throw err;
	}
}

/**
 * Ledger as committed on HEAD. Classification must use this, not the working
 * tree: a run killed between saveRetainedLedger and its git commit would
 * otherwise suppress the manual-review gate on resume and the uncommitted
 * acceptance would never reach main.
 */
export async function loadCommittedRetainedLedger(worktreeDir: string): Promise<RetainedLedger> {
	const out = await git(["show", `HEAD:${RETAINED_LEDGER_RELATIVE}`], worktreeDir)
		.quiet()
		.nothrow();
	if (out.exitCode !== 0) return {};
	return parseRetainedLedger(out.text());
}

export async function saveRetainedLedger(root: string, ledger: RetainedLedger): Promise<void> {
	const ledgerPath = path.resolve(root, RETAINED_LEDGER_RELATIVE);
	const tmpPath = `${ledgerPath}.tmp.${crypto.randomUUID()}`;
	try {
		await Bun.write(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`);
		await fs.rename(tmpPath, ledgerPath);
	} finally {
		await fs.rm(tmpPath, { force: true }).catch(() => {});
	}
}

export async function stablePatchId(sha: string, cwd: string): Promise<string> {
	const out = await $`git -c core.fsmonitor=false diff-tree -p ${sha} | git patch-id --stable`.cwd(cwd).quiet();
	const id = out.text().trim().split(/\s+/)[0];
	if (!id) throw new Error(`could not compute stable patch-id for ${sha}`);
	return id;
}

export interface SupersessionVerdict {
	sha: string;
	subject: string;
	result: "retained" | "superseded" | "manual-review";
	note: string;
	patchId?: string;
}

export interface PreparationEvidence {
	version: string;
	head: string;
	mode: ResolvedNativeMode;
	platform: string;
	leafName: string;
	leafVersion: string;
	addonFiles: string[];
	verified: boolean;
	sourceRoot?: string;
}
export interface SyncProgress {
	version: string;
	head: string;
	preparation?: PreparationEvidence;
	supersessionVerdicts: Record<string, SupersessionVerdict>;
	verified: boolean;
}
export function getProgressPath(worktreeDir: string = worktreePath): string {
	return path.resolve(worktreeDir, ".sync-upstream-progress.json");
}

export async function loadProgress(worktreeDir: string, version: string, head: string): Promise<SyncProgress> {
	const progressPath = getProgressPath(worktreeDir);
	try {
		const raw = await Bun.file(progressPath).text();
		const parsed = JSON.parse(raw) as SyncProgress;
		if (
			parsed &&
			typeof parsed === "object" &&
			parsed.version === version &&
			parsed.head === head &&
			typeof parsed.verified === "boolean" &&
			parsed.supersessionVerdicts &&
			typeof parsed.supersessionVerdicts === "object" &&
			((parsed.preparation === undefined && parsed.verified === false) ||
				(typeof parsed.preparation === "object" &&
					parsed.preparation.version === version &&
					parsed.preparation.head === head &&
					(parsed.preparation.mode === "npm" || parsed.preparation.mode === "bazel") &&
					typeof parsed.preparation.platform === "string" &&
					typeof parsed.preparation.leafName === "string" &&
					typeof parsed.preparation.leafVersion === "string" &&
					Array.isArray(parsed.preparation.addonFiles) &&
					parsed.preparation.addonFiles.length > 0 &&
					parsed.preparation.verified === true))
		)
			return parsed;
	} catch (err) {
		if (!isEnoent(err) && !(err instanceof SyntaxError)) throw err;
	}
	return { version, head, supersessionVerdicts: {}, verified: false };
}

export async function saveProgress(worktreeDir: string, progress: SyncProgress): Promise<void> {
	const progressPath = getProgressPath(worktreeDir);
	const tmpPath = path.resolve(worktreeDir, `.sync-upstream-progress.json.tmp.${crypto.randomUUID()}`);
	const content = JSON.stringify(progress, null, 2);
	try {
		await Bun.write(tmpPath, content);
		await fs.rename(tmpPath, progressPath);
	} finally {
		await fs.rm(tmpPath, { force: true }).catch(() => {});
	}
}

export async function hasNativeAddon(root: string = worktreePath): Promise<boolean> {
	const nativeDir = path.resolve(root, NATIVE_RELATIVE_DIR);
	try {
		const entries = await fs.readdir(nativeDir, { withFileTypes: true });
		return entries.some(entry => entry.isFile() && entry.name.endsWith(".node"));
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/** Remove Bazel's convenience symlinks so Bun does not rediscover tests through the execroot or output trees. */
export async function removeBazelWorkspaceSymlink(root: string): Promise<void> {
	const symlinkNames = [`bazel-${path.basename(root)}`, "bazel-bin", "bazel-out", "bazel-testlogs"];
	await Promise.all(
		symlinkNames.map(async name => {
			const symlinkPath = path.resolve(root, name);
			try {
				const entry = await fs.lstat(symlinkPath);
				if (entry.isSymbolicLink()) await fs.unlink(symlinkPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}),
	);
}

async function hasUpstreamRemote(): Promise<boolean> {
	const fetchUrl = await git(["remote", "get-url", "upstream"]).quiet().nothrow();
	const pushUrl = await git(["remote", "get-url", "--push", "upstream"]).quiet().nothrow();
	return (
		fetchUrl.exitCode === 0 &&
		pushUrl.exitCode === 0 &&
		fetchUrl.text().trim() === UPSTREAM_URL &&
		pushUrl.text().trim() === "DISABLED"
	);
}

async function ensureUpstreamRemote(): Promise<void> {
	const fetchUrl = await git(["remote", "get-url", "upstream"]).quiet().nothrow();
	if (fetchUrl.exitCode !== 0) {
		console.log(`adding fetch-only 'upstream' remote -> ${UPSTREAM_URL}`);
		await git(["remote", "add", "upstream", UPSTREAM_URL]).quiet();
		await git(["remote", "set-url", "--push", "upstream", "DISABLED"]).quiet();
		return;
	}
	const pushUrl = await git(["remote", "get-url", "--push", "upstream"]).quiet().nothrow();
	if (fetchUrl.text().trim() !== UPSTREAM_URL || pushUrl.exitCode !== 0 || pushUrl.text().trim() !== "DISABLED") {
		throw new Error(
			`upstream remote must be fetch ${UPSTREAM_URL} with disabled push URL; found fetch ${fetchUrl.text().trim()} and push ${pushUrl.text().trim()}`,
		);
	}
}

/** Newest upstream/v* tag that is an ancestor of `ref`. */
async function resolveBaseTagOf(ref: string): Promise<string | null> {
	const res = await git(["tag", "-l", "upstream/v*", "--sort=-v:refname"]).quiet().nothrow();
	if (res.exitCode !== 0) return null;
	for (const tag of res
		.text()
		.split("\n")
		.map(t => t.trim())
		.filter(Boolean)) {
		const anc = await git(["merge-base", "--is-ancestor", tag, ref]).quiet().nothrow();
		if (anc.exitCode === 0) return tag;
	}
	return null;
}

async function stackSince(base: string, cwd: string = repoRoot, head = "main"): Promise<Patch[]> {
	const res = await git(["log", "--format=%h\t%p\t%s", `${base}..${head}`], cwd).quiet();
	return parseStack(res.text().split("\n"));
}

async function changedFilesOf(sha: string, cwd: string = repoRoot): Promise<string[]> {
	const res = await git(["show", "--format=", "--name-only", sha], cwd).quiet();
	return res
		.text()
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
}

// =============================================================================
// Phases
// =============================================================================

async function preflight(version: string): Promise<{ baseTag: string; alreadyBased: boolean }> {
	const status = await git(["status", "--porcelain"]).quiet();
	assertCleanTree(status.text());

	const localName = (await git(["config", "--local", "user.name"]).quiet().nothrow()).text().trim();
	const localEmail = (await git(["config", "--local", "user.email"]).quiet().nothrow()).text().trim();
	const identityError = checkLocalIdentityPinned(localName, localEmail);
	if (identityError) throw new Error(identityError);

	await ensureUpstreamRemote();

	const baseTag = await resolveBaseTagOf("main");
	if (!baseTag) {
		throw new Error(
			[
				"cannot resolve the fork's current base: no upstream/v* tag is an ancestor of main.",
				"bootstrap the base marker first, e.g. for a fork based on v17.0.6:",
				"  git tag upstream/v17.0.6 <base-commit-sha>",
				"the base commit is the upstream release snapshot the current stack sits on",
				"(verify with: git ls-remote https://github.com/can1357/oh-my-pi.git refs/tags/v17.0.6).",
			].join("\n"),
		);
	}
	if (baseTag === upstreamTag(version)) {
		return { baseTag, alreadyBased: true };
	}
	console.log(`fetching ${version} from upstream...`);
	const fetch = await git(["fetch", "--no-tags", "upstream", `refs/tags/${version}:refs/tags/${upstreamTag(version)}`])
		.quiet()
		.nothrow();
	if (fetch.exitCode !== 0) throw new Error(`failed to fetch ${version} from upstream:\n${fetch.text()}`);
	return { baseTag, alreadyBased: false };
}

async function snapshot(version: string): Promise<void> {
	const tag = preTag(version);
	const exists = await git(["rev-parse", "--verify", `refs/tags/${tag}`])
		.quiet()
		.nothrow();
	if (exists.exitCode === 0) {
		console.log(`rollback tag ${tag} already exists (resuming); leaving it in place`);
		return;
	}
	await git(["tag", tag, "main"]).quiet();
	console.log(`tagged rollback point ${tag}`);
}

async function worktreeExists(): Promise<boolean> {
	const res = await git(["worktree", "list", "--porcelain"]).quiet();
	return res.text().includes(`worktree ${worktreePath}`);
}

/** Remove the owned sync worktree even when the host has marked it locked. */
export async function removeSyncWorktree(
	worktreeDir: string = worktreePath,
	repositoryRoot: string = repoRoot,
): Promise<void> {
	await git(["worktree", "remove", "--force", "--force", worktreeDir], repositoryRoot).quiet();
}

/**
 * Remove a leftover directory at the sync worktree path that git no longer
 * registers as a worktree (e.g. recreated by a lingering process after
 * worktree removal). Refuses to clobber anything holding a `.git` entry.
 */
export async function clearStaleWorktreeDirectory(worktreeDir: string = worktreePath): Promise<void> {
	const exists = await fs.stat(worktreeDir).then(
		() => true,
		() => false,
	);
	if (!exists) return;
	const hasGit = await fs.stat(path.resolve(worktreeDir, ".git")).then(
		() => true,
		() => false,
	);
	if (hasGit) {
		throw new Error(
			`${worktreeDir} exists with a .git entry but is not a registered worktree of this repository — inspect and remove it manually, then re-run`,
		);
	}
	console.log(`removing stale directory at ${worktreeDir} (not a registered worktree)`);
	await fs.rm(worktreeDir, { recursive: true, force: true });
}

async function partitionReplantStack(stack: Patch[]): Promise<{ retained: Patch[]; generatedLockRefreshes: Patch[] }> {
	const classified = await Promise.all(
		stack.map(async patch => ({
			patch,
			generatedLockRefresh: isGeneratedLockRefreshPatch(patch, await changedFilesOf(patch.sha)),
		})),
	);
	return {
		retained: classified.filter(item => !item.generatedLockRefresh).map(item => item.patch),
		generatedLockRefreshes: classified.filter(item => item.generatedLockRefresh).map(item => item.patch),
	};
}

export const REPLANT_REBASE_FLAGS = ["--interactive", "--no-autosquash", "--empty=drop"] as const;

export function sequenceEditorCommand(droppedShas: readonly string[]): string {
	return [
		$.escape(process.execPath),
		$.escape(import.meta.path),
		"__sync_rebase_todo",
		...droppedShas.map(sha => $.escape(sha)),
	].join(" ");
}

async function replant(version: string, baseTag: string): Promise<void> {
	const syncBranch = `sync/${version}`;
	if (await worktreeExists()) {
		console.log(`sync worktree already exists at ${worktreePath} (resuming)`);
	} else {
		await clearStaleWorktreeDirectory();
		await git(["worktree", "add", "-B", syncBranch, worktreePath, "main"]).quiet();
		console.log(`created sync worktree at ${worktreePath} on ${syncBranch}`);
	}

	// If a rebase is already in progress (resume after manual conflict work), don't restart it.
	const rebasing = await $`git rev-parse --git-path rebase-merge`.cwd(worktreePath).quiet();
	const rebaseDir = rebasing.text().trim();
	const inProgress = await Bun.file(path.resolve(worktreePath, rebaseDir, "onto"))
		.exists()
		.catch(() => false);
	if (inProgress) {
		throw new Error(`a rebase is still in progress in ${worktreePath} — finish it (continue/skip) and re-run`);
	}

	const head = await git(["rev-parse", "--verify", `refs/heads/${syncBranch}`])
		.quiet()
		.nothrow();
	const alreadyReplanted =
		head.exitCode === 0 &&
		(
			await git(["merge-base", "--is-ancestor", upstreamTag(version), syncBranch])
				.quiet()
				.nothrow()
		).exitCode === 0;
	if (alreadyReplanted) {
		console.log(`${syncBranch} is already based on ${upstreamTag(version)} (resuming)`);
		return;
	}

	const stack = await stackSince(baseTag);
	const { retained, generatedLockRefreshes } = await partitionReplantStack(stack);
	console.log(`replanting ${retained.length} patch(es) from ${baseTag} onto ${upstreamTag(version)}:`);
	for (const p of retained) console.log(`  ${p.sha} ${p.subject}`);
	for (const p of generatedLockRefreshes) {
		console.log(`  dropping generated lock refresh ${p.sha} ${p.subject}`);
	}

	const rebase = await git(
		[
			"-c",
			`sequence.editor=${sequenceEditorCommand(generatedLockRefreshes.map(patch => patch.sha))}`,
			"rebase",
			...REPLANT_REBASE_FLAGS,
			"--onto",
			upstreamTag(version),
			baseTag,
			syncBranch,
		],
		worktreePath,
	)
		.quiet()
		.nothrow();
	if (rebase.exitCode !== 0) {
		const applied = await stackSince(upstreamTag(version), worktreePath, "HEAD");
		const conflicted = retained[applied.length];
		const remaining = retained.slice(applied.length + 1);
		console.error(formatConflictReport(conflicted ?? { sha: "?", subject: "unknown" }, applied, remaining));
		process.exit(1);
	}
	console.log("replant complete, no conflicts");
}

async function nativeAddonFiles(root: string): Promise<string[]> {
	const nativeDir = path.resolve(root, NATIVE_RELATIVE_DIR);
	try {
		return (await fs.readdir(nativeDir, { withFileTypes: true }))
			.filter(entry => entry.isFile() && entry.name.endsWith(".node"))
			.map(entry => entry.name)
			.sort();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

async function copyNativeAddons(
	sourceRoot: string,
	targetRoot: string,
	validate?: () => Promise<void>,
): Promise<number> {
	const sourceDir = path.resolve(sourceRoot, NATIVE_RELATIVE_DIR);
	const targetDir = path.resolve(targetRoot, NATIVE_RELATIVE_DIR);
	const addons = await nativeAddonFiles(sourceRoot);
	if (addons.length === 0) return 0;
	const stagingDir = `${targetDir}.transaction-${crypto.randomUUID()}`;
	const backupDir = `${targetDir}.backup`;
	let backupCreated = false;
	let targetInstalled = false;
	try {
		const targetExists = await fs
			.lstat(targetDir)
			.then(() => true)
			.catch(err => {
				if (isEnoent(err)) return false;
				throw err;
			});
		const backupExists = await fs
			.lstat(backupDir)
			.then(() => true)
			.catch(err => {
				if (isEnoent(err)) return false;
				throw err;
			});
		if (!targetExists && backupExists) await fs.rename(backupDir, targetDir);
		else if (targetExists && backupExists) await fs.rm(backupDir, { recursive: true, force: true });
	} catch (err) {
		throw new Error(
			`cannot recover native addon swap at ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	try {
		await fs.mkdir(path.dirname(targetDir), { recursive: true });
		await fs.cp(targetDir, stagingDir, { recursive: true }).catch(err => {
			if (!isEnoent(err)) throw err;
		});
		await fs.mkdir(stagingDir, { recursive: true });
		for (const entry of await fs.readdir(stagingDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".node")) await fs.rm(path.join(stagingDir, entry.name));
		}
		await Promise.all(addons.map(name => fs.copyFile(path.join(sourceDir, name), path.join(stagingDir, name))));
		const hadTarget = await fs
			.lstat(targetDir)
			.then(() => true)
			.catch(err => {
				if (isEnoent(err)) return false;
				throw err;
			});
		if (hadTarget) {
			await fs.rename(targetDir, backupDir);
			backupCreated = true;
		}
		await fs.rename(stagingDir, targetDir);
		targetInstalled = true;
		await validate?.();
		if (backupCreated) {
			backupCreated = false;
			await fs.rm(backupDir, { recursive: true });
		}
		return addons.length;
	} catch (err) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		if (targetInstalled) {
			await fs.rm(targetDir, { recursive: true, force: true });
		}
		if (backupCreated) {
			try {
				await fs.rename(backupDir, targetDir);
				backupCreated = false;
			} catch (restoreError) {
				throw new AggregateError(
					[err, restoreError],
					`native addon install failed and rollback remains at ${backupDir}`,
				);
			}
		}
		throw err;
	} finally {
		await fs.rm(stagingDir, { recursive: true, force: true });
	}
}

/** Replace the live checkout's addon with the build that passed worktree verification. */
export async function installVerifiedNativeAddon(
	sourceRoot: string,
	targetRoot: string,
	validate?: () => Promise<void>,
): Promise<void> {
	if ((await copyNativeAddons(sourceRoot, targetRoot, validate)) === 0) {
		throw new Error(`verified worktree has no native addon in ${path.resolve(sourceRoot, NATIVE_RELATIVE_DIR)}`);
	}
}

/** Path for version-keyed native addon recovery staging outside the disposable sync worktree. */
export function getStagedNativeAddonPath(version: string, tmpDir: string = os.tmpdir()): string {
	return path.join(tmpDir, `omp-sync-native-${normalizeVersion(version)}`);
}

/** Install a staged verified addon into target root, removing staging on success and preserving it on failure. */
export async function installAndCleanStagedNativeAddon(
	stagedNativeRoot: string,
	targetRoot: string = repoRoot,
): Promise<void> {
	try {
		await installVerifiedNativeAddon(stagedNativeRoot, targetRoot);
	} catch (err) {
		throw new Error(
			`failed to install verified native addon from ${stagedNativeRoot} to live checkout: ${err instanceof Error ? err.message : String(err)}. Staged addon preserved at ${stagedNativeRoot}. Re-run sync to retry installation.`,
		);
	}
	await fs.rm(stagedNativeRoot, { recursive: true, force: true });
}

/** Preserve the verified addon outside the worktree until failure-prone Git promotion completes. */
export async function stageVerifiedNativeAddon(
	sourceRoot: string,
	version: string,
	tmpDir: string = os.tmpdir(),
): Promise<string> {
	const stagedRoot = getStagedNativeAddonPath(version, tmpDir);
	await fs.rm(stagedRoot, { recursive: true, force: true });
	await fs.mkdir(stagedRoot, { recursive: true });
	try {
		await installVerifiedNativeAddon(sourceRoot, stagedRoot);
		return stagedRoot;
	} catch (err) {
		await fs.rm(stagedRoot, { recursive: true, force: true });
		throw err;
	}
}

interface PackageManifestIdentity {
	name?: string;
	version?: string;
	os?: string[];
	cpu?: string[];
}

export interface NativePackageValidation {
	packageVersion: string;
	leafName: string;
	tag: string;
	targetOs: string;
	targetCpu: string;
	coreManifest: PackageManifestIdentity | undefined;
	leafManifest: PackageManifestIdentity;
	addonFiles: readonly string[];
}

/** Reject an acquired package unless its exact identity and host addon filenames match the release contract. */
export function validateAcquiredNativePackage(input: NativePackageValidation): void {
	const exactSingleton = (values: string[] | undefined, expected: string): boolean =>
		values?.length === 1 && values[0] === expected;
	if (
		(input.coreManifest !== undefined &&
			(input.coreManifest.name !== "@oh-my-pi/pi-natives" || input.coreManifest.version !== input.packageVersion)) ||
		input.leafManifest.name !== input.leafName ||
		input.leafManifest.version !== input.packageVersion ||
		!exactSingleton(input.leafManifest.os, input.targetOs) ||
		!exactSingleton(input.leafManifest.cpu, input.targetCpu)
	) {
		throw new Error(`npm native package metadata mismatch for ${input.leafName}@${input.packageVersion}`);
	}
	const expected = expectedAddonFilenames(input.tag);
	if (input.addonFiles.length === 0 || input.addonFiles.some(file => !expected.includes(file))) {
		throw new Error(`npm native leaf has unexpected or missing addon files for ${input.tag}`);
	}
}

/** Install the acquisition scratch package; `nothrow` keeps the registry error for classification. */
async function installAcquisitionDeps(installRoot: string, dependencies: Record<string, string>, nothrow = true) {
	await Bun.write(
		path.join(installRoot, "package.json"),
		JSON.stringify({ name: "omp-sync-native-acquisition", private: true, dependencies }),
	);
	const install = $`bun install --no-save --no-cache --ignore-scripts --registry=https://registry.npmjs.org`
		.cwd(installRoot)
		.quiet();
	return await (nothrow ? install.nothrow() : install);
}

export async function acquireNpmNativeAddon(
	version: string,
	tmpDir: string = os.tmpdir(),
): Promise<PreparationEvidence> {
	const normalized = normalizeVersion(version);
	const packageVersion = normalized.slice(1);
	const tag = `${process.platform}-${process.arch}`;
	const target = LEAF_TARGETS.find(item => item.tag === tag);
	if (!target) throw new Error(`unsupported native platform: ${tag}`);
	const leafName = `@oh-my-pi/pi-natives-${tag}`;
	const installRoot = await fs.mkdtemp(path.join(tmpDir, "omp-sync-npm-"));
	let sourceRoot: string | undefined;
	try {
		// Upstream publishes the platform leaves before the core meta package, so
		// the core can 404 on a fresh tag. The leaf carries the addon; verify core
		// identity when it is published and fall back to leaf-only when it is not.
		const leafOnly = { [leafName]: packageVersion };
		const withCore = { "@oh-my-pi/pi-natives": packageVersion, ...leafOnly };
		if ((await installAcquisitionDeps(installRoot, withCore)).exitCode !== 0) {
			await installAcquisitionDeps(installRoot, leafOnly, false);
		}
		const corePath = path.join(installRoot, "node_modules", "@oh-my-pi", "pi-natives", "package.json");
		let coreManifest: PackageManifestIdentity | undefined;
		try {
			coreManifest = (await Bun.file(corePath).json()) as PackageManifestIdentity;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const leafRoot = path.join(installRoot, "node_modules", leafName);
		const manifest = JSON.parse(
			await Bun.file(path.join(leafRoot, "package.json")).text(),
		) as PackageManifestIdentity;
		const files = (await fs.readdir(leafRoot, { withFileTypes: true }))
			.filter(entry => entry.isFile() && entry.name.endsWith(".node"))
			.map(entry => entry.name)
			.sort();
		validateAcquiredNativePackage({
			packageVersion,
			leafName,
			tag,
			targetOs: target.os,
			targetCpu: target.cpu,
			coreManifest,
			leafManifest: manifest,
			addonFiles: files,
		});
		const acquiredRoot = await fs.mkdtemp(path.join(tmpDir, "omp-sync-native-source-"));
		sourceRoot = acquiredRoot;
		await fs.mkdir(path.resolve(acquiredRoot, NATIVE_RELATIVE_DIR), { recursive: true });
		await Promise.all(
			files.map(file =>
				fs.copyFile(path.join(leafRoot, file), path.resolve(acquiredRoot, NATIVE_RELATIVE_DIR, file)),
			),
		);
		return {
			version: normalized,
			head: "",
			mode: "npm",
			platform: tag,
			leafName,
			leafVersion: packageVersion,
			addonFiles: files,
			verified: false,
			sourceRoot,
		};
	} catch (err) {
		if (sourceRoot) await fs.rm(sourceRoot, { recursive: true, force: true });
		throw err;
	} finally {
		await fs.rm(installRoot, { recursive: true, force: true });
	}
}

/**
 * Map a shipped addon filename to the loader override required to select it.
 * The unsuffixed addon uses ordinary variant detection.
 */
export function nativeVariantForAddonFilename(filename: string): "modern" | "baseline" | undefined {
	if (/-modern\.node$/.test(filename)) return "modern";
	if (/-baseline\.node$/.test(filename)) return "baseline";
	return undefined;
}

/**
 * Smoke-load through the worktree's real loader in a fresh process. A staged
 * source passes a native-directory override to `loadNative`; an installed
 * source imports the public entrypoint and exercises normal resolution.
 */
export async function verifyNativeAddonLoad(worktreeDir: string, addonRoot: string = worktreeDir): Promise<void> {
	const installed = path.resolve(addonRoot) === path.resolve(worktreeDir);
	const addonFiles = await nativeAddonFiles(addonRoot);
	if (addonFiles.length === 0)
		throw new Error(`no native addons found in ${path.resolve(addonRoot, NATIVE_RELATIVE_DIR)}`);
	for (const addonFile of addonFiles) {
		const variant = nativeVariantForAddonFilename(addonFile);
		const expression = installed
			? 'import "./packages/natives/native/index.js";'
			: 'import { loadNative } from "./packages/natives/native/loader-state.js"; loadNative({ nativeDir: process.env.OMP_SYNC_NATIVE_DIR, exclusiveNativeDir: true });';
		const env = { ...process.env, OMP_SYNC_NATIVE_DIR: path.resolve(addonRoot, NATIVE_RELATIVE_DIR) };
		if (variant) env.PI_NATIVE_VARIANT = variant;
		else delete env.PI_NATIVE_VARIANT;
		await $`bun -e ${expression}`.cwd(worktreeDir).env(env).quiet();
	}
}

export async function validatePreparationEvidence(
	worktreeDir: string,
	evidence: PreparationEvidence | undefined,
): Promise<boolean> {
	const platform = `${process.platform}-${process.arch}`;
	const packageVersion = evidence?.version.slice(1);
	if (
		!evidence?.verified ||
		evidence.platform !== platform ||
		evidence.leafVersion !== packageVersion ||
		(evidence.mode === "npm" && evidence.leafName !== `@oh-my-pi/pi-natives-${platform}`) ||
		(evidence.mode === "bazel" && evidence.leafName !== "workspace") ||
		evidence.addonFiles.length === 0
	) {
		return false;
	}
	const actualFiles = await nativeAddonFiles(worktreeDir);
	if (
		actualFiles.length !== evidence.addonFiles.length ||
		!evidence.addonFiles.every((file, index) => file === actualFiles[index])
	)
		return false;
	try {
		await verifyNativeAddonLoad(worktreeDir);
		return true;
	} catch {
		return false;
	}
}

export async function prepareWorktree(
	worktreeDir: string = worktreePath,
	version?: string,
	mode: ResolvedNativeMode = "bazel",
): Promise<PreparationEvidence> {
	if (!version) throw new Error("native preparation requires a release version");
	const normalized = normalizeVersion(version);
	console.log(`verify: native mode ${mode}`);
	await $`bun install --frozen-lockfile`.cwd(worktreeDir).quiet();
	let evidence: PreparationEvidence;
	let sourceRoot: string;
	if (mode === "npm") {
		evidence = await acquireNpmNativeAddon(normalized);
		if (!evidence.sourceRoot) throw new Error("npm acquisition did not produce a source root");
		sourceRoot = evidence.sourceRoot;
	} else {
		sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sync-bazel-source-"));
		try {
			const destination = path.resolve(sourceRoot, NATIVE_RELATIVE_DIR);
			try {
				await $`bun ${path.join(worktreeDir, "scripts", "bazel-natives.ts")} host --dest ${destination}`
					.cwd(worktreeDir)
					.quiet();
			} finally {
				await removeBazelWorkspaceSymlink(worktreeDir);
			}
			evidence = {
				version: normalized,
				head: "",
				mode,
				platform: `${process.platform}-${process.arch}`,
				leafName: "workspace",
				leafVersion: normalized.slice(1),
				addonFiles: await nativeAddonFiles(sourceRoot),
				verified: false,
			};
		} catch (err) {
			await fs.rm(sourceRoot, { recursive: true, force: true });
			throw err;
		}
	}
	try {
		const status = await git(["status", "--porcelain"], worktreeDir).quiet();
		assertCleanTree(status.text());
		if (evidence.addonFiles.length === 0) {
			throw new Error(`native preparation produced no addon for ${evidence.platform}`);
		}
		await verifyNativeAddonLoad(worktreeDir, sourceRoot);
		await installVerifiedNativeAddon(sourceRoot, worktreeDir, () => verifyNativeAddonLoad(worktreeDir));
		evidence.sourceRoot = undefined;
		evidence.verified = true;
		return evidence;
	} finally {
		await fs.rm(sourceRoot, { recursive: true, force: true });
	}
}

export async function supersessionCheck(
	version: string,
	progress?: SyncProgress,
	worktreeDir: string = worktreePath,
): Promise<{ notes: string[]; supersededShas: string[]; manualReview: SupersessionVerdict[] }> {
	if (!progress) {
		const syncHead = (await git(["rev-parse", `refs/heads/sync/${version}`], worktreeDir).quiet()).text().trim();
		progress = await loadProgress(worktreeDir, version, syncHead);
	}
	const stack = await stackSince(upstreamTag(version), worktreeDir, `sync/${version}`);
	const patchesToProbe: Array<{ patch: Patch; tests: string[] }> = [];
	const ledger = await loadCommittedRetainedLedger(worktreeDir);

	for (const patch of stack) {
		const changedFiles = await changedFilesOf(patch.sha, worktreeDir);
		const tests = testFilesOf(changedFiles);

		if (tests.length === 0) {
			if (isForkRecordPatch(changedFiles)) {
				const verdict: SupersessionVerdict = {
					sha: patch.sha,
					subject: patch.subject,
					result: "retained",
					note: `${patch.sha} ${patch.subject} (fork record — retained)`,
				};
				if (!progress.supersessionVerdicts[patch.sha]) {
					console.log(`supersession: ${patch.sha} is a fork record — silently retaining`);
					progress.supersessionVerdicts[patch.sha] = verdict;
					await saveProgress(worktreeDir, progress);
				} else {
					console.log(`supersession: ${patch.sha} (cached: fork record retained)`);
				}
			} else {
				const patchId =
					progress.supersessionVerdicts[patch.sha]?.patchId ?? (await stablePatchId(patch.sha, worktreeDir));
				const kind = classifyNoTestsPatch(changedFiles, patchId, ledger);
				if (kind === "ledger-retained") {
					const reason = ledger[patchId]?.reason ?? "retained";
					const verdict: SupersessionVerdict = {
						sha: patch.sha,
						subject: patch.subject,
						result: "retained",
						note: `${patch.sha} ${patch.subject} (ledger retained: ${reason})`,
						patchId,
					};
					const cached = progress.supersessionVerdicts[patch.sha];
					if (cached?.result !== "retained" || cached.patchId !== patchId) {
						console.log(`supersession: ${patch.sha} is ledger-retained — skipping manual review`);
						progress.supersessionVerdicts[patch.sha] = verdict;
						await saveProgress(worktreeDir, progress);
					} else {
						console.log(`supersession: ${patch.sha} (cached: ledger retained)`);
					}
				} else {
					const note = `${patch.sha} ${patch.subject} (no owned tests — manual review; patch-id ${patchId})`;
					const verdict: SupersessionVerdict = {
						sha: patch.sha,
						subject: patch.subject,
						result: "manual-review",
						note,
						patchId,
					};
					if (!progress.supersessionVerdicts[patch.sha]) {
						console.log(`supersession: ${patch.sha} has no owned tests — flagging for manual review`);
						progress.supersessionVerdicts[patch.sha] = verdict;
						await saveProgress(worktreeDir, progress);
					} else {
						progress.supersessionVerdicts[patch.sha] = {
							...progress.supersessionVerdicts[patch.sha],
							...verdict,
						};
						console.log(`supersession: ${patch.sha} (cached: manual review)`);
					}
				}
			}
		} else {
			const cached = progress.supersessionVerdicts[patch.sha];
			if (cached) {
				if (cached.result === "superseded") {
					console.log(`supersession: ${patch.sha} (cached: SUPERSEDED — tests pass without it)`);
				} else {
					console.log(`supersession: ${patch.sha} (cached: still needed)`);
				}
			} else {
				patchesToProbe.push({ patch, tests });
			}
		}
	}

	if (patchesToProbe.length > 0) {
		const probePath = path.resolve(repoRoot, "../oh-my-pi-supersession-probe");
		await git(["worktree", "remove", "--force", probePath]).quiet().nothrow();
		await fs.rm(probePath, { recursive: true, force: true }).catch(() => {});

		await git(["worktree", "add", "--detach", "--force", probePath, upstreamTag(version)]).quiet();
		let acquiredSourceRoot: string | undefined;
		try {
			console.log("supersession: preparing bare upstream probe environment...");
			await $`bun install --frozen-lockfile`.cwd(probePath).quiet();
			try {
				const acquired = await acquireNpmNativeAddon(version);
				acquiredSourceRoot = acquired.sourceRoot;
				if (!acquiredSourceRoot)
					throw new Error("npm supersession probe acquisition did not produce a source root");
			} catch (err) {
				if (classifyNpmNativeAcquisitionError(err) === "rethrow") throw err;
				// npm publish can lag the upstream git tag; fall back to building the
				// tag's own natives from source, mirroring bazel-mode preparation.
				console.log(
					`supersession: npm natives for ${version} unavailable (${err instanceof Error ? err.message : String(err)}); building from probe source via bazel`,
				);
				acquiredSourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sync-bazel-source-"));
				const destination = path.resolve(acquiredSourceRoot, NATIVE_RELATIVE_DIR);
				try {
					await $`bun ${path.join(probePath, "scripts", "bazel-natives.ts")} host --dest ${destination}`
						.cwd(probePath)
						.quiet();
				} finally {
					await removeBazelWorkspaceSymlink(probePath);
				}
			}
			await installVerifiedNativeAddon(acquiredSourceRoot, probePath);
			for (const { patch, tests } of patchesToProbe) {
				await git(["reset", "--hard", upstreamTag(version)], probePath).quiet();
				await git(["clean", "-fd"], probePath).quiet();

				await $`git checkout ${patch.sha} -- ${tests}`.cwd(probePath).quiet();

				const run = await $`bun test ${tests}`.cwd(probePath).quiet().nothrow();
				if (run.exitCode === 0) {
					console.log(`supersession: ${patch.sha} tests PASS on bare ${version} — patch is superseded`);
					const note = `${patch.sha} ${patch.subject} (SUPERSEDED — tests pass without it on ${version})`;
					const verdict: SupersessionVerdict = {
						sha: patch.sha,
						subject: patch.subject,
						result: "superseded",
						note,
					};
					progress.supersessionVerdicts[patch.sha] = verdict;
					await saveProgress(worktreeDir, progress);
				} else {
					console.log(`supersession: ${patch.sha} still needed (tests fail without it)`);
					const verdict: SupersessionVerdict = {
						sha: patch.sha,
						subject: patch.subject,
						result: "retained",
						note: `${patch.sha} still needed (tests fail without it)`,
					};
					progress.supersessionVerdicts[patch.sha] = verdict;
					await saveProgress(worktreeDir, progress);
				}
			}
		} finally {
			if (acquiredSourceRoot) await fs.rm(acquiredSourceRoot, { recursive: true, force: true });
			await git(["worktree", "remove", "--force", probePath]).quiet().nothrow();
		}
	}

	const notes: string[] = [];
	const supersededShas: string[] = [];
	const manualReview: SupersessionVerdict[] = [];
	for (const p of stack) {
		const verdict = progress.supersessionVerdicts[p.sha];
		if (verdict?.result === "superseded") {
			notes.push(verdict.note);
			supersededShas.push(verdict.sha);
		} else if (verdict?.result === "manual-review") {
			notes.push(verdict.note);
			manualReview.push(verdict);
		}
	}
	return { notes, supersededShas, manualReview };
}

async function dropSupersededCommits(version: string, shas: readonly string[]): Promise<void> {
	if (shas.length === 0) return;
	const result = await git(
		[
			"-c",
			`sequence.editor=${sequenceEditorCommand(shas)}`,
			"rebase",
			...REPLANT_REBASE_FLAGS,
			upstreamTag(version),
			`sync/${version}`,
		],
		worktreePath,
	)
		.quiet()
		.nothrow();
	if (result.exitCode !== 0) throw new Error(`failed to drop superseded commits:\n${result.text()}`);
}

async function recordManualReviewAcceptances(
	worktreeDir: string,
	flagged: readonly SupersessionVerdict[],
): Promise<void> {
	const ledger = await loadRetainedLedger(worktreeDir);
	const date = new Date().toISOString().slice(0, 10);
	for (const verdict of flagged) {
		const patchId = verdict.patchId ?? (await stablePatchId(verdict.sha, worktreeDir));
		ledger[patchId] = {
			subject: verdict.subject,
			reason: "accepted via --accept-manual-review",
			date,
		};
	}
	await saveRetainedLedger(worktreeDir, ledger);
	await git(["add", RETAINED_LEDGER_RELATIVE], worktreeDir).quiet();
	const staged = await git(["status", "--porcelain", "--", RETAINED_LEDGER_RELATIVE], worktreeDir).quiet();
	if (!staged.text().trim()) return;
	await git(["commit", "-m", "chore(fork): record manual-review acceptances"], worktreeDir).quiet();
}

interface VerificationCommandResult {
	exitCode: number;
	stdout: { toString(): string };
	stderr: { toString(): string };
}

function assertVerificationCommandSucceeded(label: string, result: VerificationCommandResult): void {
	if (result.exitCode === 0) return;
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	throw new Error(`${label} failed with exit code ${result.exitCode}${output ? `:\n${output}` : ""}`);
}

export async function verify(version: string, worktreeDir: string = worktreePath): Promise<void> {
	console.log("verify: bun check...");
	const check = await $`bun check`.cwd(worktreeDir).quiet().nothrow();
	assertVerificationCommandSucceeded("verify: bun check", check);
	const stack = await stackSince(upstreamTag(version), worktreeDir, `sync/${version}`);
	const tests = new Set<string>();
	for (const p of stack) for (const t of testFilesOf(await changedFilesOf(p.sha, worktreeDir))) tests.add(t);
	const selectedTests = [...tests];
	for (const testPath of selectedTests) {
		if (!(await Bun.file(path.resolve(worktreeDir, testPath)).exists())) {
			throw new Error(`selected patch test path is missing: ${testPath}`);
		}
	}
	if (selectedTests.length > 0) {
		console.log(`verify: patch tests (${selectedTests.length} file(s))...`);
		const patchTests = await $`bun test ${selectedTests}`.cwd(worktreeDir).quiet().nothrow();
		assertVerificationCommandSucceeded("verify: patch tests", patchTests);
	}
	console.log("verify: smoke probe via worktree entry...");

	const smoke = await $`bun ${path.resolve(worktreeDir, "packages/coding-agent/src/cli.ts")} --smoke-test`
		.cwd(worktreeDir)
		.quiet()
		.nothrow();
	assertVerificationCommandSucceeded("verify: smoke probe", smoke);
	console.log("verification passed");
}

async function promote(version: string): Promise<void> {
	const status = await git(["status", "--porcelain"]).quiet();
	assertCleanTree(status.text());
	const originMainSha = (await git(["ls-remote", "origin", "refs/heads/main"]).quiet()).text().trim().split(/\s+/)[0];
	if (!originMainSha) throw new Error("cannot resolve origin/main before promotion");
	const syncHead = (await git(["rev-parse", `refs/heads/sync/${version}`]).quiet()).text().trim();
	const stagedNativeRoot = await stageVerifiedNativeAddon(worktreePath, version);
	let rollbackNativeRoot: string;
	try {
		rollbackNativeRoot = await stageVerifiedNativeAddon(
			repoRoot,
			version,
			path.join(os.tmpdir(), "omp-sync-rollback"),
		);
	} catch (err) {
		await fs.rm(stagedNativeRoot, { recursive: true, force: true });
		throw err;
	}
	console.log(`promoting main ${originMainSha.slice(0, 9)} -> ${syncHead.slice(0, 9)} (verified sync head)`);
	await removeSyncWorktree();
	try {
		await git(["reset", "--hard", syncHead]).quiet();
		console.log("promoting verified native addon to live checkout...");
		await installAndCleanStagedNativeAddon(stagedNativeRoot, repoRoot);
		await git(["push", `--force-with-lease=refs/heads/main:${originMainSha}`, "origin", "main"]).quiet();
	} catch (err) {
		await git(["reset", "--hard", `refs/tags/${preTag(version)}`])
			.quiet()
			.nothrow();
		try {
			await installAndCleanStagedNativeAddon(rollbackNativeRoot, repoRoot);
		} catch (rollbackError) {
			throw new AggregateError([err, rollbackError], "promotion failed and native addon rollback also failed");
		}
		throw err;
	}
	await fs.rm(rollbackNativeRoot, { recursive: true, force: true });
	await git(["branch", "-D", `sync/${version}`])
		.quiet()
		.nothrow();
	console.log("verify: bun install (live checkout)...");
	await $`bun install`.cwd(repoRoot).quiet();
}
async function bounceServices(): Promise<void> {
	const uid = process.getuid?.() ?? Number((await $`id -u`.quiet()).text().trim());
	for (const label of SERVICE_LABELS) {
		console.log(`restarting ${label}...`);
		await $`launchctl kickstart -k gui/${uid}/${label}`.quiet();
	}
	// KeepAlive respawn takes several seconds; poll up to 30s.
	let health: Response | null = null;
	for (let i = 0; i < 30 && !health?.ok; i++) {
		await Bun.sleep(1000);
		health = await fetch("http://127.0.0.1:4000/healthz", { signal: AbortSignal.timeout(1500) }).catch(() => null);
	}
	if (!health?.ok) {
		throw new Error(
			`gateway /healthz not responding within 30s of restart (${health ? health.status : "no connection"}); rollback per docs/fork-maintenance.md`,
		);
	}

	// Credential-level status is informational only: `check --strict` exits
	// nonzero on account quota/probe issues unrelated to the sync.
	const check = await $`${path.resolve(repoRoot, "packages/coding-agent/scripts/omp")} auth-gateway check`
		.quiet()
		.nothrow();
	console.log(check.text().split("\n").slice(-2).join("\n"));

	const token = (await $`${path.resolve(repoRoot, "packages/coding-agent/scripts/omp")} auth-gateway token`.quiet())
		.text()
		.trim();
	const res = await fetch(GATEWAY_MODELS_URL, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`GET /v1/models -> ${res.status}; rollback per docs/fork-maintenance.md`);
	const body = (await res.json()) as {
		data?: Array<{ id?: string; owned_by?: string; context_length?: number | null }>;
	};
	const data = body.data ?? [];
	// Bare ids legitimately collide across providers; the doubling bug's
	// signature is the same (owned_by, id) pair appearing twice.
	const keys = data.map(m => `${m.owned_by}/${m.id}`);
	if (new Set(keys).size !== keys.length)
		throw new Error("health check: /v1/models contains duplicate provider/id entries");
	if (
		data.length > 0 &&
		!data.every(m => "context_length" in m && (typeof m.context_length === "number" || m.context_length === null))
	) {
		throw new Error("health check: /v1/models entries missing context_length");
	}
	console.log(`services healthy: ${data.length} model(s), unique ids, context_length present`);
}

async function writeSyncLog(version: string, baseTag: string, notes: string[]): Promise<void> {
	const logPath = path.resolve(repoRoot, "docs/fork-maintenance.md");
	if ((await Bun.file(logPath).text()).includes(`→ ${version}`)) {
		console.log(`sync log for ${version} already recorded`);
		return;
	}
	const stack = await stackSince(upstreamTag(version));
	const date = new Date().toISOString().slice(0, 10);
	const entry = [
		"",
		`### ${date} — ${baseTag.replace("upstream/", "")} → ${version}`,
		"",
		...stack.map(p => `- kept ${p.sha} ${p.subject}`),
		...notes.map(n => `- note: ${n}`),
	].join("\n");

	const doc = await Bun.file(logPath).text();
	const marker = "<!-- Appended by scripts/sync-upstream.ts; newest first. -->";
	if (!doc.includes(marker)) throw new Error(`sync log marker missing from ${logPath}`);
	await Bun.write(logPath, doc.replace(marker, `${marker}\n${entry}`));
	await git(["add", "docs/fork-maintenance.md"]).quiet();
	await git(["commit", "-m", `chore(fork): sync log for ${version}`]).quiet();
	await git(["push", "origin", "main"]).quiet();
	console.log(`sync log recorded for ${version}`);
}

// =============================================================================
// Subcommands
// =============================================================================

async function cmdStatus(): Promise<void> {
	if (!(await hasUpstreamRemote())) {
		console.log(
			`no 'upstream' remote configured. set it up with:\n  git remote add upstream ${UPSTREAM_URL}\n(or run a sync — preflight adds it automatically)`,
		);
		return;
	}
	const baseTag = await resolveBaseTagOf("main");
	if (!baseTag) {
		console.log("no upstream/v* base tag is an ancestor of main — bootstrap one per docs/fork-maintenance.md");
		return;
	}
	console.log(`current base: ${baseTag}`);
	const stack = await stackSince(baseTag);
	console.log(`fork stack (${stack.length} patch(es)):`);
	for (const p of stack) console.log(`  ${p.sha} ${p.subject}`);
	if (await worktreeExists()) {
		const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath).quiet().nothrow()).text().trim();
		const match = /^sync\/(v\d+\.\d+\.\d+)$/.exec(branch);
		if (match) {
			const syncVersion = match[1];
			const syncHead = (await git(["rev-parse", "HEAD"], worktreePath).quiet()).text().trim();
			const progress = await loadProgress(worktreePath, syncVersion, syncHead);
			console.log(`sync worktree: ${worktreePath}`);
			console.log(
				`progress: version ${syncVersion}, mode ${progress.preparation?.mode ?? "unprepared"}, prepared ${Boolean(progress.preparation?.verified)}, verified ${progress.verified}`,
			);
			if (await Bun.file(getProgressPath(worktreePath)).exists()) {
				console.log(`resume: bun scripts/sync-upstream.ts ${syncVersion}`);
			}
		}
	}

	const remote = await git(["ls-remote", "--tags", "upstream", "refs/tags/v*"]).quiet().nothrow();
	if (remote.exitCode === 0) {
		const current = baseTag.replace("upstream/", "");
		const tags = remote
			.text()
			.split("\n")
			.map(l => l.split("\t")[1]?.replace("refs/tags/", "").replace("^{}", ""))
			.filter((t): t is string => !!t && /^v\d+\.\d+\.\d+$/.test(t))
			.filter((t, i, a) => a.indexOf(t) === i)
			.sort((a, b) => Bun.semver.order(a.slice(1), b.slice(1)));
		const pending = tags.filter(t => Bun.semver.order(t.slice(1), current.slice(1)) > 0);
		console.log(
			pending.length > 0 ? `pending upstream releases: ${pending.join(", ")}` : "up to date with upstream releases",
		);
	}
}

async function cmdSync(
	version: string,
	dryRun: boolean,
	verifyOnly: boolean = false,
	requestedMode: NativeMode = "auto",
	acceptManualReview = false,
): Promise<void> {
	if (dryRun) {
		const baseTag = (await resolveBaseTagOf("main")) ?? "<unresolved — bootstrap required>";
		const partition = baseTag.startsWith("upstream/") ? await partitionReplantStack(await stackSince(baseTag)) : null;
		console.log(`dry run — sync plan for ${version}${verifyOnly ? " (--verify-only)" : ""}:`);
		console.log(
			`  1. preflight: clean tree; ensure upstream remote; base = ${baseTag}; fetch ${upstreamTag(version)}`,
		);
		console.log(`  2. snapshot: tag ${preTag(version)} at main`);
		const retained = partition?.retained ?? [];
		const count = partition ? retained.length : "?";
		console.log(`  3. replant ${count} patch(es) onto ${upstreamTag(version)} in ${worktreePath}`);
		for (const p of retained) console.log(`       ${p.sha} ${p.subject}`);
		for (const p of partition?.generatedLockRefreshes ?? []) {
			console.log(`       drop ${p.sha} ${p.subject} (generated lock refresh)`);
		}
		console.log(
			"  4. prepare: classify native impact; acquire exact npm leaf or build an isolated Bazel output; load it",
		);
		console.log("  6. verify (worktree): bun check; patch tests; smoke via worktree cli.ts");
		if (verifyOnly) {
			console.log("  7. return early before promotion (--verify-only, checkpoints saved)");
			return;
		}
		console.log(`  7. promote: exact confirmation then push --force-with-lease; bun install`);
		console.log(`  8. services: kickstart ${SERVICE_LABELS.join(", ")}; /healthz; /v1/models shape`);
		console.log("  9. sync log: append entry to docs/fork-maintenance.md, commit, push");
		return;
	}

	const { baseTag, alreadyBased } = await preflight(version);
	if (alreadyBased && verifyOnly) {
		console.log(`fork already based on ${upstreamTag(version)} — no pending sync to verify`);
		return;
	}
	if (alreadyBased) {
		console.log(`fork already based on ${upstreamTag(version)} — running post-promotion checks only`);
		const stagedNativeRoot = getStagedNativeAddonPath(version);
		if (await hasNativeAddon(stagedNativeRoot)) {
			console.log("promoting preserved verified native addon to live checkout...");
			await installAndCleanStagedNativeAddon(stagedNativeRoot, repoRoot);
		}
		await $`bun install`.cwd(repoRoot).quiet();
		await bounceServices();
		await writeSyncLog(version, (await resolveBaseTagOf(preTag(version))) ?? baseTag, []);
		return;
	}
	await snapshot(version);
	await replant(version, baseTag);
	let syncHead = (await git(["rev-parse", `refs/heads/sync/${version}`]).quiet()).text().trim();
	let progress = await loadProgress(worktreePath, version, syncHead);
	const supersession = await supersessionCheck(version, progress, worktreePath);
	if (!verifyOnly && supersession.manualReview.length > 0) {
		if (!acceptManualReview) {
			throw new Error(
				"manual review is required before promotion; re-run with --accept-manual-review (acceptance will be recorded in scripts/sync-upstream-retained.json)",
			);
		}
		// Runs BEFORE dropSupersededCommits: a crash-leftover dirty ledger would make
		// the drop rebase refuse; committing here first keeps resume self-healing.
		// Uses the verdicts captured by supersessionCheck — their patch-id keys stay
		// valid across the drop rebase, and the acceptance commit only appends, so
		// the cached verdict shas remain intact.
		await recordManualReviewAcceptances(worktreePath, supersession.manualReview);
		syncHead = (await git(["rev-parse", `refs/heads/sync/${version}`]).quiet()).text().trim();
		progress.head = syncHead;
		await saveProgress(worktreePath, progress);
	}
	if (supersession.supersededShas.length > 0) {
		await dropSupersededCommits(version, supersession.supersededShas);
		syncHead = (await git(["rev-parse", `refs/heads/sync/${version}`]).quiet()).text().trim();
		progress = await loadProgress(worktreePath, version, syncHead);
	}
	const replanted = await stackSince(upstreamTag(version), worktreePath, `sync/${version}`);
	const { retained } = await partitionReplantStack(replanted);
	const impact = classifyNativeContractImpact(
		await Promise.all(
			retained.map(async patch => ({
				patch,
				changedFiles: await changedFilesOf(patch.sha, worktreePath),
			})),
		),
	);
	if (requestedMode === "npm" && impact.mode === "bazel") {
		throw new Error(`--native-mode=npm refused: auto classification requires Bazel (${impact.reasons.join("; ")})`);
	}
	const resolvedMode: ResolvedNativeMode =
		requestedMode === "bazel" || (requestedMode === "auto" && impact.mode === "bazel") ? "bazel" : "npm";
	console.log(`native preparation: ${resolvedMode}${impact.reasons.length ? ` (${impact.reasons.join("; ")})` : ""}`);
	// progress is keyed to the recomputed sync head after supersession drops.

	let prepared =
		progress.preparation?.version === version &&
		progress.preparation.head === syncHead &&
		progress.preparation.mode === resolvedMode &&
		(await validatePreparationEvidence(worktreePath, progress.preparation));
	if (prepared) {
		console.log(`verify: ${resolvedMode} preparation already complete`);
	} else {
		try {
			progress.preparation = await prepareWorktree(worktreePath, version, resolvedMode);
		} catch (err) {
			const retry = `bun scripts/sync-upstream.ts ${version} --native-mode=${resolvedMode}`;
			throw new Error(
				`${resolvedMode} native preparation failed before promotion: ${err instanceof Error ? err.message : String(err)}. Retry with \`${retry}\`; select another producer only with an explicit --native-mode override.`,
			);
		}
		progress.preparation.head = syncHead;
		progress.verified = false;
		await saveProgress(worktreePath, progress);
		prepared = true;
	}

	const notes = supersession.notes;
	const status = await git(["status", "--porcelain"], worktreePath).quiet();
	assertCleanTree(status.text());
	const isClean = isTrackedClean(status.text());
	const canSkipVerify = progress.verified && isClean && prepared;

	if (canSkipVerify) {
		console.log("verify: verification already passed for current HEAD (skipping bun check, tests, smoke)");
	} else {
		if (progress.verified && (!isClean || !prepared)) {
			console.log(
				"verify: working tree dirty or native preparation invalid, invalidating verification checkpoint...",
			);
			progress.verified = false;
		}
		await verify(version, worktreePath);
		progress.verified = true;
		await saveProgress(worktreePath, progress);
	}

	if (verifyOnly) {
		console.log("verification complete (--verify-only): checkpoints saved. Re-run without --verify-only to promote.");
		return;
	}

	await promote(version);
	await bounceServices();
	await writeSyncLog(version, baseTag, notes);
	console.log(`sync to ${version} complete`);
}

// =============================================================================
// Main
// =============================================================================
async function editRebaseTodo(args: readonly string[]): Promise<void> {
	const todoPath = args.at(-1);
	if (!todoPath) throw new Error("missing interactive rebase todo path");
	const todo = await Bun.file(todoPath).text();
	await Bun.write(todoPath, rewriteRebaseTodo(todo, args.slice(0, -1)));
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		if (args[0] === "__sync_rebase_todo") {
			await editRebaseTodo(args.slice(1));
		} else {
			const opts = parseArgs(args);
			if (opts.help || (!opts.status && !opts.version)) {
				console.log(
					"usage: bun scripts/sync-upstream.ts <status | version [--dry-run] [--verify-only] [--accept-manual-review] [--native-mode=auto|npm|bazel]>",
				);
			} else if (opts.status) {
				await cmdStatus();
			} else if (opts.version) {
				await cmdSync(opts.version, opts.dryRun, opts.verifyOnly, opts.nativeMode, opts.acceptManualReview);
			}
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
