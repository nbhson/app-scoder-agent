/**
 * models.dev catalog (I-02) — model metadata: contextWindow, pricing,
 * supportCache, supportReasoning.
 *
 * Source: anomalyco/opencode (packages/core/src/models-dev/) — pattern
 * adapted. Sync from https://models.dev/api.json into ~/.scoder/
 * models-cache.json (TTL 24h); offline fallback = small built-in snapshot.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelInfo {
  id: string;
  provider: string;
  contextWindow: number;
  maxTokens?: number;
  pricing?: { input: number; output: number };
  supportCache?: boolean;
  supportReasoning?: boolean;
}

interface Catalog {
  fetchedAt: number;
  models: Record<string, ModelInfo>; // key: "<provider>/<id>"
}

const CACHE_PATH = join(homedir(), ".scoder", "models-cache.json");
const TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_URL = "https://models.dev/api.json";

/** Offline snapshot — ~25 popular models (fallback when fetch fails / no network). */
const FALLBACK: Array<{ id: string; provider: string; contextWindow: number; input: number; output: number; cache?: boolean; reasoning?: boolean }> = [
  { id: "gpt-4o", provider: "openai", contextWindow: 128_000, input: 2.5, output: 10 },
  { id: "gpt-4o-mini", provider: "openai", contextWindow: 128_000, input: 0.15, output: 0.6 },
  { id: "gpt-4.1", provider: "openai", contextWindow: 1_047_576, input: 2, output: 8 },
  { id: "gpt-4.1-mini", provider: "openai", contextWindow: 1_047_576, input: 0.4, output: 1.6 },
  { id: "o3", provider: "openai", contextWindow: 200_000, input: 2, output: 8, reasoning: true },
  { id: "o4-mini", provider: "openai", contextWindow: 200_000, input: 1.1, output: 4.4, reasoning: true },
  { id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000, input: 3, output: 15, cache: true, reasoning: true },
  { id: "claude-opus-4-1", provider: "anthropic", contextWindow: 200_000, input: 15, output: 75, cache: true, reasoning: true },
  { id: "claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, input: 1, output: 5, cache: true, reasoning: true },
  { id: "claude-3-5-haiku", provider: "anthropic", contextWindow: 200_000, input: 0.8, output: 4, cache: true },
  { id: "gemini-2.5-pro", provider: "google", contextWindow: 1_048_576, input: 1.25, output: 10, reasoning: true },
  { id: "gemini-2.5-flash", provider: "google", contextWindow: 1_048_576, input: 0.3, output: 2.5, reasoning: true },
  { id: "deepseek-chat", provider: "deepseek", contextWindow: 128_000, input: 0.27, output: 1.1 },
  { id: "deepseek-reasoner", provider: "deepseek", contextWindow: 128_000, input: 0.55, output: 2.19, reasoning: true },
  { id: "glm-4.6", provider: "zai", contextWindow: 200_000, input: 0.6, output: 2.2, reasoning: true },
  { id: "glm-4.5-air", provider: "zai", contextWindow: 128_000, input: 0.2, output: 1.1 },
  { id: "qwen3-coder", provider: "qwen", contextWindow: 262_144, input: 0.3, output: 1.2 },
  { id: "kimi-k2", provider: "moonshotai", contextWindow: 200_000, input: 0.6, output: 2.5 },
  { id: "llama-3.3-70b", provider: "groq", contextWindow: 131_072, input: 0.59, output: 0.79 },
  { id: "llama-4-scout", provider: "groq", contextWindow: 131_072, input: 0.11, output: 0.34 },
  { id: "mistral-large", provider: "mistral", contextWindow: 128_000, input: 2, output: 6 },
  { id: "command-r-plus", provider: "cohere", contextWindow: 128_000, input: 2.5, output: 10 },
  { id: "jamba-1.5-large", provider: "ai21", contextWindow: 256_000, input: 2, output: 8 },
  { id: "grok-4", provider: "xai", contextWindow: 256_000, input: 3, output: 15, reasoning: true },
  { id: "nova-pro", provider: "amazon", contextWindow: 300_000, input: 0.8, output: 3.2 },
];

function key(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function fromFallback(): Catalog {
  const models: Record<string, ModelInfo> = {};
  for (const m of FALLBACK) {
    models[key(m.provider, m.id)] = {
      id: m.id,
      provider: m.provider,
      contextWindow: m.contextWindow,
      pricing: { input: m.input, output: m.output },
      supportCache: m.cache === true,
      supportReasoning: m.reasoning === true,
    };
  }
  return { fetchedAt: 0, models };
}

/** Read the cache file; null when missing/malformed. */
function readCache(): Catalog | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Catalog;
    if (typeof c.fetchedAt !== "number" || typeof c.models !== "object") return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(c: Catalog): void {
  try {
    mkdirSync(join(CACHE_PATH, ".."), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, CACHE_PATH);
  } catch { /* best-effort */ }
}

/** Fetch models.dev and update the cache. Returns null on failure. */
async function fetchCatalog(): Promise<Catalog | null> {
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, { models?: Record<string, { limit?: { context?: number; output?: number }; cost?: { input?: number; output?: number }; reasoning?: boolean; cache?: boolean }> }>;
    const models: Record<string, ModelInfo> = {};
    for (const [provider, entry] of Object.entries(raw)) {
      for (const [id, m] of Object.entries(entry.models ?? {})) {
        models[key(provider, id)] = {
          id,
          provider,
          contextWindow: m.limit?.context ?? 128_000,
          maxTokens: m.limit?.output,
          pricing: m.cost ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0 } : undefined,
          supportCache: m.cache === true,
          supportReasoning: m.reasoning === true,
        };
      }
    }
    if (Object.keys(models).length === 0) return null;
    return { fetchedAt: Date.now(), models };
  } catch {
    return null;
  }
}

