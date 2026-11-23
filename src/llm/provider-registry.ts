/**
 * Provider Registry v2 (I-01) — unified runtime selection.
 *
 * Source: anomalyco/opencode (packages/core/src/provider.ts) — concept
 * adapted: registry resolving a provider id → client runtime, from
 * config `providers.<id>` entries + built-ins. No npm plugins in v1.0.
 *
 * Built-ins:
 *   openai            — OpenAI chat-completions (default)
 *   anthropic         — native Messages API (prompt caching, thinking)
 *   openai-compatible — any OpenAI-compatible endpoint (DeepSeek, Groq, Together…)
 *   ollama            — local Ollama (http://localhost:11434/v1)
 *   gemini            — Gemini via its OpenAI-compat endpoint
 */
import { LlmClient, type ChatMessage, type ToolCall, type ToolSpec } from "./llm.js";
import { AnthropicClient } from "./provider-anthropic.js";

/**
 * P2.1 (plan/P2-01-provider-config.md): per-model metadata from the rc
 * `provider.<id>.models` block — opencode config shape (`limit`, `cost`,
 * `reasoning`, `tool_call`) mapped onto runtime fields.
 */
export interface ModelConfig {
  /** Display name for UI (opencode `name`); defaults to the model id. */
  name?: string;
  /** opencode `limit.context` — tokens the model can hold. */
  contextWindow?: number;
  /** opencode `limit.output` — max completion tokens. */
  maxTokens?: number;
  /** opencode `cost.{input,output}` — USD per 1M tokens. */
  pricing?: { input: number; output: number };
  supportCache?: boolean;
  /** opencode `reasoning` — thinking/reasoning blocks supported. */
  supportReasoning?: boolean;
  /** opencode `tool_call` — false → never pick for tool loops (router). */
  toolCall?: boolean;
}

export interface ProviderDef {
  id: string;
  baseUrl: string;
  /** Env var name holding the API key (never the key itself). */
  apiKeyEnv: string;
  /** Built-in runtime kind. */
  kind: "openai" | "anthropic";
  /** rc `name` — human label for `/model`, `scoder models`, sidebar. */
  displayName?: string;
  /** Inline key from rc `options.apiKey` ({env:VAR} expanded). Lowest env, higher rc.apiKey. */
  apiKeyInline?: string;
  /** opencode `models` map — id → metadata; undefined when not declared. */
  models?: Record<string, ModelConfig>;
  /** Optional extra headers merged into every request. */
  headers?: Record<string, string>;
  /** True when this provider supports Anthropic prompt caching. */
  supportCache?: boolean;
  /** True when reasoning/thinking blocks are supported. */
  supportReasoning?: boolean;
}

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_LMSTUDIO_BASE_URL = "http://localhost:1234/v1";

/** Built-in provider definitions (lowest priority — rc/env override). */
export const BUILTIN_PROVIDERS: Record<string, ProviderDef> = {
  openai: { id: "openai", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", kind: "openai" },
  anthropic: {
    id: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    kind: "anthropic",
    supportCache: true,
    supportReasoning: true,
  },
  "openai-compatible": { id: "openai-compatible", baseUrl: "", apiKeyEnv: "SCODER_API_KEY", kind: "openai" },
  ollama: { id: "ollama", baseUrl: DEFAULT_OLLAMA_BASE_URL, apiKeyEnv: "OLLAMA_API_KEY", kind: "openai", supportReasoning: true },
  gemini: { id: "gemini", baseUrl: DEFAULT_GEMINI_BASE_URL, apiKeyEnv: "GEMINI_API_KEY", kind: "openai" },
};

/** Runtime either client type exposes (structural — both already match). */
export type ProviderRuntime = LlmClient | AnthropicClient;

/**
 * I1: interface runtime chính thức — Agent/session code chỉ được dùng surface
 * này; mọi cast `as {...}` đã xoá. Hai client implement structural-match.
 */
export interface ProviderRuntimeContract {
  readonly model: string;
  /** T-04: hot-swap model id — request sau dùng model mới. */
  setModel(model: string): void;
  /** H-09: tool calls dồn từ stream bị đứt (continuation). */
  lastPartialToolCalls: ToolCall[];
  chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<import("./llm.js").ChatResult>;
  streamChat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts?: { signal?: AbortSignal; idleTimeoutMs?: number },
  ): AsyncGenerator<import("./llm.js").StreamChunk>;
}

