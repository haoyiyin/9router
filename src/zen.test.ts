import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, cachePath, fetchZenFreeModels, getZenFreeModels, loadZenCache, ZEN_URL } from "./zen.ts";

let tempHome = "";
const ORIGINAL_HOME = process.env.HOME;

// bun's os.homedir() ignores process.env.HOME; stub it so zen.ts's lazy
// cacheDir()/cachePath() resolve under the temp HOME instead of ~/.cache/pi.
mock.module("node:os", () => ({
	...import.meta.require("node:os"),
	homedir: () => tempHome,
}));

const TTL = 30 * 60 * 1000;

const realFetch = globalThis.fetch;

const jsonRes = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const writeCache = (models: string[], ageMs: number) => {
	mkdirSync(cacheDir(), { recursive: true });
	writeFileSync(cachePath(), JSON.stringify({ ts: Date.now() - ageMs, models }), { mode: 0o600 });
};

beforeAll(() => {
	tempHome = mkdtempSync(join(realpathSync(tmpdir()), "9router-oc-test-"));
	process.env.HOME = tempHome;
});

afterAll(() => {
	process.env.HOME = ORIGINAL_HOME;
	rmSync(tempHome, { recursive: true, force: true });
	// Restore the real node:os so this mock never leaks into other test files.
	mock.module("node:os", () => import.meta.require("node:os"));
});

afterEach(() => {
	rmSync(cachePath(), { force: true });
	globalThis.fetch = realFetch;
});

describe("fetchZenFreeModels", () => {
	it("parses and filters only -free model ids from the zen list payload", async () => {
		globalThis.fetch = mock(async () =>
			jsonRes({
				object: "list",
				data: [{ id: "deepseek-v4-flash-free" }, { id: "gpt-5.6-sol" }, { id: "mimo-v2.5-free" }],
			}),
		);

		const models = await fetchZenFreeModels();
		expect(models).toEqual(["deepseek-v4-flash-free", "mimo-v2.5-free"]);
	});

	it("returns [] when the fetch rejects", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network down")));
		expect(await fetchZenFreeModels()).toEqual([]);
	});
});

describe("loadZenCache", () => {
	it("returns [] for an expired (stale) cache", () => {
		writeCache(["x-free"], TTL + 1000);
		expect(loadZenCache()).toEqual([]);
	});

	it("returns the models for a fresh cache", () => {
		writeCache(["x-free"], 0);
		expect(loadZenCache()).toEqual(["x-free"]);
	});

	it("returns stale models when ignoreTtl is true", () => {
		writeCache(["y-free"], TTL + 1000);
		expect(loadZenCache(true)).toEqual(["y-free"]);
	});

	it("returns [] when no cache file exists", () => {
		rmSync(cachePath(), { force: true });
		expect(loadZenCache()).toEqual([]);
	});
});

describe("getZenFreeModels", () => {
	it("falls back to stale cache when the live fetch returns nothing", async () => {
		writeCache(["stale-free"], TTL + 1000); // stale on disk
		globalThis.fetch = mock(() => Promise.reject(new Error("network down")));

		const models = await getZenFreeModels();
		expect(models).toEqual(["stale-free"]);
	});

	it("prefers fresh cache without hitting the network", async () => {
		writeCache(["cached-free"], 0);
		const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
		globalThis.fetch = fetchMock;

		const models = await getZenFreeModels();
		expect(models).toEqual(["cached-free"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
