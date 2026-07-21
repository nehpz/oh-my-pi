import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildAuthGatewayModelCatalog } from "../src/cli/auth-gateway-cli";

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as Model<Api>;
}

describe("buildAuthGatewayModelCatalog", () => {
	it("enumerates each model exactly once even though modelById aliases it under two keys", () => {
		const alpha = fakeModel("openrouter", "gpt-5.4");
		const beta = fakeModel("anthropic", "claude-sonnet-5");
		const providers = ["openrouter", "anthropic", "no-creds"];
		const modelsByProvider: Record<string, Model<Api>[]> = {
			openrouter: [alpha],
			anthropic: [beta],
			"no-creds": [fakeModel("no-creds", "should-be-excluded")],
		};
		const providersWithCreds = new Set(["openrouter", "anthropic"]);

		const { modelById, models } = buildAuthGatewayModelCatalog(providersWithCreds, {
			providers,
			getModels: provider => modelsByProvider[provider] ?? [],
		});

		// Enumeration: exactly one entry per credentialed model, no duplicates,
		// and providers without credentials are excluded entirely. This is the
		// regression this helper fixes — `modelById.values()` would have
		// returned each model twice here (qualified key + bare-id fallback).
		expect(models).toHaveLength(2);
		expect(models).toEqual([alpha, beta]);

		// Lookup: both aliases resolve to the same model.
		expect(modelById.get("openrouter/gpt-5.4")).toBe(alpha);
		expect(modelById.get("gpt-5.4")).toBe(alpha);
		expect(modelById.get("anthropic/claude-sonnet-5")).toBe(beta);
		expect(modelById.get("claude-sonnet-5")).toBe(beta);
		expect(modelById.get("should-be-excluded")).toBeUndefined();
	});

	it("keeps the bare-id alias pointed at the first provider on cross-provider collisions, without affecting enumeration", () => {
		const first = fakeModel("provider-a", "shared-id");
		const second = fakeModel("provider-b", "shared-id");
		const providers = ["provider-a", "provider-b"];
		const modelsByProvider: Record<string, Model<Api>[]> = {
			"provider-a": [first],
			"provider-b": [second],
		};
		const providersWithCreds = new Set(providers);

		const { modelById, models } = buildAuthGatewayModelCatalog(providersWithCreds, {
			providers,
			getModels: provider => modelsByProvider[provider] ?? [],
		});

		// Both distinct models still enumerate once each, addressable via their
		// qualified keys; the bare `shared-id` alias is first-write-wins.
		expect(models).toEqual([first, second]);
		expect(modelById.get("provider-a/shared-id")).toBe(first);
		expect(modelById.get("provider-b/shared-id")).toBe(second);
		expect(modelById.get("shared-id")).toBe(first);
	});
});