/**
 * Load the catalog: cache (fresh ≤24h) → fetch → fallback snapshot.
 * Never throws; offline-safe.
 */
export async function loadCatalog(forceRefresh = false): Promise<{ models: Record<string, ModelInfo>; source: "cache" | "network" | "fallback" }> {
  if (!forceRefresh) {
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
      return { models: cached.models, source: "cache" };
    }
  }
  const fresh = await fetchCatalog();
  if (fresh) {
    writeCache(fresh);
    return { models: fresh.models, source: "network" };
  }
  const stale = readCache();
  if (stale) return { models: stale.models, source: "cache" };
  return { models: fromFallback().models, source: "fallback" };
}

/** Synchronous metadata lookup — cache then fallback (never fetches). */
export function lookupModel(provider: string, id: string): ModelInfo | null {
  const cached = readCache();
  if (cached) {
    const m = cached.models[key(provider, id)];
    if (m) return m;
  }
  const fb = fromFallback();
  // Exact key, then bare-id match across providers.
  return fb.models[key(provider, id)] ?? fb.models[key("openai", id)] ?? null;
}

/** contextWindow for the compaction budget (I-02 → H-10). Fallback 128k. */
export function contextWindowFor(provider: string, id: string): number {
  return lookupModel(provider, id)?.contextWindow ?? 128_000;
}

/** Catalog age in hours (for `scoder models --refresh` UX). -1 when no cache. */
export function cacheAgeHours(): number {
  if (!existsSync(CACHE_PATH)) return -1;
  try {
    return (Date.now() - statSync(CACHE_PATH).mtimeMs) / 3_600_000;
  } catch {
    return -1;
  }
}

/** I6: TTL cho refresh() — 1h. */
const REFRESH_TTL_MS = 3_600_000;
/** Monotonic last-refresh stamp (process lifetime — tránh re-fetch mỗi lookup). */
let lastRefreshAt = 0;

/**
 * I6: đảm bảo catalog tươi (TTL 1h) — process dùng lâu (server/TUI) gọi trước
 * khi tra cứu. Cache còn mới → no-op. Lỗi network → giữ catalogue hiện có
 * (không bao giờ throw). Returns source hiện hành.
 */
export async function refreshCatalog(): Promise<"cache" | "network" | "fallback"> {
  if (Date.now() - lastRefreshAt < REFRESH_TTL_MS) return "cache";
  const r = await loadCatalog(false);
  lastRefreshAt = Date.now();
  return r.source;
}
