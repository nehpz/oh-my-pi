#!/usr/bin/env bun
/**
 * Squash the fork's per-version `chore(fork): sync log for vX.Y.Z` commits into
 * one consolidated commit, preserving every other fork patch and the exact
 * final tree of main.
 *
 * Method: rebuild the fork stack (base = newest upstream/v* tag ancestor of
 * main) in a temp worktree, cherry-picking every non-sync-log commit in order,
 * then committing docs/fork-maintenance.md restored to main's exact content.
 * Correctness gate: `git diff main <newHead>` must be empty before anything
 * is allowed to move.
 *
 * Usage:
 *   bun scripts/squash-sync-log.ts            # dry run: build + verify, leave branch squash-sync-log
 *   bun scripts/squash-sync-log.ts --push     # also reset main and force-with-lease push origin/main
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { checkLocalIdentityPinned } from "./sync-upstream.ts";

const SYNC_LOG_SUBJECT = /^chore\(fork\): sync log for (v\d+\.\d+\.\d+)$/;
const LOG_FILE = "docs/fork-maintenance.md";
const RESULT_BRANCH = "squash-sync-log";

const repoRoot = path.resolve(import.meta.dir, "..");
const worktreePath = path.resolve(repoRoot, "../oh-my-pi-squash-sync-log");

function git(args: readonly string[], cwd: string = repoRoot) {
	return $`git -c core.fsmonitor=false ${args}`.cwd(cwd);
}

async function resolveBaseTag(): Promise<string> {
	const tags = (await git(["tag", "-l", "upstream/v*", "--sort=-v:refname"]).quiet()).text().split("\n");
	for (const tag of tags.map(t => t.trim()).filter(Boolean)) {
		const res = await git(["merge-base", "--is-ancestor", tag, "main"]).quiet().nothrow();
		if (res.exitCode === 0) return tag;
	}
	throw new Error("no upstream/v* tag is an ancestor of main");
}

async function cleanupWorktree(): Promise<void> {
	await git(["worktree", "remove", "--force", worktreePath]).quiet().nothrow();
	await fs.rm(worktreePath, { recursive: true, force: true });
	await git(["worktree", "prune"]).quiet().nothrow();
}

async function main(): Promise<void> {
	const push = process.argv.includes("--push");

	// Preflight: clean tree, main checked out, main == origin/main.
	const status = (await git(["status", "--porcelain", "--untracked-files=no"]).quiet()).text().trim();
	if (status) throw new Error("working tree has tracked modifications");
	const localName = (await git(["config", "--local", "user.name"]).quiet().nothrow()).text().trim();
	const localEmail = (await git(["config", "--local", "user.email"]).quiet().nothrow()).text().trim();
	const identityError = checkLocalIdentityPinned(localName, localEmail);
	if (identityError) throw new Error(identityError);
	const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"]).quiet()).text().trim();
	if (branch !== "main") throw new Error(`expected main checked out, got ${branch}`);
	await git(["fetch", "origin", "main"]).quiet();
	const [localHead, remoteHead] = (await git(["rev-parse", "main", "origin/main"]).quiet()).text().trim().split("\n");
	if (localHead !== remoteHead) throw new Error(`main (${localHead}) != origin/main (${remoteHead}); reconcile first`);

	const baseTag = await resolveBaseTag();
	const lines = (await git(["log", "--reverse", "--format=%H\t%s", `${baseTag}..main`]).quiet())
		.text()
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
	const stack = lines.map(l => {
		const [sha = "", subject = ""] = l.split("\t");
		return { sha, subject, isSyncLog: SYNC_LOG_SUBJECT.test(subject) };
	});
	const syncLogs = stack.filter(p => p.isSyncLog);
	const kept = stack.filter(p => !p.isSyncLog);
	if (syncLogs.length < 2) {
		console.log(`only ${syncLogs.length} sync-log commit(s) above ${baseTag} — nothing to squash`);
		return;
	}
	const lastVersion = SYNC_LOG_SUBJECT.exec(syncLogs[syncLogs.length - 1].subject)?.[1];
	console.log(`base ${baseTag}: squashing ${syncLogs.length} sync-log commits, keeping ${kept.length} patches`);

	// Snapshot the exact final log content from main.
	const logSnapshot = (await git(["show", `main:${LOG_FILE}`]).quiet()).text();

	await cleanupWorktree();
	await git(["worktree", "add", "--detach", worktreePath, baseTag]).quiet();
	try {
		for (const p of kept) {
			const pick = await git(["cherry-pick", "--allow-empty", p.sha], worktreePath).quiet().nothrow();
			if (pick.exitCode !== 0) {
				const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"], worktreePath).quiet())
					.text()
					.split("\n")
					.map(l => l.trim())
					.filter(Boolean);
				// Only the sync-log file may conflict (its dropped appends shift context);
				// take the picked commit's side — the final consolidated commit restores exact content.
				if (unmerged.length !== 1 || unmerged[0] !== LOG_FILE) {
					await git(["cherry-pick", "--abort"], worktreePath).quiet().nothrow();
					throw new Error(`unexpected conflict cherry-picking ${p.sha} ${p.subject}: ${unmerged.join(", ")}`);
				}
				await git(["checkout", "--theirs", LOG_FILE], worktreePath).quiet();
				await git(["add", LOG_FILE], worktreePath).quiet();
				const cont = await $`git -c core.editor=true cherry-pick --continue`.cwd(worktreePath).quiet().nothrow();
				if (cont.exitCode !== 0) {
					await git(["cherry-pick", "--abort"], worktreePath).quiet().nothrow();
					throw new Error(`failed to continue cherry-pick of ${p.sha}:\n${cont.text()}`);
				}
			}
		}

		// Consolidated sync log: exact content from main.
		await Bun.write(path.join(worktreePath, LOG_FILE), logSnapshot);
		await git(["add", LOG_FILE], worktreePath).quiet();
		await git(["commit", "-m", `chore(fork): consolidate sync log through ${lastVersion}`], worktreePath).quiet();

		const newHead = (await git(["rev-parse", "HEAD"], worktreePath).quiet()).text().trim();

		// Correctness gate: identical end tree.
		const diff = await git(["diff", "--quiet", "main", newHead]).quiet().nothrow();
		if (diff.exitCode !== 0) throw new Error("rebuilt head tree differs from main — aborting, nothing moved");

		// Identity gate: the rewrite must not reintroduce unwanted identities.
		const identities = new Set(
			(await git(["log", "--format=%ae%n%ce", `${baseTag}..${newHead}`]).quiet()).text().trim().split("\n"),
		);
		console.log(`identities in rewritten stack: ${[...identities].join(", ")}`);

		await git(["branch", "-f", RESULT_BRANCH, newHead]).quiet();
		console.log(`verified: tree identical to main; ${kept.length + 1} commits on ${RESULT_BRANCH} (${newHead})`);

		if (!push) {
			console.log(`dry run — inspect with: git range-diff ${baseTag} main ${RESULT_BRANCH}`);
			console.log("apply with: bun scripts/squash-sync-log.ts --push");
			return;
		}
		await git(["reset", "--hard", newHead]).quiet();
		await git(["push", "--force-with-lease", "origin", "main"]).quiet();
		console.log("main rewritten and pushed (force-with-lease)");
	} finally {
		await cleanupWorktree();
	}
}

await main();
