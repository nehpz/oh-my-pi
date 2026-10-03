import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Unsigned JWT carrying only `sub`: identity lives in the token, as with Cursor. */
function jwtWithSubject(sub: string): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({ sub })}.sig`;
}

function tokenOnlyCredential(sub: string): OAuthCredentials {
	return { access: jwtWithSubject(sub), refresh: `refresh-${sub}`, expires: Date.now() + WEEK_MS };
}

describe("account policies on credentials that store no identity fields", () => {
	let tempDir: string;
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-policy-token-identity-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.cursor as OAuthCredentials | undefined;
			return credential ? { apiKey: `api-${credential.refresh}`, newCredentials: credential } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("priority selects the account named by the token subject", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, {
			rankingStrategyResolver: () => undefined,
			accountPolicies: [{ provider: "cursor", account: { accountId: "auth0|user_primary" }, priority: 10 }],
		});
		await storage.credentials.set("cursor", [
			{ type: "oauth", ...tokenOnlyCredential("github|user_fallback") },
			{ type: "oauth", ...tokenOnlyCredential("auth0|user_primary") },
		]);

		const counts = new Map<string, number>();
		for (let index = 0; index < 60; index += 1) {
			const apiKey = await storage.keys.get("cursor", `session-${index}`);
			if (apiKey) counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}
		expect(counts.get("api-refresh-auth0|user_primary") ?? 0).toBe(60);
		expect(counts.get("api-refresh-github|user_fallback") ?? 0).toBe(0);
	});

	test("a stored accountId takes precedence over the token subject", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, {
			accountPolicies: [{ provider: "cursor", account: { accountId: "token-subject" }, priority: 10 }],
		});
		await expect(
			storage.credentials.set("cursor", [
				{ type: "oauth", ...tokenOnlyCredential("token-subject"), accountId: "stored-account" },
			]),
		).rejects.toThrow("matches no stored OAuth account for cursor");
	});
});
