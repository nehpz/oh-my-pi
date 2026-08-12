import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { confineToWorkspace } from "../src/tools/path-utils";

describe("confineToWorkspace", () => {
	it("accepts an in-workspace hard link even when realpath names the inode's outside name", async () => {
		// macOS realpath is F_GETPATH-backed: for a multi-hard-link inode it
		// returns whichever of the inode's names the vnode cache holds — under
		// cache churn, nondeterministically the name OUTSIDE the workspace.
		// Containment of a non-symlink target must not consult it: a hard link
		// never relocates the path being written. The spy pins the worst case
		// the kernel only produces intermittently (v17.2.15 sync-verify flake).
		const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), "confine-hardlink-"));
		try {
			const inner = path.join(ws, "ws");
			const outside = path.join(ws, "outside");
			await fs.promises.mkdir(inner);
			await fs.promises.mkdir(outside);
			const victim = path.join(outside, "secret.txt");
			await Bun.write(victim, "SECRET");
			const target = path.join(inner, "innocent.txt");
			await fs.promises.link(victim, target);

			const realNative = fs.realpathSync.native;
			const spy = spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike) =>
				p === target
					? path.join(realNative(outside), "secret.txt")
					: realNative(p)) as typeof fs.realpathSync.native);
			try {
				expect(confineToWorkspace("innocent.txt", inner)).toBe(target);
			} finally {
				spy.mockRestore();
			}
		} finally {
			await fs.promises.rm(ws, { recursive: true, force: true });
		}
	});
});
