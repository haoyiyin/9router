import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_BASE = "";

export interface RouterConfig {
  baseUrl: string;
  apiKey: string;
  /**
   * Force reasoning:true onto combo models (`owned_by === "combo"`).
   * Combo models carry no capabilities from the router, so this switch decides
   * their reasoning status. Defaults to `true` (combo routes are assumed to hit
   * thinking-capable upstreams) with the full off..max range; set `false` to opt
   * out, or pass a custom `thinkingLevelMap` to override the range.
   */
  comboReasoning?: boolean | { thinkingLevelMap?: Record<string, string | null> };
}

export function configPath(): string {
  return join(homedir(), ".pi", "agent", "haoyiyin", "9router.json");
}

export function loadConfig(): RouterConfig {
  const path = configPath();
  let fileBase: string | undefined;
  let fileKey: string | undefined;
  let comboReasoning: RouterConfig["comboReasoning"] | undefined;

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.baseUrl === "string") fileBase = parsed.baseUrl;
        if (typeof parsed.apiKey === "string") fileKey = parsed.apiKey;
        if (
          typeof parsed.comboReasoning === "boolean" ||
          (parsed.comboReasoning && typeof parsed.comboReasoning === "object")
        ) {
          comboReasoning = parsed.comboReasoning;
        }
      }
    } catch {
      // tolerate malformed config -> fall back to env/defaults
    }
  }

  let baseUrl = fileBase ?? process.env.ROUTER_API_BASE ?? DEFAULT_BASE;
  if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);

  const apiKey = fileKey ?? process.env.ROUTER_API_KEY ?? "";

  return { baseUrl, apiKey, comboReasoning: comboReasoning ?? true };
}

export function saveConfig(cfg: RouterConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort enforcement on existing files
  }
}
