/**
 * Provider runtime bootstrap (P0-5): the ONE place that turns an AgentConfig
 * into a live LLM client, and the ONE place that decides which endpoint + key
 * a provider hot-swap must use.
 *
 * Why it exists: `setModel("anthropic/claude-…")` used to rebuild the client
 * with `baseUrl`/`apiKey` of the provider being LEFT (the OpenAI endpoint), so
 * the new Anthropic client POSTed to `https://api.openai.com/v1/messages` with
 * an OpenAI key. A swap must re-resolve the connection exactly like startup
 * does in `config/loadConfig`: registry endpoint wins, and the new provider's
 * own key env var wins — unless the user pinned a key (`--api-key` / rc
 * `apiKey`), which is provider-agnostic and therefore kept.
 */
import type { AgentConfig } from "../config/config.js";
import { loadMergedProviders } from "../config/config.js";
import { LlmClient } from "../llm/llm.js";
import { AnthropicClient } from "../llm/provider-anthropic.js";
import type { ProviderDef, ProviderRuntimeContract } from "../llm/provider-registry.js";
import { RouterRuntime } from "../router/router-runtime.js";
import { resolveRouterTiers } from "../router/tiers.js";
import { ROUTER_DEFAULTS, type ResolvedRouterConfig, type RouterModel } from "../router/types.js";

/** I-05: Anthropic reasoning budget = 25% of maxTokens, floor 1024. */
export function thinkingBudgetFor(config: Pick<AgentConfig, "reasoning" | "maxTokens">): number {
  return config.reasoning === "on" ? Math.max(1024, Math.floor(config.maxTokens * 0.25)) : 0;
}

/** True when the resolved def (or the legacy provider flag) is Anthropic. */
export function isAnthropicRuntime(config: AgentConfig): boolean {
  return (
    config.providerDef?.kind === "anthropic" || (!config.providerDef && config.provider === "anthropic")
  );
}

/**
 * Build the client for a config. `config.clientFactory` (eval harness, I-12)
 * short-circuits the real providers; it is a factory (not an instance) so
 * subagents each get their own scripted transcript. The factory short-circuits
 * BEFORE the router too — eval transcripts stay deterministic even with
 * `router.enabled` (plan P2.2 §1).
 */
export function createClientRuntime(config: AgentConfig): ProviderRuntimeContract {
  const override = config.clientFactory?.();
  if (override) return override;
  const router = makeRouterRuntime(config);
  if (router) return router;
  return buildClientForConfig(config);
}

/** Plain single-model client — the pre-P2.2 path, unchanged. */
function buildClientForConfig(config: AgentConfig): ProviderRuntimeContract {
  return buildClient({
    isAnthropic: isAnthropicRuntime(config),
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    stream: config.stream,
    supportCache: config.providerDef?.supportCache ?? true,
    reasoning: config.reasoning,
    requestTimeoutMs: config.limits?.requestTimeoutMs,
    headers: config.providerDef?.headers,
  });
}

/**
 * P2.2 §1: the runtime for ONE tier candidate. With a provider def it goes
 * through the exact hot-swap path (endpoint + provider-specific key are
 * re-resolved — P0-5 rules); without one it's the current transport with a
 * new model id, i.e. the old same-provider `setModel` semantics.
 */
export function makeRuntimeForRef(m: RouterModel, config: AgentConfig): ProviderRuntimeContract {
  if (m.def) {
    const conn = resolveSwapConnection(config, m.def);
    return createSwappedRuntime({ ...config, model: m.model }, m.def, conn);
  }
  return buildClient({
    isAnthropic: isAnthropicRuntime(config),
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: m.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    stream: config.stream,
    supportCache: config.providerDef?.supportCache ?? true,
    reasoning: config.reasoning,
    requestTimeoutMs: config.limits?.requestTimeoutMs,
    headers: config.providerDef?.headers,
  });
}

/** rc block → fully defaulted runtime config (plan §5: junk → defaults). */
export function resolveRouterRuntimeConfig(r: NonNullable<AgentConfig["router"]>): ResolvedRouterConfig {
  return {
    signals: {
      smallMaxCtxTokens: r.signals?.smallMaxCtxTokens ?? ROUTER_DEFAULTS.smallMaxCtxTokens,
      largeToolSchemaChars: r.signals?.largeToolSchemaChars ?? ROUTER_DEFAULTS.largeToolSchemaChars,
    },
    rules: r.rules ?? [],
    escalate: {
      buildFails: r.escalate?.buildFails ?? ROUTER_DEFAULTS.buildFails,
      stickyMinSteps: r.escalate?.stickyMinSteps ?? ROUTER_DEFAULTS.stickyMinSteps,
    },
    ...(r.judge ? { judge: r.judge } : {}),
  };
}

/**
 * P2.2: build the RouterRuntime for a config with `router.enabled` — or null
 * when the tiers cannot be honored (caller silently keeps the plain path,
 * the warning already printed by resolveRouterTiers at startup).
 *
 * Startup mode is PINNED unless loadConfig proved `"model": "auto"` resolved
 * (§4c: enabling is a config act, turning on is a user act).
 */
