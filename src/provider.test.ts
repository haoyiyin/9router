import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelsDevModel, RouterModel } from "./data.ts";

let tempHome = "";
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;

// bun's os.homedir() ignores process.env.HOME (it reads the OS user database),
// so stub it to keep every cache/config path hermetic against the real user dirs.
mock.module("node:os", () => ({
	...import.meta.require("node:os"),
	homedir: () => tempHome,
}));

// provider.ts -> data.ts -> @xynogen/pix-data must load AFTER HOME is set, because
// pix-data computes CACHE_DIR (used for 9router.json) at module-import time. The
// chain is therefore dynamic-imported in beforeAll; the helper tests keep their
// original bodies via these module-level bindings.
let getContextWindow: any;
let getInputTypes: any;
let getMaxTokens: any;
let getModelName: any;
let getReasoning: any;
let getThinkingLevelMap: any;
let resolveComboOptIn: any;
let registerProvider: any;
let ZEN_URL = "";
let cachePath: any;
let ROUTER_CACHE = "";
let ZEN_CACHE = "";
let ROUTER_MODELS_URL = "";

beforeAll(async () => {
	tempHome = mkdtempSync(join(realpathSync(tmpdir()), "9router-oc-test-"));
	process.env.HOME = tempHome;
	delete process.env.XDG_CACHE_HOME; // force pix-data CACHE_DIR to derive from homedir()

	const provider = await import("./provider.ts");
	const zen = await import("./zen.ts");
	const config = await import("./config.ts");
	const data = await import("./data.ts");

	getContextWindow = provider.getContextWindow;
	getInputTypes = provider.getInputTypes;
	getMaxTokens = provider.getMaxTokens;
	getModelName = provider.getModelName;
	getReasoning = provider.getReasoning;
	getThinkingLevelMap = provider.getThinkingLevelMap;
	resolveComboOptIn = provider.resolveComboOptIn;
	registerProvider = provider.registerProvider;

	ZEN_URL = zen.ZEN_URL;
	cachePath = zen.cachePath;

	ROUTER_CACHE = join(data.CACHE_DIR, "9router.json");
	ZEN_CACHE = cachePath();
	ROUTER_MODELS_URL = `${config.DEFAULT_BASE}/models`;
});

