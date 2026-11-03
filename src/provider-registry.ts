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

export interface ProviderDef {
  id: string;
  baseUrl: string;
  /** Env var name holding the API key (never the key itself). */
  apiKeyEnv: string;
  /** Built-in runtime kind. */
  kind: "openai" | "anthropic";
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
  chat(messages: ChatMessage[], tools: ToolSpec[], opts?: { signal?: AbortSignal }): Promise<import("./llm.js").ChatResult>;
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
  return [model.slice(0, idx), model.slice(idx + 1)];
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