export function makeRouterRuntime(config: AgentConfig): ProviderRuntimeContract | null {
  if (!config.router?.enabled) return null;
  const t = resolveRouterTiers(
    config.router,
    loadMergedProviders(config.workdir),
    config.providerDef?.id ?? config.provider,
  );
  if (!t.fallback) return null;
  const rt = new RouterRuntime({
    models: t.models,
    fallbackRef: t.fallback.ref,
    config: resolveRouterRuntimeConfig(config.router),
    makeClient: (m) => makeRuntimeForRef(m, config),
    sensors: config.routerSensors,
    onRoute: config.onRoute,
    mode: "auto",
  });
  if (config.routerMode !== "auto") {
    // Pin to the startup model — reuses the `/model` path so bare/qualified/
    // external ids all land on the right transport.
    rt.setModel(config.providerDef ? `${config.providerDef.id}/${config.model}` : config.model);
  }
  return rt;
}

/**
 * P0-5: client for a provider hot-swap. Same builder as construction (so the
 * Anthropic thinking budget is not silently dropped on a switch), but it takes
 * the RESOLVED connection and never consults `clientFactory` — a swap means
 * the user really wants the other provider's transport.
 */
export function createSwappedRuntime(
  config: AgentConfig,
  def: ProviderDef,
  conn: SwapConnection,
): ProviderRuntimeContract {
  return buildClient({
    isAnthropic: def.kind === "anthropic",
    baseUrl: conn.baseUrl,
    apiKey: conn.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    stream: config.stream,
    supportCache: def.supportCache ?? true,
    reasoning: config.reasoning,
    requestTimeoutMs: config.limits?.requestTimeoutMs,
    headers: def.headers,
  });
}

/** Shared construction path — the only place a provider client is `new`-ed. */
function buildClient(o: {
  isAnthropic: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  stream?: boolean;
  supportCache: boolean;
  reasoning?: "off" | "on";
  requestTimeoutMs?: number;
  /** P2.1: extra request headers from the provider def. */
  headers?: Record<string, string>;
}): ProviderRuntimeContract {
  const common = {
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    model: o.model,
    maxTokens: o.maxTokens,
    temperature: o.temperature,
    requestTimeoutMs: o.requestTimeoutMs, // G7
    ...(o.headers ? { headers: o.headers } : {}),
  };
  if (o.isAnthropic) {
    return new AnthropicClient({
      ...common,
      enableCache: o.supportCache,
      thinkingBudgetTokens: thinkingBudgetFor({ reasoning: o.reasoning, maxTokens: o.maxTokens }),
    });
  }
  return new LlmClient({ ...common, stream: o.stream });
}

/** Connection settings for a provider hot-swap (`/model provider/model`). */
export interface SwapConnection {
  baseUrl: string;
  apiKey: string;
  /** What decided the key — surfaced in the `/model` notice so a wrong key is visible. */
  keySource: "pinned" | "provider-env" | "shared-env" | "provider-rc" | "kept";
  /** Endpoint came from the provider definition rather than the current config. */
  endpointFromDef: boolean;
}

/**
 * Re-resolve endpoint + key for a cross-provider switch.
 *
 * baseUrl: the def's own endpoint wins (`api.anthropic.com/v1`, `…/v1beta/openai`,
 * a rc-declared custom provider…). Only defs without an endpoint — the
 * `openai-compatible` escape hatch — inherit the current baseUrl.
 * apiKey: a pinned key (`--api-key`, rc `apiKey`, programmatic override) is
 * provider-agnostic and stays; otherwise the new provider's env var wins, then
 * `SCODER_API_KEY`, then the TARGET def's own rc inline key (P2.1). A key that
 * came from the provider we are LEAVING (`provider-rc`) is provider-specific —
 * it must never travel to the new one.
 */
export function resolveSwapConnection(config: AgentConfig, def: ProviderDef): SwapConnection {
  const baseUrl = def.baseUrl || config.baseUrl;
  // `undefined` source = constructed programmatically (SDK/tests) with an
  // explicit key — never second-guessed. Only env-derived keys are re-resolved.
  const pinned =
    config.apiKeySource === undefined || config.apiKeySource === "flag" || config.apiKeySource === "rc";
  const consultEnv = !pinned || !config.apiKey; // an empty key is never "pinned"
  let apiKey = config.apiKey;
  let keySource: SwapConnection["keySource"] = pinned ? "pinned" : "kept";
  if (consultEnv) {
    const providerEnv = def.apiKeyEnv ? process.env[def.apiKeyEnv] : undefined;
    const sharedEnv = process.env.SCODER_API_KEY;
    if (providerEnv) {
      apiKey = providerEnv;
      keySource = "provider-env";
    } else if (sharedEnv) {
      apiKey = sharedEnv;
      keySource = "shared-env";
    } else if (def.apiKeyInline) {
      apiKey = def.apiKeyInline;
      keySource = "provider-rc";
    } else if (config.apiKeySource === "provider-rc") {
      apiKey = ""; // drop the leaving provider's inline key — P0-5 bug class
      keySource = "kept";
    }
  }
  return { baseUrl, apiKey, keySource, endpointFromDef: Boolean(def.baseUrl) };
}
