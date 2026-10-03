/**
 * provider.ts — 9Router model provider
 *
 * Registers the "9router" provider in Pi, pulling the live router model list
 * plus OpenCode's free oc/-free models. Falls back to an empty model list if
 * the API key is unset (so /login can configure it and re-register once a key
 * is saved).
 *
 * Config (base URL + key, with env fallback) is owned by ./config.ts.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ModelsDevModel, RouterModel } from "./data.ts";
import { fetchModelsDevIndex, lookupInIndex, routerBaseUrl, routerModels } from "./data.ts";
import { getZenFreeModels } from "./zen.ts";
import { loadConfig, saveConfig, type RouterConfig } from "./config.ts";

// ponytail: pi's ProviderModelConfig requires both numbers, so a model the
// router leaves blank still needs a value. Used only when nothing is advertised.
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

// Fallback pattern-based detection if models.dev lookup fails
const IMAGE_CAPABLE_PATTERNS = [/claude/i, /gpt-5/i, /gpt-4/i, /kimi-k2/i, /hy3/i];

export function getInputTypes(model: RouterModel, devModel?: ModelsDevModel): ("text" | "image")[] {
	if (devModel?.modalities?.input) {
		const inputs = devModel.modalities.input.filter(
			(i): i is "text" | "image" => i === "text" || i === "image",
		);
		if (inputs.length > 0) return inputs;
	}
	const id = model.id ?? "";
	if (IMAGE_CAPABLE_PATTERNS.some((p) => p.test(id))) return ["text", "image"];
	return ["text"];
}

export function getModelName(model: RouterModel, devModel?: ModelsDevModel): string {
	return model.name || devModel?.name || model.id || "unknown";
}

/** First positive finite number. 0/null/NaN are "not advertised", not a real limit. */
function firstPositive(...values: unknown[]): number | undefined {
	for (const v of values) {
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
	}
	return undefined;
}

/**
 * Context window straight from the router. `fallback` applies only when the
 * router (and models.dev) advertise nothing — never ahead of an API value.
 */
export function getContextWindow(
	model: RouterModel,
	devModel?: ModelsDevModel,
	fallback?: number,
): number | undefined {
	return firstPositive(
		model.context_window,
		model.contextWindow,
		model.context_length,
		model.capabilities?.contextWindow,
		devModel?.limit?.context,
		fallback,
	);
}

/** Max output straight from the router. `fallback` only when nothing is advertised. */
export function getMaxTokens(
	model: RouterModel,
	devModel?: ModelsDevModel,
	fallback?: number,
): number | undefined {
	return firstPositive(
		model.max_tokens,
		model.maxTokens,
		model.max_completion_tokens,
		model.capabilities?.maxOutput,
		model.capabilities?.max_output,
		devModel?.limit?.output,
		fallback,
	);
}

export function getReasoning(model: RouterModel, devModel?: ModelsDevModel): boolean {
	if (typeof model.capabilities?.reasoning === "boolean") return model.capabilities.reasoning;
	if (typeof devModel?.reasoning === "boolean") return devModel.reasoning;
	return /reasoner|thinking|xhigh|high|max|pro|codex|opus|sonnet/i.test(model.id ?? "");
}

// pi understands these thinkingFormats; the router backend declares openai/deepseek
// (and occasionally minimax/gemini-level, which pi cannot natively drive). Map the
// known ones and fall back to openai for anything unknown/minimax/gemini-level.
const PI_THINKING_FORMAT: Record<string, "openai" | "deepseek"> = {
	openai: "openai",
	deepseek: "deepseek",
};

function getThinkingFormat(model: RouterModel): "openai" | "deepseek" {
	return PI_THINKING_FORMAT[model.capabilities?.thinkingFormat ?? ""] ?? "openai";
}

/**
 * Derive pi's thinkingLevelMap from the router's advertised capabilities.
 * DeepSeek exposes low/high/max (mirrors pi's own deepseek catalog); openai-style
 * models expose off..max, hiding `off` when thinking cannot be disabled. No map
 * is returned when the backend does not declare reasoning.
 */
export function getThinkingLevelMap(
	model: RouterModel,
): ProviderModelConfig["thinkingLevelMap"] | undefined {
	const cap = model.capabilities;
	if (cap?.reasoning !== true) return undefined;
	if (cap.thinkingFormat === "deepseek") {
		return { minimal: null, low: "low", medium: null, high: "high", max: "max" };
	}
	// openai-style: reasoning_effort takes the level name directly. Unlock
	// xhigh/max, and hide off when thinking cannot be disabled.
	return {
		...(cap.thinkingCanDisable === false ? { off: null } : {}),
		xhigh: "xhigh",
		max: "max",
	};
}

/**
 * Combo models (`owned_by === "combo"`) carry no capabilities from the router, so
 * their reasoning is decided by `comboReasoning` in 9router.json: default `true`
 * (off..max, the same range named reasoning models get), `false` disables, or an
 * object with a custom `thinkingLevelMap` to override the range.
 *
 * pi only surfaces `xhigh`/`max` when `thinkingLevelMap` maps them (see pi's
 * getSupportedThinkingLevels), so the default carries an explicit map — without
 * it combo models would be stuck at `high`.
 */
const DEFAULT_COMBO_THINKING_LEVEL_MAP: ProviderModelConfig["thinkingLevelMap"] = {
	xhigh: "xhigh",
	max: "max",
};

export function resolveComboOptIn(
	comboReasoning: RouterConfig["comboReasoning"],
): { reasoning: true; thinkingLevelMap: ProviderModelConfig["thinkingLevelMap"] } | null {
	if (!comboReasoning) return null;
	const custom =
		comboReasoning === true
			? undefined
			: (comboReasoning.thinkingLevelMap as ProviderModelConfig["thinkingLevelMap"] | undefined);
	return {
		reasoning: true,
		thinkingLevelMap: custom ?? DEFAULT_COMBO_THINKING_LEVEL_MAP,
	};
}