afterAll(() => {
	process.env.HOME = ORIGINAL_HOME;
	if (ORIGINAL_XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = ORIGINAL_XDG_CACHE_HOME;
	rmSync(tempHome, { recursive: true, force: true });
	// Restore the real node:os so this mock never leaks into other test files.
	mock.module("node:os", () => import.meta.require("node:os"));
});

// ── getInputTypes ────────────────────────────────────────────────────────────

describe("getInputTypes", () => {
	it("uses devModel modalities when present", () => {
		const model: RouterModel = { id: "some-model" };
		const dev: ModelsDevModel = {
			id: "some-model",
			modalities: { input: ["text", "image"] },
		};
		expect(getInputTypes(model, dev)).toEqual(["text", "image"]);
	});

	it("filters out non text/image modalities from devModel", () => {
		const model: RouterModel = { id: "some-model" };
		const dev: ModelsDevModel = {
			id: "some-model",
			modalities: { input: ["text", "audio"] },
		};
		expect(getInputTypes(model, dev)).toEqual(["text"]);
	});

	it("falls back to pattern match for claude", () => {
		expect(getInputTypes({ id: "claude-sonnet-4-5" })).toEqual(["text", "image"]);
	});

	it("falls back to pattern match for gpt-4o", () => {
		expect(getInputTypes({ id: "gpt-4o" })).toEqual(["text", "image"]);
	});

	it("falls back to pattern match for kimi-k2", () => {
		expect(getInputTypes({ id: "kimi-k2-instruct" })).toEqual(["text", "image"]);
	});

	it("returns text-only for unknown model with no devModel", () => {
		expect(getInputTypes({ id: "some-random-llm" })).toEqual(["text"]);
	});

	it("uses devModel over pattern when both match", () => {
		const model: RouterModel = { id: "claude-opus-4" };
		const dev: ModelsDevModel = {
			id: "claude-opus-4",
			modalities: { input: ["text"] }, // explicitly text-only despite claude pattern
		};
		expect(getInputTypes(model, dev)).toEqual(["text"]);
	});
});

// ── getModelName ─────────────────────────────────────────────────────────────

describe("getModelName", () => {
	it("prefers router model.name", () => {
		expect(getModelName({ id: "x", name: "Router Name" }, { id: "x", name: "Dev Name" })).toBe(
			"Router Name",
		);
	});

	it("falls back to devModel.name", () => {
		expect(getModelName({ id: "x" }, { id: "x", name: "Dev Name" })).toBe("Dev Name");
	});

	it("falls back to model.id", () => {
		expect(getModelName({ id: "some-id" })).toBe("some-id");
	});

	it("returns 'unknown' when all empty", () => {
		expect(getModelName({})).toBe("unknown");
	});
});

// ── getContextWindow ──────────────────────────────────────────────────────────

describe("getContextWindow", () => {
	it("prefers model.context_window", () => {
		expect(
			getContextWindow(
				{ id: "x", context_window: 32_000 },
				{ id: "x", limit: { context: 100_000 } },
			),
		).toBe(32_000);
	});

	it("falls back to model.contextWindow", () => {
		expect(getContextWindow({ id: "x", contextWindow: 64_000 })).toBe(64_000);
	});

	it("falls back to capabilities.contextWindow (9router v1 nested shape)", () => {
		expect(getContextWindow({ id: "x", capabilities: { contextWindow: 1_000_000 } })).toBe(
			1_000_000,
		);
	});

	it("top-level fields beat capabilities.contextWindow", () => {
		expect(
			getContextWindow({
				id: "x",
				contextWindow: 64_000,
				capabilities: { contextWindow: 1_000_000 },
			}),
		).toBe(64_000);
	});

	it("capabilities.contextWindow beats devModel.limit.context", () => {
		expect(
			getContextWindow(
				{ id: "x", capabilities: { contextWindow: 1_000_000 } },
				{ id: "x", limit: { context: 200_000 } },
			),
		).toBe(1_000_000);
	});

	it("falls back to devModel.limit.context", () => {
		expect(getContextWindow({ id: "x" }, { id: "x", limit: { context: 200_000 } })).toBe(200_000);
	});

	it("reads context_length (OpenAI alias the router also sends)", () => {
		expect(getContextWindow({ id: "x", context_length: 256_000 })).toBe(256_000);
	});

	it("returns undefined when the router advertises nothing — no guessed default", () => {
		expect(getContextWindow({ id: "x" })).toBe(undefined);
		expect(getContextWindow({ id: "x", contextWindow: 0 })).toBe(undefined);
		expect(getContextWindow({ id: "x", capabilities: { contextWindow: null } })).toBe(undefined);
	});

	it("uses the fallback only when nothing is advertised", () => {
		expect(getContextWindow({ id: "x" }, undefined, 128_000)).toBe(128_000);
		expect(getContextWindow({ id: "x", capabilities: { contextWindow: 272_000 } }, undefined, 128_000)).toBe(
			272_000,
		);
	});
});

// ── getMaxTokens ──────────────────────────────────────────────────────────────

describe("getMaxTokens", () => {
	it("prefers model.max_tokens", () => {
		expect(
			getMaxTokens({ id: "x", max_tokens: 4_096 }, { id: "x", limit: { output: 32_000 } }),
		).toBe(4_096);
	});

	it("falls back to model.maxTokens", () => {
		expect(getMaxTokens({ id: "x", maxTokens: 8_192 })).toBe(8_192);
	});

	it("falls back to capabilities.maxOutput (9router v1 nested shape)", () => {
		expect(getMaxTokens({ id: "x", capabilities: { maxOutput: 64_000 } })).toBe(64_000);
	});

	it("top-level fields beat capabilities.maxOutput", () => {
		expect(getMaxTokens({ id: "x", maxTokens: 8_192, capabilities: { maxOutput: 64_000 } })).toBe(
			8_192,
		);
	});

	it("capabilities.maxOutput beats devModel.limit.output", () => {
		expect(
			getMaxTokens(
				{ id: "x", capabilities: { maxOutput: 64_000 } },
				{ id: "x", limit: { output: 16_000 } },
			),
		).toBe(64_000);
	});

	it("falls back to devModel.limit.output", () => {
		expect(getMaxTokens({ id: "x" }, { id: "x", limit: { output: 16_000 } })).toBe(16_000);
	});

	it("reads max_completion_tokens (OpenAI alias the router also sends)", () => {
		expect(getMaxTokens({ id: "x", max_completion_tokens: 65_536 })).toBe(65_536);
	});

	it("returns undefined when the router advertises nothing — no guessed default", () => {
		expect(getMaxTokens({ id: "x" })).toBe(undefined);
		expect(getMaxTokens({ id: "x", maxTokens: 0 })).toBe(undefined);
	});

	it("uses the fallback only when nothing is advertised", () => {
		expect(getMaxTokens({ id: "x" }, undefined, 16_384)).toBe(16_384);
		expect(getMaxTokens({ id: "x", capabilities: { maxOutput: 384_000 } }, undefined, 16_384)).toBe(
			384_000,
		);
	});

	it("handles the PR #9 regression case (qwen3-coder-flash nested capabilities)", () => {
		const model: RouterModel = {
			id: "alims-intl/qwen3-coder-flash-2025-07-28",
			capabilities: { contextWindow: 1_000_000, maxOutput: 64_000 },
		};
		expect(getContextWindow(model)).toBe(1_000_000);
		expect(getMaxTokens(model)).toBe(64_000);
	});
});

// ── getReasoning ──────────────────────────────────────────────────────────────

describe("getReasoning", () => {
	it("uses devModel.reasoning when boolean true", () => {
		expect(getReasoning({ id: "x" }, { id: "x", reasoning: true })).toBe(true);
	});

	it("uses devModel.reasoning when boolean false", () => {
		// even if pattern would match, devModel wins
		expect(getReasoning({ id: "claude-opus-4" }, { id: "claude-opus-4", reasoning: false })).toBe(
			false,
		);
	});

	it("falls back to pattern — opus", () => {
		expect(getReasoning({ id: "claude-opus-4" })).toBe(true);
	});

	it("falls back to pattern — sonnet", () => {
		expect(getReasoning({ id: "claude-sonnet-4-5" })).toBe(true);
	});

	it("falls back to pattern — thinking", () => {
		expect(getReasoning({ id: "deepseek-thinking" })).toBe(true);
	});

	it("falls back to pattern — reasoner", () => {
		expect(getReasoning({ id: "o1-reasoner" })).toBe(true);
	});

	it("uses capabilities.reasoning when boolean true", () => {
		expect(getReasoning({ id: "deepseek-v4-flash", capabilities: { reasoning: true } })).toBe(true);
	});

	it("uses capabilities.reasoning when boolean false (beats pattern)", () => {
		expect(getReasoning({ id: "claude-opus-4", capabilities: { reasoning: false } })).toBe(false);
	});

	it("returns false for plain model with no devModel", () => {
		expect(getReasoning({ id: "llama-3-8b-instruct" })).toBe(false);
	});
});

// ── getThinkingLevelMap ───────────────────────────────────────────────────────

describe("getThinkingLevelMap", () => {
	it("returns undefined when the backend does not declare reasoning", () => {
		expect(getThinkingLevelMap({ id: "main", capabilities: null })).toBe(undefined);
	});

	it("deepseek format exposes low/high/max and hides minimal/medium", () => {
		expect(
			getThinkingLevelMap({
				id: "ds/deepseek-v4-pro-max",
				capabilities: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: true },
			}),
		).toEqual({ minimal: null, low: "low", medium: null, high: "high", max: "max" });
	});

	it("openai format with thinkingCanDisable false hides off and unlocks xhigh/max", () => {
		expect(
			getThinkingLevelMap({
				id: "cbcn/deepseek-v4-pro",
				capabilities: { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false },
			}),
		).toEqual({ off: null, xhigh: "xhigh", max: "max" });
	});

	it("openai format with thinkingCanDisable true unlocks xhigh/max", () => {
		expect(
			getThinkingLevelMap({
				id: "gcli/grok-4.6",
				capabilities: { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true },
			}),
		).toEqual({ xhigh: "xhigh", max: "max" });
	});
});

