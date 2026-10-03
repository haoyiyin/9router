/**
 * data.ts — 9Router data layer
 *
 * Router-specific data only:
 *   - routerBaseUrl()  — resolved API base URL from config
 *   - routerApiKey()   — resolved API key from config
 *   - routerModels     — DataSource<RouterModel[]>, cached 30m at ~/.cache/pi/9router.json
 *
 * Config (base URL + key, with env fallback) is owned by ./config.ts.
 *
 * models.dev + modelgrep data is provided by @xynogen/pix-data, which shares
 * the same ~/.cache/pi/ cache directory. The DataSource implementation and the
 * models.dev index helpers live there — imported here, not duplicated.
 */

import { join } from "node:path";
import { CACHE_DIR, DataSource } from "@xynogen/pix-data/src/index.ts";

export { CACHE_DIR, DataSource };
export {
	buildModelsDevIndex,
	fetchModelsDevIndex,
	lookupInIndex,
} from "@xynogen/pix-data/src/index.ts";
export type {
	ModelGrepModel,
	ModelsDevApi,
	ModelsDevModel,
} from "@xynogen/pix-data/src/index.ts";

import { loadConfig } from "./config.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouterModel {
	id?: string;
	name?: string;
	context_window?: number;
	contextWindow?: number;
	/** 9router also advertises the OpenAI-style top-level aliases */
	context_length?: number;
	max_tokens?: number;
	maxTokens?: number;
	max_completion_tokens?: number;
	owned_by?: string;
	/** 9router v1 API nests these inside capabilities */
	capabilities?: {
		contextWindow?: number;
		maxOutput?: number;
		max_output?: number;
		reasoning?: boolean;
		thinkingFormat?: string;
		thinkingCanDisable?: boolean;
		thinkingRange?: unknown;
		[key: string]: unknown;
	};
}

interface RouterModelsResponse {
	data?: RouterModel[];
}

// ── Resolved config helpers ───────────────────────────────────────────────────

export function routerBaseUrl(): string {
	return loadConfig().baseUrl;
}

export function routerApiKey(): string {
	return loadConfig().apiKey;
}

// ── Router models ──────────────────────────────────────────────────────────────

export const routerModels = new DataSource<RouterModel[]>({
	label: "9router",
	url: () => `${routerBaseUrl()}/models`,
	headers: () => {
		const key = routerApiKey();
		return key ? { Authorization: `Bearer ${key}` } : undefined;
	},
	skip: () => !routerApiKey(),
	cachePath: join(CACHE_DIR, "9router.json"),
	ttlMs: 30 * 60 * 1000, // 30 minutes
	parse: (raw) => ((raw as RouterModelsResponse).data ?? []).filter((m) => Boolean(m.id)),
	parseCache: (data) =>
		((data as RouterModelsResponse | undefined)?.data ?? []).filter((m) => Boolean(m.id)),
	empty: [],
});