export interface ProviderRuntimeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  stream?: boolean;
  /** I-04: enable Anthropic prompt caching (providerDef.supportCache). */
  enableCache?: boolean;
  /** P2.1: extra headers from the provider def, merged into every request. */
  headers?: Record<string, string>;
}

/** Create the concrete runtime for a provider def. */
export function createRuntime(def: ProviderDef, opts: ProviderRuntimeOptions): ProviderRuntime {
  const common = {
    baseUrl: opts.baseUrl || def.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    enableCache: opts.enableCache ?? def.supportCache,
    headers: opts.headers ?? def.headers,
  };
  if (def.kind === "anthropic") return new AnthropicClient(common);
  return new LlmClient({ ...common, stream: opts.stream });
}

/** A configured custom provider from rc: providers.<id> = {baseUrl, apiKeyEnv, kind, ...}. */
export function parseCustomProviders(raw: unknown): Record<string, ProviderDef> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ProviderDef> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const d = v as { baseUrl?: unknown; apiKeyEnv?: unknown; kind?: unknown; supportCache?: unknown; supportReasoning?: unknown };
    if (typeof d.baseUrl !== "string" || !d.baseUrl) continue;
    out[id] = {
      id,
      baseUrl: d.baseUrl,
      apiKeyEnv: typeof d.apiKeyEnv === "string" ? d.apiKeyEnv : "SCODER_API_KEY",
      kind: d.kind === "anthropic" ? "anthropic" : "openai",
      supportCache: d.supportCache === true,
      supportReasoning: d.supportReasoning === true,
    };
  }
  return out;
}

/**
 * Resolve a provider id → def. Model may be "provider/model" (splits).
 * Returns null with a clean reason when the key env var is missing.
 */
export function resolveProvider(
  id: string,
  custom: Record<string, ProviderDef> = {},
): { def: ProviderDef } | { error: string } {
  const def = custom[id] ?? BUILTIN_PROVIDERS[id];
  if (!def) {
    return { error: `unknown provider "${id}" — available: ${Object.keys({ ...BUILTIN_PROVIDERS, ...custom }).join(", ")}` };
  }
  return { def };
}

/** Split "provider/model" syntax; returns [provider, model] (unchanged when no slash). */
export function splitProviderModel(model: string): [string | null, string] {
  const idx = model.indexOf("/");
  if (idx <= 0) return [null, model];
  // anthropic/claude-x, openai/gpt-4o, groq/llama-3…
  // Only the FIRST slash splits — ids with dots ("kimi-k2.7-code") or later
  // slashes ("meta-llama/llama-3" inside a provider) survive intact.
  return [model.slice(0, idx), model.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// P2.1 (plan/P2-01-provider-config.md): opencode-style `provider` block.
// ---------------------------------------------------------------------------

/** `npm` → runtime kind. Repo has 0 runtime deps: npm is only a HINT, the
 *  plugin is never imported. Unknown → "openai" (compatible) + warn once. */
const NPM_KIND: Record<string, "openai" | "anthropic"> = {
  "@ai-sdk/openai-compatible": "openai",
  "@ai-sdk/openai": "openai",
  openai: "openai",
  "@ai-sdk/anthropic": "anthropic",
  anthropic: "anthropic",
};
const warnedNpm = new Set<string>();

/** Expand `{env:VAR}` in one string (same syntax as src/mcp/env.ts). */
export function expandEnvValue(value: string): string {
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => process.env[n] ?? "");
}

const positiveInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/** First boolean found among the given (alias) values. */
const boolOf = (...vals: unknown[]): boolean | undefined => {
  for (const v of vals) if (typeof v === "boolean") return v;
  return undefined;
};

/** First non-empty string among the given values. */
const strOf = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === "string" && v) return v;
  return undefined;
};

/** `models.<id>.cost.{input,output}` (opencode) or flat `pricing` → USD/1M pair. */
function parseCost(cost: unknown, pricing: unknown): { input: number; output: number } | undefined {
  const src = (typeof pricing === "object" && pricing !== null ? pricing : cost) as Record<string, unknown> | undefined;
  if (!src || typeof src !== "object") return undefined;
  const i = src.input;
  const o = src.output;
  return typeof i === "number" && Number.isFinite(i) && typeof o === "number" && Number.isFinite(o)
    ? { input: i, output: o }
    : undefined;
}

