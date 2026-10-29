/**
 * Central constants: model pricing for cost estimation.
 *
 * Prices are USD per 1M tokens (input / output), approximate list prices.
 * They can be overridden per-project via the rc file:
 *
 *   .scoderrc.json:
 *   { "modelPricing": { "my-model": { "input": 1.0, "output": 2.0 } } }
 *
 * Keys are matched as a PREFIX of the model name (case-insensitive), so
 * "gpt-4o-mini" also covers "gpt-4o-mini-2024-07-18". More specific keys
 * (longer prefix) win.
 */

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

/** Fallback price when a model is unknown (deliberately conservative, not zero). */
export const DEFAULT_MODEL_PRICING: ModelPricing = { input: 0.5, output: 1.5 };

/** Approximate list prices, USD per 1M tokens. Longest matching prefix wins. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 1.1, output: 4.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
  "o4-mini": { input: 1.1, output: 4.4 },
  // Anthropic
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4": { input: 0.8, output: 4 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "claude-3-opus": { input: 15, output: 75 },
  // Popular local/OpenAI-compatible providers (mostly $0 or nominal)
  "llama3": { input: 0, output: 0 },
  "qwen": { input: 0, output: 0 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
};

/**
 * Resolve the price table for a model, honouring user overrides.
 * `overrides` maps model-name prefixes to pricing and always wins over the
 * built-in table. Longest matching prefix wins (case-insensitive).
 */
export function resolveModelPricing(
  model: string,
  overrides: Record<string, ModelPricing> = {},
): ModelPricing {
  const m = model.toLowerCase();
  let best: { key: string; pricing: ModelPricing } | null = null;
  // Built-in table first (longest prefix wins), then overrides — an override
  // with the SAME prefix length replaces the built-in entry.
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    const k = key.toLowerCase();
    if (m.startsWith(k) && (!best || k.length > best.key.length)) {
      best = { key: k, pricing };
    }
  }
  for (const [key, pricing] of Object.entries(overrides)) {
    const k = key.toLowerCase();
    if (m.startsWith(k) && (!best || k.length >= best.key.length)) {
      best = { key: k, pricing };
    }
  }
  return best ? best.pricing : DEFAULT_MODEL_PRICING;
}