/**
 * True if `err` is pi's stale-extension-ctx error, thrown when a captured
 * `pi`/command ctx is used after session replacement (newSession / fork /
 * switchSession) or extension reload. A stale instance can never recover —
 * the new session's extension instance re-registers everything itself.
 */
export function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && /stale after session replacement|ctx is stale/.test(err.message);
}

// Login flow: collect base URL + API key, persist to config, then re-register
// so the model list and base URL take effect. The key is carried as the OAuth
// credential (getApiKey); no separate apiKey is set on the provider, so /login
// shows exactly one 9router entry instead of an api_key + oauth pair.
function makeOAuth(pi: ExtensionAPI) {
	return {
		name: "9Router",
		login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
			const current = loadConfig();
			const baseUrl = await callbacks.onPrompt({
				message: "9Router base URL",
				placeholder: current.baseUrl || "https://your-router.example.com",
			});
			if (baseUrl === undefined) throw new Error("9Router login cancelled");
			const trimmedBase = baseUrl.trim();
			const normalizedBase = trimmedBase.endsWith("/")
				? trimmedBase.slice(0, -1)
				: trimmedBase;

			const apiKey = await callbacks.onPrompt({
				message: "9Router API key",
				placeholder: "sk-...",
			});
			if (apiKey === undefined) throw new Error("9Router login cancelled");
			const trimmedKey = apiKey.trim();
			if (!trimmedKey) throw new Error("9Router API key is required");

			saveConfig({ baseUrl: normalizedBase, apiKey: trimmedKey, comboReasoning: current.comboReasoning });

			// Re-register with the freshly saved config so models + base URL apply.
			await registerProvider(pi);

			return { refresh: trimmedKey, access: trimmedKey, expires: Number.MAX_SAFE_INTEGER };
		},
		refreshToken: async (cred: OAuthCredentials): Promise<OAuthCredentials> => cred,
		getApiKey: (cred: OAuthCredentials): string => cred.access,
	};
}

export async function registerProvider(pi: ExtensionAPI): Promise<void> {
	const cfg = loadConfig();
	const oauth = makeOAuth(pi);

	if (!cfg.apiKey) {
		// Register shell provider so /login can configure it; no models yet.
		pi.registerProvider("9router", {
			name: "9Router",
			api: "openai-completions",
			models: [],
			oauth,
		});
		return;
	}

	const [models, devIndex, zenIds] = await Promise.all([
		routerModels.get(),
		fetchModelsDevIndex().catch(() => new Map<string, ModelsDevModel>()),
		getZenFreeModels(),
	]);

	// Upstream moved OpenAI `compat` settings from the provider level to the
	// per-model level (ProviderModelConfig.compat). Apply the same shim to every
	// registered model.
	const COMPAT = {
		supportsDeveloperRole: false,
		supportsUsageInStreaming: false,
		maxTokensField: "max_tokens",
	} as const;

	const seen = new Set<string>();
	const out: ProviderModelConfig[] = [];

	// Router models (live list), mapped the same as the original registration.
	for (const model of models) {
		const id = model.id ?? "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const devModel = lookupInIndex(id, devIndex);
		const thinkingFormat = getThinkingFormat(model);
		const comboOptIn = model.owned_by === "combo" ? resolveComboOptIn(cfg.comboReasoning) : null;
		out.push({
			id,
			name: getModelName(model, devModel),
			reasoning: comboOptIn ? comboOptIn.reasoning : getReasoning(model, devModel),
			input: getInputTypes(model, devModel),
			cost: ZERO_COST,
			contextWindow: getContextWindow(model, devModel, FALLBACK_CONTEXT_WINDOW)!,
			maxTokens: getMaxTokens(model, devModel, FALLBACK_MAX_TOKENS)!,
			thinkingLevelMap: comboOptIn ? comboOptIn.thinkingLevelMap : getThinkingLevelMap(model),
			compat: {
				...COMPAT,
				supportsReasoningEffort: true,
				thinkingFormat,
				...(thinkingFormat === "deepseek"
					? { requiresReasoningContentOnAssistantMessages: true }
					: {}),
			},
		});
	}

	// OpenCode free models (zen) — bare ids, no auth needed.
	// ponytail: zen returns bare ids (e.g. "deepseek-v4-flash-free") with no
	// metadata, so the contextWindow/maxTokens defaults below are guesses.
	// Upgrade when zen ships model detail.
	for (const id of zenIds) {
		const ocId = `oc/${id}`;
		if (seen.has(ocId)) continue;
		seen.add(ocId);
		out.push({
			id: ocId,
			name: id,
			reasoning: /reasoner|thinking|xhigh|high|max|pro|codex|opus|sonnet|fable|terra/i.test(id),
			input: /claude|gpt-|grok|gemini|kimi|glm|qwen|minimax|mimo/i.test(id)
				? ["text", "image"]
				: ["text"],
			cost: ZERO_COST,
			contextWindow: 200_000,
			maxTokens: 32_000,
			compat: COMPAT,
		});
	}

	if (typeof (pi as { unregisterProvider?: unknown }).unregisterProvider === "function") {
		pi.unregisterProvider("9router");
	}
	pi.registerProvider("9router", {
		name: "9Router",
		baseUrl: cfg.baseUrl,
		api: "openai-completions",
		headers: { "User-Agent": "pi-coding-agent" },
		models: out,
		oauth,
	});
}

export default registerProvider;