/** Parse one `models.<id>` entry (opencode `limit`/`cost`/`reasoning`/`tool_call`,
 *  flat aliases accepted too). Bad entry → undefined (caller warns + skips). */
function parseModelEntry(raw: unknown): ModelConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const limit = (typeof m.limit === "object" && m.limit !== null ? m.limit : {}) as Record<string, unknown>;
  const cfg: ModelConfig = {};
  const name = strOf(m.name);
  if (name) cfg.name = name;
  const ctx = positiveInt(m.contextWindow ?? limit.context);
  if (ctx !== undefined) cfg.contextWindow = ctx;
  const max = positiveInt(m.maxTokens ?? limit.output);
  if (max !== undefined) cfg.maxTokens = max;
  const pricing = parseCost(m.cost, m.pricing);
  if (pricing) cfg.pricing = pricing;
  const cache = boolOf(m.supportCache, m.cache);
  if (cache !== undefined) cfg.supportCache = cache;
  const reason = boolOf(m.supportReasoning, m.reasoning);
  if (reason !== undefined) cfg.supportReasoning = reason;
  const tools = boolOf(m.toolCall, m.tool_call);
  if (tools !== undefined) cfg.toolCall = tools;
  return cfg;
}

/** npm → runtime kind + one-time warn on unknown hints (no plugin loading). */
function kindFromNpm(
  npm: unknown,
  fallback: "openai" | "anthropic",
  providerId: string,
): "openai" | "anthropic" {
  if (typeof npm !== "string" || !npm) return fallback;
  const mapped = NPM_KIND[npm];
  if (mapped) return mapped;
  if (!warnedNpm.has(npm)) {
    warnedNpm.add(npm);
    console.error(`⚠  ignoring unknown npm "${npm}" for provider "${providerId}" — using openai-compatible runtime`);
  }
  return "openai";
}

/** Record view of a possibly-missing/non-object JSON field. */
const objOf = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** `options.headers` — string values only, {env:} expanded. */
function parseHeaderMap(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, hv] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof hv === "string") out[k] = expandEnvValue(hv);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `models` map — per-entry validate, warn + drop the bad ones. */
function parseModelsMap(raw: unknown, providerId: string): Record<string, ModelConfig> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const models: Record<string, ModelConfig> = {};
  for (const [mid, mv] of Object.entries(raw as Record<string, unknown>)) {
    const cfg = parseModelEntry(mv);
    if (cfg) models[mid] = cfg;
    else console.error(`⚠  ignoring invalid model "${mid}" in provider "${providerId}" (expected an object)`);
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

/** Optional fields of a provider entry, written onto `def` in place. */
function applyProviderExtras(
  d: Record<string, unknown>,
  options: Record<string, unknown>,
  builtin: ProviderDef | undefined,
  def: ProviderDef,
): void {
  const name = strOf(d.name);
  if (name) def.displayName = name;
  const inline = strOf(options.apiKey);
  const expanded = inline ? expandEnvValue(inline) : "";
  if (expanded) def.apiKeyInline = expanded;
  const headers = parseHeaderMap(options.headers);
  if (headers) def.headers = headers;
  const cache = boolOf(d.supportCache, builtin?.supportCache);
  if (cache !== undefined) def.supportCache = cache;
  const reasoning = boolOf(d.supportReasoning, builtin?.supportReasoning);
  if (reasoning !== undefined) def.supportReasoning = reasoning;
  const models = parseModelsMap(d.models, def.id);
  if (models) def.models = models;
}

/** One `provider.<id>` entry → ProviderDef; invalid → undefined + console.error. */
function parseProviderEntry(id: string, v: unknown, builtin: ProviderDef | undefined): ProviderDef | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    console.error(`⚠  ignoring invalid provider "${id}" (expected an object)`);
    return undefined;
  }
  const d = v as Record<string, unknown>;
  const options = objOf(d.options);
  const baseUrl = strOf(options.baseURL) ?? builtin?.baseUrl ?? "";
  if (!baseUrl) {
    console.error(`⚠  ignoring provider "${id}" — options.baseURL is required`);
    return undefined;
  }
  const def: ProviderDef = {
    id,
    baseUrl,
    apiKeyEnv: strOf(options.apiKeyEnv, d.apiKeyEnv, builtin?.apiKeyEnv) ?? "SCODER_API_KEY",
    kind: kindFromNpm(d.npm, builtin?.kind ?? "openai", id),
  };
  applyProviderExtras(d, options, builtin, def);
  return def;
}

