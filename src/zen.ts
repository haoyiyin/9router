import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ZEN_URL = "https://opencode.ai/zen/v1/models";

const TTL = 30 * 60 * 1000;

export function cacheDir(): string {
  return join(homedir(), ".cache", "pi");
}

export function cachePath(): string {
  return join(cacheDir(), "zen-oc-models.json");
}

interface ZenCache {
  ts: number;
  models: string[];
}

function parseModels(payload: unknown): string[] {
  let arr: unknown;
  if (Array.isArray(payload)) {
    arr = payload;
  } else if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)) {
    arr = (payload as { data: unknown[] }).data;
  } else {
    return [];
  }
  return (arr as unknown[])
    .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && /-free$/.test(id));
}

export async function fetchZenFreeModels(): Promise<string[]> {
  try {
    const res = await fetch(ZEN_URL, {
      headers: {
        "x-opencode-client": "desktop",
        "User-Agent": "pi-coding-agent",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const models = parseModels(data);
    if (models.length >= 1) {
      mkdirSync(cacheDir(), { recursive: true });
      const cache: ZenCache = { ts: Date.now(), models };
      writeFileSync(cachePath(), JSON.stringify(cache), { mode: 0o600 });
    }
    return models;
  } catch {
    return [];
  }
}

export function loadZenCache(ignoreTtl = false): string[] {
  if (!existsSync(cachePath())) return [];
  try {
    const cache = JSON.parse(readFileSync(cachePath(), "utf8")) as ZenCache;
    if (!ignoreTtl && Date.now() - cache.ts > TTL) return [];
    return Array.isArray(cache.models) ? cache.models : [];
  } catch {
    return [];
  }
}

export async function getZenFreeModels(): Promise<string[]> {
  const fresh = loadZenCache();
  if (fresh.length >= 1) return fresh;
  const fetched = await fetchZenFreeModels();
  if (fetched.length >= 1) return fetched;
  return loadZenCache(true);
}
