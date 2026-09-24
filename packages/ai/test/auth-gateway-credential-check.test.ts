/**
 * Regression for `GET /v1/credentials/check` scoping: managed MCP OAuth
 * credentials (`mcp_oauth:*` / `mcp_oauth_*` ids) are not inference
 * credentials and must be excluded from the gateway health probe entirely.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import {
	type AuthCredential,
	AuthStorage,
	type CredentialHealthResult,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";

const MCP_CREDENTIAL_IDS = [
	// Current era: profile-scoped, server URL embedded.
	"mcp_oauth:profile:default:https://mcp.example.test/mcp",
	// Legacy era: URL-keyed without a profile segment.
	"mcp_oauth:https://legacy.example.test/mcp",
	// Oldest era: random id minted before URL-keyed ids existed.
	"mcp_oauth_1700000000_abc123def",
];

function expiredOAuth(): AuthCredential {
	return {
		type: "oauth",
		access: "stale-access",
		refresh: "stale-refresh",
		expires: Date.now() - 60_000,
	};
}

test("GET /v1/credentials/check excludes managed MCP credentials without refreshing them", async () => {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const refreshedProviders: string[] = [];
	const storage = new AuthStorage(store, {
		// Deterministic refresh: record which providers reached the refresh path.
		refreshOAuthCredential: provider => {
			refreshedProviders.push(provider);
			return Promise.reject(new Error("refresh exploded"));
		},
	});

	for (const id of MCP_CREDENTIAL_IDS) {
		await storage.credentials.set(id, expiredOAuth());
	}
	// Expired inference OAuth → refresh attempted → ok:false.
	await storage.credentials.set("anthropic", expiredOAuth());
	// API-key provider with no usage probe → ok:null.
	await storage.credentials.set("typesafe", { type: "api_key", key: "ts-test-key" });

	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage,
		resolveModel: () => undefined,
		version: "test",
	});

	try {
		const response = await fetch(`${handle.url}/v1/credentials/check`, {
			headers: { authorization: "Bearer test-token" },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { credentials: CredentialHealthResult[] };

		expect(body.credentials.map(row => row.provider).sort()).toEqual(["anthropic", "typesafe"]);

		const anthropic = body.credentials.find(row => row.provider === "anthropic");
		expect(anthropic?.ok).toBe(false);
		expect(anthropic?.reason).toContain("oauth refresh failed");
		const typesafe = body.credentials.find(row => row.provider === "typesafe");
		expect(typesafe?.ok).toBe(null);

		// Only the inference credential reached the refresh path — expired MCP
		// rows were filtered before any refresh/probe work.
		expect(refreshedProviders).toEqual(["anthropic"]);

		const storedProviders = store.listAuthCredentials().map(row => row.provider);
		for (const id of MCP_CREDENTIAL_IDS) {
			expect(storedProviders).toContain(id);
		}
	} finally {
		await handle.close();
		storage.close();
	}
});