// ── resolveComboOptIn ─────────────────────────────────────────────────────────

describe("resolveComboOptIn", () => {
	it("returns null when comboReasoning is not configured", () => {
		expect(resolveComboOptIn(undefined)).toBe(null);
		expect(resolveComboOptIn(false)).toBe(null);
	});

	it("true -> reasoning on with the default off..max map", () => {
		expect(resolveComboOptIn(true)).toEqual({
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
	});

	it("object with a thinkingLevelMap overrides the default", () => {
		expect(resolveComboOptIn({ thinkingLevelMap: { max: "max" } })).toEqual({
			reasoning: true,
			thinkingLevelMap: { max: "max" },
		});
	});

	it("object without a thinkingLevelMap keeps the default off..max map", () => {
		expect(resolveComboOptIn({})).toEqual({
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
	});
});

// ── registerProvider ──────────────────────────────────────────────────────────

describe("registerProvider", () => {
	const realFetch = globalThis.fetch;
	const ORIGINAL_KEY = process.env.ROUTER_API_KEY;
	const ORIGINAL_BASE = process.env.ROUTER_API_BASE;

	let registered: { name: string; cfg: { models: unknown[] } } | null = null;
	let pi: { registerProvider: ReturnType<typeof mock>; unregisterProvider: ReturnType<typeof mock> };

	const jsonRes = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

	const clearCaches = () => {
		for (const p of [ROUTER_CACHE, ZEN_CACHE]) rmSync(p, { force: true });
	};

	beforeEach(() => {
		registered = null;
		delete process.env.ROUTER_API_BASE;
		pi = {
			registerProvider: mock((name: string, cfg: { models: unknown[] }) => {
				registered = { name, cfg };
			}),
			unregisterProvider: mock(() => {}),
		};
		clearCaches();
	});

	afterEach(() => {
		if (ORIGINAL_KEY === undefined) delete process.env.ROUTER_API_KEY;
		else process.env.ROUTER_API_KEY = ORIGINAL_KEY;
		if (ORIGINAL_BASE === undefined) delete process.env.ROUTER_API_BASE;
		else process.env.ROUTER_API_BASE = ORIGINAL_BASE;
		clearCaches();
		globalThis.fetch = realFetch;
	});

	it("merges router models with oc/-free zen models and drops oc non-free ids", async () => {
		process.env.ROUTER_API_KEY = "test-key";
		globalThis.fetch = mock(async (input: string | Request | URL) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
			if (url === ROUTER_MODELS_URL) {
				return jsonRes({ data: [{ id: "ds/deepseek-v4-pro-max" }] });
			}
			if (url === ZEN_URL) {
				return jsonRes({ object: "list", data: [{ id: "a-free" }, { id: "b" }, { id: "c-free" }] });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		await registerProvider(pi as unknown as Parameters<typeof registerProvider>[0]);

		expect(pi.unregisterProvider).toHaveBeenCalledWith("9router");
		expect(registered?.name).toBe("9router");
		const ids = (registered?.cfg.models ?? []).map((m) => (m as { id: string }).id);
		expect(ids).toContain("ds/deepseek-v4-pro-max");
		expect(ids).toContain("oc/a-free");
		expect(ids).toContain("oc/c-free");
		expect(ids).not.toContain("oc/b");
	});

	it("forces reasoning on combo models when comboReasoning is configured", async () => {
		const cfgDir = join(tempHome, ".pi", "agent", "haoyiyin");
		mkdirSync(cfgDir, { recursive: true });
		writeFileSync(
			join(cfgDir, "9router.json"),
			JSON.stringify({ comboReasoning: { thinkingLevelMap: { max: "max" } } }),
		);
		process.env.ROUTER_API_KEY = "test-key";
		globalThis.fetch = mock(async (input: string | Request | URL) => {
			const url =
				typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
			if (url === ROUTER_MODELS_URL) {
				return jsonRes({
					data: [
						{ id: "main", owned_by: "combo" },
						{
							id: "ds/deepseek-v4-pro-max",
							owned_by: "ds",
							capabilities: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: true },
						},
					],
				});
			}
			if (url === ZEN_URL) return jsonRes({ object: "list", data: [] });
			throw new Error(`unexpected fetch: ${url}`);
		});

		try {
			await registerProvider(pi as unknown as Parameters<typeof registerProvider>[0]);
		} finally {
			// Keep the config file scoped to this test so sibling tests see no comboReasoning.
			rmSync(cfgDir, { recursive: true, force: true });
		}

		const models = (registered?.cfg.models ?? []) as Array<Record<string, unknown>>;
		const main = models.find((m) => m.id === "main");
		expect(main?.reasoning).toBe(true);
		expect(main?.thinkingLevelMap).toEqual({ max: "max" });

		// Sanity: named deepseek model keeps its capabilities-derived map.
		const ds = models.find((m) => m.id === "ds/deepseek-v4-pro-max");
		expect(ds?.reasoning).toBe(true);
		expect(ds?.thinkingLevelMap).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			max: "max",
		});
	});

	it("defaults combo reasoning on when comboReasoning is absent from config", async () => {
		process.env.ROUTER_API_KEY = "test-key";
		globalThis.fetch = mock(async (input: string | Request | URL) => {
			const url =
				typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
			if (url === ROUTER_MODELS_URL) {
				return jsonRes({ data: [{ id: "free", owned_by: "combo" }] });
			}
			if (url === ZEN_URL) return jsonRes({ object: "list", data: [] });
			throw new Error(`unexpected fetch: ${url}`);
		});

		await registerProvider(pi as unknown as Parameters<typeof registerProvider>[0]);

		const models = (registered?.cfg.models ?? []) as Array<Record<string, unknown>>;
		const free = models.find((m) => m.id === "free");
		expect(free?.reasoning).toBe(true);
		expect(free?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
	});

	it("registers an empty model list (shell provider) when no api key is set", async () => {
		delete process.env.ROUTER_API_KEY;
		// No config file → loadConfig yields an empty apiKey.
		await registerProvider(pi as unknown as Parameters<typeof registerProvider>[0]);

		expect(registered?.name).toBe("9router");
		expect(registered?.cfg.models).toEqual([]);
	});
});
