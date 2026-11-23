/**
 * P2.2 Phase B (plan/P2-02 §5, §4c) — turn rc `router.tiers` refs into live
 * RouterModel candidates using the P2.1 resolution path. Pure: takes the
 * merged provider map, returns models + human-readable warnings (the caller
 * decides where to print them). Never throws.
 */
import { resolveModelRef, type ProviderDef } from "../llm/provider-registry.js";
import type { RouterConfig, RouterModel, Tier } from "./types.js";

export interface TierResolution {
  models: RouterModel[];
  fallback: RouterModel | null;
  warnings: string[];
}

const byOutput = (m: RouterModel): number => m.pricing?.output ?? Number.MAX_SAFE_INTEGER;

function refOf(def: ProviderDef | null, model: string, rawRef: string, activeId: string): string {
  if (rawRef.includes("/")) return rawRef;
  return `${def?.id ?? activeId}/${model}`;
}

/** Resolve one tier ref; invalid/unknown → null + warning (ref dropped). */
function resolveTierRef(
  tier: Tier,
  rawRef: string,
  providers: Record<string, ProviderDef>,
  activeId: string,
  warnings: string[],
): RouterModel | null {
  const r = resolveModelRef(rawRef, providers);
  if ("error" in r) {
    warnings.push(`router: ref "${rawRef}" not resolvable (${r.error}) — dropped`);
    return null;
  }
  const model = r.model;
  const def = r.def;
  const meta = def?.models?.[model];
  // STRICTER than the `/model` escape hatch on purpose: a tier typo would
  // silently route half the traffic to a phantom model (plan: "ref hỏng →
  // tier rỗng → disabled-warn"). If the provider declares models, the ref
  // must be among them.
  if (def && Object.keys(def.models ?? {}).length > 0 && !meta) {
    warnings.push(`router: ref "${rawRef}" is not declared in provider "${def.id}" — dropped`);
    return null;
  }
  return {
    ref: refOf(def, model, rawRef, activeId),
    tier,
    model,
    provider: def?.id ?? activeId,
    toolCall: meta?.toolCall ?? true,
    contextWindow: meta?.contextWindow,
    pricing: meta?.pricing,
    ...(def ? { def } : {}),
  };
}

/**
 * Explicit tiers win. Without `router.tiers`, derive from every configured
 * model that declares pricing: cheapest half → small, dearest → large (§4c-2,
 * with a warning so the user pins tiers properly once they see the split).
 */
export function resolveRouterTiers(
  router: RouterConfig,
  providers: Record<string, ProviderDef>,
  activeId = "openai",
): TierResolution {
  const warnings: string[] = [];
  let models: RouterModel[] = [];
  for (const tier of ["small", "large"] as const) {
    for (const raw of router.tiers?.[tier] ?? []) {
      if (typeof raw !== "string" || !raw.trim()) {
        warnings.push(`router: bad ${tier} tier entry (expected a "provider/model" string) — skipped`);
        continue;
      }
      const m = resolveTierRef(tier, raw.trim(), providers, activeId, warnings);
      if (m) models.push(m);
    }
  }
  if (models.length === 0 && !router.tiers) {
    models = autoDeriveTiers(providers, warnings);
  }

  // Dedupe by ref (same model listed in both tiers → keep the FIRST listing).
  const seen = new Set<string>();
  models = models.filter((m) => !seen.has(m.ref) && seen.add(m.ref));

  const fallback = pickFallback(router, models, warnings);
  return { models, fallback, warnings };
}

function pickFallback(router: RouterConfig, models: RouterModel[], warnings: string[]): RouterModel | null {
  if (models.length === 0) return null;
  if (router.fallback) {
    const want = router.fallback.trim();
    const hit = models.find((m) => m.ref === want || m.model === want);
    if (hit) return hit;
    warnings.push(`router: fallback "${want}" is not among the tier models — using the largest`);
  }
  // Default fallback: the largest tier's top-context model (deterministic way
  // home must be the model that can ALWAYS take the work).
  const large = models.filter((m) => m.tier === "large");
  const pool = large.length > 0 ? large : models;
  return [...pool].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0];
}

function autoDeriveTiers(providers: Record<string, ProviderDef>, warnings: string[]): RouterModel[] {
  const priced: RouterModel[] = [];
  for (const def of Object.values(providers)) {
    for (const [mid, mc] of Object.entries(def.models ?? {})) {
      if (!mc.pricing) continue;
      priced.push({
        ref: `${def.id}/${mid}`,
        tier: "small", // provisional; split below
        model: mid,
        provider: def.id,
        toolCall: mc.toolCall ?? true,
        contextWindow: mc.contextWindow,
        pricing: mc.pricing,
        def,
      });
    }
  }
  if (priced.length < 2) {
    if (priced.length === 1) warnings.push('router: only one priced model — add "router.tiers" to enable routing');
    return [];
  }
  priced.sort((a, b) => byOutput(a) - byOutput(b));
  const half = Math.ceil(priced.length / 2);
  warnings.push(`router: no "router.tiers" — auto-derived small=${half} cheapest, large=${priced.length - half} dearest by cost.output`);
  return priced.map((m, i) => ({ ...m, tier: i < half ? ("small" as const) : ("large" as const) }));
}
