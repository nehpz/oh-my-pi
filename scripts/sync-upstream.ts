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
import * as path from "node:path";
import { $ } from "bun";

export const UPSTREAM_URL = "https://github.com/can1357/oh-my-pi.git";
const SERVICE_LABELS = ["com.omp.auth-broker", "com.omp.auth-gateway"] as const;
const GATEWAY_MODELS_URL = "http://127.0.0.1:4000/v1/models";

const repoRoot = path.resolve(import.meta.dir, "..");
const worktreePath = path.resolve(repoRoot, "../oh-my-pi-sync");

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

/** Throws a named error when `git status --porcelain` shows tracked changes. */
export function assertCleanTree(porcelain: string): void {
	const dirty = porcelain.split("\n").filter(l => l.trim() && !l.startsWith("??"));
	if (dirty.length > 0) {
		throw new Error(`working tree not clean:\n${dirty.join("\n")}\ncommit or stash tracked changes before syncing`);
	}
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

// =============================================================================
// Git queries
// =============================================================================

async function hasUpstreamRemote(): Promise<boolean> {
	const res = await git(["remote", "get-url", "upstream"]).quiet().nothrow();
	return res.exitCode === 0;
}

async function ensureUpstreamRemote(): Promise<void> {
	if (!(await hasUpstreamRemote())) {
		console.log(`adding fetch-only 'upstream' remote -> ${UPSTREAM_URL}`);
		await git(["remote", "add", "upstream", UPSTREAM_URL]).quiet();
		await git(["remote", "set-url", "--push", "upstream", "DISABLED"]).quiet();
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
	if (fetch.exitCode !== 0) {
		const exists = await git(["rev-parse", "--verify", `${upstreamTag(version)}^{commit}`])
			.quiet()
			.nothrow();
		if (exists.exitCode !== 0) throw new Error(`failed to fetch ${version} from upstream:\n${fetch.text()}`);
	}
	return { baseTag };
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

async function replant(version: string, baseTag: string): Promise<void> {
	const syncBranch = `sync/${version}`;
	if (await worktreeExists()) {
		console.log(`sync worktree already exists at ${worktreePath} (resuming)`);
	} else {
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
	console.log(`replanting ${stack.length} patch(es) from ${baseTag} onto ${upstreamTag(version)}:`);
	for (const p of stack) console.log(`  ${p.sha} ${p.subject}`);

	const rebase = await $`git rebase --empty=drop --onto ${upstreamTag(version)} ${baseTag} ${syncBranch}`
		.cwd(worktreePath)
		.quiet()
		.nothrow();
	if (rebase.exitCode !== 0) {
		const applied = await stackSince(upstreamTag(version), worktreePath, "HEAD");
		const conflicted = stack[applied.length];
		const remaining = stack.slice(applied.length + 1);
		console.error(formatConflictReport(conflicted ?? { sha: "?", subject: "unknown" }, applied, remaining));
		process.exit(1);
	}
	console.log("replant complete, no conflicts");
}

/** Install deps in the sync worktree and build natives if the addon is absent. */
async function prepareWorktree(): Promise<void> {
	console.log("verify: bun install (worktree)...");
	await $`bun install`.cwd(worktreePath).quiet();
	const nativeDir = path.resolve(worktreePath, "packages/natives/native");
	const hasAddon = (await fs.readdir(nativeDir)).some(f => f.endsWith(".node"));
	if (!hasAddon) {
		console.log("verify: building natives (addon missing in worktree)...");
		await $`bun run build:native`.cwd(worktreePath).quiet();
	}
}

async function supersessionCheck(version: string): Promise<string[]> {
	// Enumerate the REPLANTED stack: verdicts must attribute to the commits
	// that will actually live on main after promotion.
	const stack = await stackSince(upstreamTag(version), worktreePath, `sync/${version}`);
	const flagged: string[] = [];
	const probePath = path.resolve(repoRoot, "../oh-my-pi-supersession-probe");

	for (const patch of stack) {
		const tests = testFilesOf(await changedFilesOf(patch.sha, worktreePath));
		if (tests.length === 0) {
			console.log(`supersession: ${patch.sha} has no owned tests — flagging for manual review`);
			flagged.push(`${patch.sha} ${patch.subject} (no owned tests — manual review)`);
			continue;
		}
		await git(["worktree", "add", "--detach", "--force", probePath, upstreamTag(version)]).quiet();
		try {
			await $`git checkout ${patch.sha} -- ${tests}`.cwd(probePath).quiet();
			await $`bun install --frozen-lockfile`.cwd(probePath).quiet().nothrow();
			// The fork does not patch crates/, so the sync worktree's built addon is
			// valid for the snapshot; copy it instead of rebuilding per probe.
			const nativeDir = path.resolve(worktreePath, "packages/natives/native");
			for (const f of await fs.readdir(nativeDir)) {
				if (f.endsWith(".node")) {
					await fs.copyFile(path.resolve(nativeDir, f), path.resolve(probePath, "packages/natives/native", f));
				}
			}
			const run = await $`bun test ${tests}`.cwd(probePath).quiet().nothrow();
			if (run.exitCode === 0) {
				console.log(`supersession: ${patch.sha} tests PASS on bare ${version} — patch is superseded`);
				flagged.push(`${patch.sha} ${patch.subject} (SUPERSEDED — tests pass without it on ${version})`);
			} else {
				console.log(`supersession: ${patch.sha} still needed (tests fail without it)`);
			}
		} finally {
			await git(["worktree", "remove", "--force", probePath]).quiet().nothrow();
		}
	}
	return flagged;
}

async function verify(version: string): Promise<void> {
	console.log("verify: bun check...");
	await $`bun run check:ts`.cwd(worktreePath).quiet();

	const stack = await stackSince(upstreamTag(version), worktreePath, `sync/${version}`);
	const tests = new Set<string>();
	for (const p of stack) for (const t of testFilesOf(await changedFilesOf(p.sha, worktreePath))) tests.add(t);
	if (tests.size > 0) {
		console.log(`verify: patch tests (${tests.size} file(s))...`);
		await $`bun test ${[...tests]}`.cwd(worktreePath).quiet();
	}

	console.log("verify: smoke probe via worktree entry...");
	await $`bun ${path.resolve(worktreePath, "packages/coding-agent/src/cli.ts")} --smoke-test`
		.cwd(worktreePath)
		.quiet();
	console.log("verification passed");
}

async function promote(version: string): Promise<void> {
	const status = await git(["status", "--porcelain"]).quiet();
	assertCleanTree(status.text());
	const syncHead = (await git(["rev-parse", `refs/heads/sync/${version}`]).quiet()).text().trim();
	console.log(`promoting main -> ${syncHead.slice(0, 9)} (verified sync head)`);
	await git(["worktree", "remove", "--force", worktreePath]).quiet();
	await git(["branch", "-D", `sync/${version}`])
		.quiet()
		.nothrow();
	await git(["reset", "--hard", syncHead]).quiet();
	await git(["push", "--force-with-lease", "origin", "main"]).quiet();
	console.log("verify: bun install (live checkout)...");
	await $`bun install`.cwd(repoRoot).quiet();
}

async function bounceServices(): Promise<void> {
	const uid = process.getuid?.() ?? Number((await $`id -u`.quiet()).text().trim());
	for (const label of SERVICE_LABELS) {
		console.log(`restarting ${label}...`);
		await $`launchctl kickstart -k gui/${uid}/${label}`.quiet().nothrow();
	}
	// KeepAlive respawn takes several seconds; poll up to 30s.
	let health: Response | null = null;
	for (let i = 0; i < 30 && !health?.ok; i++) {
		await Bun.sleep(1000);
		health = await fetch("http://127.0.0.1:4000/healthz").catch(() => null);
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
	const res = await fetch(GATEWAY_MODELS_URL, { headers: { authorization: `Bearer ${token}` } });
	if (!res.ok) throw new Error(`GET /v1/models -> ${res.status}; rollback per docs/fork-maintenance.md`);
	const body = (await res.json()) as { data?: Array<{ id?: string; owned_by?: string; context_length?: unknown }> };
	const data = body.data ?? [];
	// Bare ids legitimately collide across providers; the doubling bug's
	// signature is the same (owned_by, id) pair appearing twice.
	const keys = data.map(m => `${m.owned_by}/${m.id}`);
	if (new Set(keys).size !== keys.length)
		throw new Error("health check: /v1/models contains duplicate provider/id entries");
	if (data.length > 0 && !data.every(m => typeof m.context_length === "number")) {
		throw new Error("health check: /v1/models entries missing numeric context_length");
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
	await git(["push", "--force-with-lease", "origin", "main"]).quiet();
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

async function cmdSync(version: string, dryRun: boolean): Promise<void> {
	if (dryRun) {
		const baseTag = (await resolveBaseTagOf("main")) ?? "<unresolved — bootstrap required>";
		const stack = baseTag.startsWith("upstream/") ? await stackSince(baseTag) : [];
		console.log(`dry run — sync plan for ${version}:`);
		console.log(
			`  1. preflight: clean tree; ensure upstream remote; base = ${baseTag}; fetch ${upstreamTag(version)}`,
		);
		console.log(`  2. snapshot: tag ${preTag(version)} at main`);
		console.log(`  3. replant ${stack.length || "?"} patch(es) onto ${upstreamTag(version)} in ${worktreePath}`);
		for (const p of stack) console.log(`       ${p.sha} ${p.subject}`);
		console.log("  4. supersession: run each patch's tests on the bare snapshot; flag passes");
		console.log("  5. verify (worktree): bun install; bun run check:ts; patch tests; smoke via worktree cli.ts");
		console.log(`  6. promote: reset main to verified sync head; push --force-with-lease; bun install`);
		console.log(`  7. services: kickstart ${SERVICE_LABELS.join(", ")}; /healthz; /v1/models shape`);
		console.log("  8. sync log: append entry to docs/fork-maintenance.md, commit, push");
		return;
	}

	const { baseTag, alreadyBased } = await preflight(version);
	if (alreadyBased) {
		console.log(`fork already based on ${upstreamTag(version)} — running post-promotion checks only`);
		await bounceServices();
		await writeSyncLog(version, (await resolveBaseTagOf(preTag(version))) ?? baseTag, []);
		return;
	}
	await snapshot(version);
	await replant(version, baseTag);
	await prepareWorktree();
	const notes = await supersessionCheck(version);
	await verify(version);
	await promote(version);
	await bounceServices();
	await writeSyncLog(version, baseTag, notes);
	console.log(`sync to ${version} complete`);
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
	const [arg, ...rest] = process.argv.slice(2);
	try {
		if (!arg || arg === "--help" || arg === "-h") {
			console.log("usage: bun scripts/sync-upstream.ts <status | version [--dry-run]>");
		} else if (arg === "status") {
			await cmdStatus();
		} else {
			await cmdSync(normalizeVersion(arg), rest.includes("--dry-run"));
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