/**
 * Parse the NEW rc `provider` block (opencode shape): id → {npm, name,
 * options:{baseURL, apiKey, headers}, models}. `loadConfig` distinguishes by
 * SHAPE — a STRING `rc.provider` is the legacy active-provider selector and
 * must be routed to `undefined` here, not to this parser.
 *
 * Validation mirrors parseCustomProviders: bad entry → console.error + skip,
 * never throw. Ids containing "/" are dropped (they break the provider/model
 * split). Missing baseURL: inherit the builtin of the same id, else skip.
 */
export function parseProviderConfig(raw: unknown): Record<string, ProviderDef> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, ProviderDef> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (id.includes("/")) {
      console.error(`⚠  provider id "${id}" contains "/" — skipped (it would break provider/model refs)`);
      continue;
    }
    const def = parseProviderEntry(id, v, BUILTIN_PROVIDERS[id]);
    if (def) out[id] = def;
  }
  return out;
}

/** Every configured provider that declares `id` in its `models` map. */
export function findModelOwners(
  id: string,
  providers: Record<string, ProviderDef>,
): Array<{ provider: ProviderDef; model: ModelConfig }> {
  const out: Array<{ provider: ProviderDef; model: ModelConfig }> = [];
  for (const def of Object.values(providers)) {
    const m = def.models?.[id];
    if (m) out.push({ provider: def, model: m });
  }
  return out;
}

/** Unique owner of a bare model id among configured providers; null when 0 or >1. */
export function findModelOwner(
  id: string,
  providers: Record<string, ProviderDef>,
): { provider: string; model: ModelConfig } | null {
  const owners = findModelOwners(id, providers);
  if (owners.length !== 1) return null;
  return { provider: owners[0].provider.id, model: owners[0].model };
}

export type ModelRefResolution =
  | { def: ProviderDef | null; model: string }
  | { error: string };

/**
 * P2.1 §7: ONE resolution path for every "model ref" a user can write —
 * startup config, `scoder -m`, `/model`, rc `routing`, agent def `model:`,
 * and the P2.2 router. `def === null` means "bare id with no unique owner —
 * keep the current provider". `providers` = custom defs merged over builtins
 * (loadConfig / loadMergedProviders build that map).
 */
export function resolveModelRef(
  ref: string,
  providers: Record<string, ProviderDef> = {},
): ModelRefResolution {
  const trimmed = ref.trim();
  if (!trimmed) return { error: "empty model ref" };
  const [prov, id] = splitProviderModel(trimmed);
  if (prov) {
    const r = resolveProvider(prov, providers);
    if ("def" in r) return { def: r.def, model: id };
    return r;
  }
  const owners = findModelOwners(trimmed, providers);
  if (owners.length === 1) return { def: owners[0].provider, model: trimmed };
  return { def: null, model: trimmed };
}

// ---------------------------------------------------------------------------
// Local engine auto-discovery (I-03) — probe well-known local endpoints.
// ---------------------------------------------------------------------------

export interface LocalEngine {
  provider: ProviderDef;
  /** Model ids reported by the engine's /v1/models. */
  models: string[];
}

const LOCAL_PROBES: Array<{ id: string; baseUrl: string }> = [
  { id: "ollama", baseUrl: DEFAULT_OLLAMA_BASE_URL },
  { id: "lmstudio", baseUrl: DEFAULT_LMSTUDIO_BASE_URL },
  { id: "vllm", baseUrl: "http://localhost:8000/v1" },
];

/**
 * Probe local engines (300ms timeout each, concurrent). Returns engines that
 * answered /v1/models with a valid list. Never throws; offline-safe.
 */
export async function discoverLocalEngines(timeoutMs = 300): Promise<LocalEngine[]> {
  const probes = await Promise.allSettled(
    LOCAL_PROBES.map(async (p) => {
      const res = await fetch(`${p.baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
      if (models.length === 0) return null;
      const builtin = BUILTIN_PROVIDERS[p.id];
      const def: ProviderDef =
        builtin ?? { id: p.id, baseUrl: p.baseUrl, apiKeyEnv: "SCODER_API_KEY", kind: "openai" };
      return { provider: def, models } satisfies LocalEngine;
    }),
  );
  return probes
    .filter((r): r is PromiseFulfilledResult<LocalEngine | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v): v is LocalEngine => v !== null);
}
