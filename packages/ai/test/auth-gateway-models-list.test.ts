import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway GET /v1/models", () => {
	it("returns each supplied model exactly once, with context/max-token limits", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-models-list-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const alpha = createMockModel({ provider: "openrouter", id: "alpha", contextWindow: 128_000, maxTokens: 8_192 });
		const beta = createMockModel({ provider: "openrouter", id: "beta", contextWindow: 1_000_000, maxTokens: 32_768 });

		// Regression for the auth-gateway-cli wiring bug: a caller that hands
		// `listModels` a lookup map aliased under two keys per model (qualified
		// `provider/id` + bare `id`, mirroring `runServe()` in
		// `auth-gateway-cli.ts`) must still see each model exactly once on the
		// wire — `listModels` is expected to already be deduplicated before
		// `handleModelsList` ever sees it.
		const modelById = new Map([
			["openrouter/alpha", alpha.model],
			["alpha", alpha.model],
			["openrouter/beta", beta.model],
			["beta", beta.model],
		]);
		const models = [alpha.model, beta.model];

		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: (id: string) => modelById.get(id),
			listModels: () => models,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/models`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { object: string; data: Array<Record<string, unknown>> };
			expect(body.object).toBe("list");
			expect(body.data).toHaveLength(2);
			expect(body.data.map(m => m.id).sort()).toEqual(["openrouter/alpha", "openrouter/beta"]);

			const alphaEntry = body.data.find(m => m.id === "openrouter/alpha");
			expect(alphaEntry).toMatchObject({
				id: "openrouter/alpha",
				object: "model",
				owned_by: "openrouter",
				context_length: 128_000,
				max_tokens: 8_192,
			});
			const betaEntry = body.data.find(m => m.id === "openrouter/beta");
			expect(betaEntry).toMatchObject({
				context_length: 1_000_000,
				max_tokens: 32_768,
			});
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns an empty list when no listModels supplier is configured", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-models-list-empty-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => undefined,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/models`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { object: string; data: unknown[] };
			expect(body).toEqual({ object: "list", data: [] });
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
