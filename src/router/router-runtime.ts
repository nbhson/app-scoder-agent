/**
 * P2.2 Phase A (plan/P2-02 §1) — RouterRuntime: one MORE implementation of
 * `ProviderRuntimeContract`. The agent loop cannot tell it apart: chat /
 * streamChat classify the CURRENT turn (L1 score → L2 rules → L4 judge →
 * L3 hysteresis) and delegate to the chosen tier client. Clients are built
 * lazily and cached per model; a prompt-cache-friendly ref is kept while the
 * tier does not flip.
 *
 * Modes (§4c): "pinned" = every turn goes to one exact ref, router EMITS
 * NOTHING; "auto" = the per-turn pipeline. `/model <ref>` pins, `/model auto`
 * hands control back. `enabled:false` never constructs this class at all.
 */
import type { ChatMessage, ChatResult, StreamChunk, ToolCall, ToolSpec } from "../llm/llm.js";
import { splitProviderModel, type ProviderRuntimeContract } from "../llm/provider-registry.js";
import {
  IDLE_TURN_CONTEXT,
  estimateHistoryTokens,
  type Judge,
  type JudgeVerdict,
  type ResolvedRouterConfig,
  type RouteDecision,
  type RouterModel,
  type Tier,
  type TurnContext,
} from "./types.js";
import { applyRules, classify, type ClassifySignals } from "./classifier.js";
import { hysteresisDecide, initialHysteresis, type HysteresisResult, type HysteresisState } from "./hysteresis.js";

/** Mirrors MCP_TOOL_PREFIX (src/mcp/types.ts) — a local const keeps the
 *  router→mcp layer edge at zero; the wire names are the contract. */
const MCP_TOOL_PREFIX = "mcp__";

/**
 * Schema JSON size of the CORE tools only. MCP schemas are constant per
 * session (one github-mcp ≈ 30k+ chars on every single turn) — a constant
 * must not decide whether "chào" is a heavy turn. toolCount still counts
 * everything so `rules` on `tools` keep their meaning.
 */
function coreSchemaChars(tools: ToolSpec[]): number {
  const core = tools.filter((t) => !t.function?.name.startsWith(MCP_TOOL_PREFIX));
  return core.length > 0 ? JSON.stringify(core).length : 0;
}

export interface RouterRuntimeOptions {
  /** Validated candidates (Phase B guarantees ≥1 + fallback present). */
  models: RouterModel[];
  /** Ref used whenever a pick would otherwise be empty (doubt, error, no tool model). */
  fallbackRef: string;
  config: ResolvedRouterConfig;
  /** Lazy client builder — injected so tests run fake clients (eval short-circuits earlier). */
  makeClient: (m: RouterModel) => ProviderRuntimeContract;
  /** Live turn context; omit → all-idle signals (pure L1/L2 from messages). */
  sensors?: () => TurnContext;
  /** Decision sink (Phase B: Agent.emit route_decision → JSONL → tab ROUTER). */
  onRoute?: (d: RouteDecision) => void;
  /** L4 — undefined when `router.judge` is null/absent: pipeline stays 3-layer, 0 extra requests. */
  judge?: Judge;
  mode?: "auto" | "pinned";
  pinnedRef?: string;
}

export class RouterRuntime implements ProviderRuntimeContract {
  private models: RouterModel[];
  private fallback: RouterModel;
  private readonly opts: RouterRuntimeOptions;
  private readonly clients = new Map<string, ProviderRuntimeContract>();
  private hyst: HysteresisState = initialHysteresis(null);
  private prevRef: string | null = null;
  private lastDecision: RouteDecision | null = null;
  private mode: "auto" | "pinned";
  private pinnedRef: string | null;

  constructor(options: RouterRuntimeOptions) {
    if (options.models.length === 0) throw new Error("RouterRuntime: no tier models");
    const fb = options.models.find((m) => m.ref === options.fallbackRef);
    if (!fb) throw new Error(`RouterRuntime: fallback "${options.fallbackRef}" not among tiers`);
    this.opts = options;
    this.models = options.models;
    this.fallback = fb;
    this.mode = options.mode ?? "pinned";
    this.pinnedRef = null;
    if (this.mode === "pinned") {
      const want = options.pinnedRef ?? options.fallbackRef;
      this.pinnedRef = this.findByRef(want) ? want : options.fallbackRef;
    }
  }

  // ── ProviderRuntimeContract surface ──────────────────────────────────────

  /** Bare model id of the ACTIVE target — keeps `llm_usage` JSONL honest. */
  get model(): string {
    return this.currentModel().model;
  }

  /**
   * §4c semantics for `/model`: "auto" → hand the pipeline control; a tier
   * ref (or bare unique id) → PIN; anything else → pin as an external model
   * on the fallback provider (Phase B's factory resolves the transport).
   */
  setModel(idOrAuto: string): void {
    if (idOrAuto === "auto") {
      this.mode = "auto";
      this.pinnedRef = null;
      return;
    }
    const m = this.findByRef(idOrAuto) ?? this.findByBare(idOrAuto);
    if (m) {
      this.mode = "pinned";
      this.pinnedRef = m.ref;
      this.clientFor(m); // warm the cache so the very next turn is instant
      return;
    }
    // External pin: synthetic candidate. A `provider/model` string keeps its
    // OWN provider label (pinning "anthropic/opus" must not masquerade as
    // "box-api/anthropic/opus"); a bare id rides on the fallback provider.
    // Phase B's makeRuntimeForRef resolves the transport from the merged map.
    const [extProv, extModel] = splitProviderModel(idOrAuto);
    const provider = extProv ?? this.fallback.provider;
    const model = extModel ?? idOrAuto;
    const ref = `${provider}/${model}`;
    this.mode = "pinned";
    this.pinnedRef = ref;
    this.models.push({ ref, tier: "large", model, provider, toolCall: true });
  }

  get lastPartialToolCalls(): ToolCall[] {
    return this.currentClient().lastPartialToolCalls;
  }
  set lastPartialToolCalls(v: ToolCall[]) {
    this.currentClient().lastPartialToolCalls = v;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    callOpts?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<ChatResult> {
    const m = await this.pickTurn(messages, tools);
    return this.clientFor(m).chat(messages, tools, callOpts);
  }

  async *streamChat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    callOpts?: { signal?: AbortSignal; idleTimeoutMs?: number },
  ): AsyncGenerator<StreamChunk> {
    const m = await this.pickTurn(messages, tools);
    yield* this.clientFor(m).streamChat(messages, tools, callOpts);
  }

  // ── public router surface (Agent wiring / `/model` / `/router`) ──────────

  get routerMode(): "auto" | "pinned" {
    return this.mode;
  }
  get activeRef(): string {
    return this.currentModel().ref;
  }
  get lastRouteDecision(): RouteDecision | null {
    return this.lastDecision;
  }
  /** The validated candidate list (read-only) — `/router` status + tab graph. */
  get candidates(): readonly RouterModel[] {
    return this.models;
  }
  /** Active L4 judge label — null = pure 3-layer pipeline (nothing configured or judge disabled). */
  get judgeLabel(): string | null {
    return this.opts.judge?.describe?.() ?? null;
  }

  /**
   * P2.2 hot-reload (rc edit): swap the candidate list but KEEP hysteresis
   * state and the client cache — the next turn simply routes on the new
   * tiers. Invalid input → no change, returns false (caller keeps old tiers).
   */
  setTiers(models: RouterModel[], fallbackRef: string): boolean {
    const fb = models.find((m) => m.ref === fallbackRef);
    if (models.length === 0 || !fb) return false;
    this.models = models;
    this.fallback = fb;
    for (const ref of [...this.clients.keys()]) {
      if (!models.some((m) => m.ref === ref)) this.clients.delete(ref);
    }
    if (this.mode === "pinned" && !this.findByRef(this.pinnedRef ?? "")) this.pinnedRef = fallbackRef;
    this.prevRef = this.currentModel().ref;
    return true;
  }

  // ── the pipeline ─────────────────────────────────────────────────────────

  private findByRef(ref: string): RouterModel | undefined {
    return this.models.find((m) => m.ref === ref);
  }
  private findByBare(id: string): RouterModel | undefined {
    const hits = this.models.filter((m) => m.model === id);
    return hits.length === 1 ? hits[0] : undefined;
  }

  private currentModel(): RouterModel {
    const ref = this.mode === "pinned" ? this.pinnedRef : (this.lastDecision?.ref ?? this.fallback.ref);
    return this.findByRef(ref ?? "") ?? this.fallback;
  }
  private currentClient(): ProviderRuntimeContract {
    return this.clientFor(this.currentModel());
  }

  private clientFor(m: RouterModel): ProviderRuntimeContract {
    let c = this.clients.get(m.ref);
    if (!c) {
      c = this.opts.makeClient(m);
      this.clients.set(m.ref, c);
    }
    return c;
  }

  /**
   * Resolve this turn's target model. PINNED: zero work, zero emissions.
   * AUTO: L1 → L2 override → (L4 judge when configured & in scope) → L3
   * hysteresis → tier-internal selection with cache affinity. Never throws:
   * any internal error degrades to the fallback ref.
   */
  private async pickTurn(messages: ChatMessage[], tools: ToolSpec[]): Promise<RouterModel> {
    if (this.mode === "pinned") {
      const m = this.findByRef(this.pinnedRef ?? "") ?? this.fallback;
      this.prevRef = m.ref;
      return m;
    }
    try {
      return await this.pickAuto(messages, tools);
    } catch {
      // A router bug must never kill the run — deterministic way home (§3 table).
      this.prevRef = this.fallback.ref;
      return this.fallback;
    }
  }

  /** Cheap, request-local signals — no extra LLM call, no I/O (§2). */
  private turnSignals(messages: ChatMessage[], tools: ToolSpec[]): ClassifySignals {
    return {
      estTokens: estimateHistoryTokens(messages),
      toolSchemaChars: coreSchemaChars(tools),
      toolCount: tools.length,
      endsInToolResults: messages.length > 0 && messages[messages.length - 1].role === "tool",
    };
  }

  private async pickAuto(messages: ChatMessage[], tools: ToolSpec[]): Promise<RouterModel> {
    const ctx = this.opts.sensors?.() ?? IDLE_TURN_CONTEXT;
    const sig = this.turnSignals(messages, tools);

    // L2 first (it overrides L1 and even the judge — "a rule is a human pin").
    const rule = applyRules(this.opts.config.rules, ctx, sig);
    const base = classify(sig, ctx, this.opts.config);
    let tier: Tier = rule ? rule.tier : base.tier;
    let reason = rule ? rule.reason : `score ${base.score > 0 ? "+" : ""}${base.score}: ${base.reason}`;
    const signals: Record<string, number | string> = { ...base.signals, mode: "auto" };

    // L4 judge — only when configured, no rule matched, and in scope (§3).
    // A rule is a human pin: the judge must not second-guess it.
    let judgeHit: RouterModel | null = null;
    const judged = rule ? null : await this.maybeJudge(base, tier, reason, ctx, tools);
    if (judged) {
      tier = judged.tier;
      reason = judged.reason;
      judgeHit = judged.hit;
    }
    const judgeInfo = judged?.info;
    if (judgeInfo && judgeInfo.verdict === "accept") signals.judgeRef = judgeInfo.model;

    // L3 hysteresis wraps the pre-execution decision (build lock / sticky /
    // clean-streak demote). Win order (plan §Risks): pin > L2 rules > L4
    // judge > L1 > L3 — a judge ACCEPT beats a SOFT hold, but a hard
    // "escalate:" from L3 always wins (safety beats opinion).
    const { result, state } = hysteresisDecide(tier, this.hyst, ctx, this.opts.config.escalate);
    ({ tier, reason } = this.applyHysteresis(result, tier, reason, judgeInfo?.verdict === "accept"));
    // Store the EFFECTIVE tier so the next turn's hysteresis starts from what
    // actually ran, not from the value the judge vetoed away.
    this.hyst = { ...state, tier };

    // An accepted judge ref is EXACT (tie-break within a tier is its whole
    // point) — only a tier flip by L3 re-ranks and drops the judge's pick.
    const m = judgeHit && judgeHit.tier === tier ? judgeHit : this.pickInTier(tier, tools.length > 0);
    this.emitDecision({ ctx, tier, reason, signals, m, judgeInfo });
    return m;
  }

  /** Judge accepts beat SOFT holds; hard "escalate:" always wins. */
  private applyHysteresis(
    result: HysteresisResult,
    tier: Tier,
    reason: string,
    judgeAccepted: boolean,
  ): { tier: Tier; reason: string } {
    if (!result.override) return { tier, reason };
    if (judgeAccepted && result.tier !== tier && !result.override.startsWith("escalate")) return { tier, reason };
    return { tier: result.tier, reason: `${reason} · ${result.override}` };
  }

  /** Record + publish this turn's decision (audit `switched` = client flip). */
  private emitDecision(d: {
    ctx: TurnContext;
    tier: Tier;
    reason: string;
    signals: Record<string, number | string>;
    m: RouterModel;
    judgeInfo?: RouteDecision["judge"];
  }): void {
    const decision: RouteDecision = {
      step: d.ctx.step,
      tier: d.tier,
      ref: d.m.ref,
      provider: d.m.provider,
      model: d.m.model,
      reason: d.reason,
      signals: d.signals,
      switched: d.m.ref !== this.prevRef,
      ...(d.judgeInfo ? { judge: d.judgeInfo } : {}),
    };
    this.prevRef = d.m.ref;
    this.lastDecision = decision;
    this.opts.onRoute?.(decision);
  }

  /** Judge gate: configured + in scope → one validated round; else null. */
  private async maybeJudge(
    base: { gray: boolean },
    tier: Tier,
    reason: string,
    ctx: TurnContext,
    tools: ToolSpec[],
  ): Promise<{ tier: Tier; reason: string; hit: RouterModel | null; info: NonNullable<RouteDecision["judge"]> } | null> {
    const judge = this.opts.judge;
    if (!judge) return null;
    const scope = this.opts.config.judge?.scope ?? "gray";
    if (!this.judgeInScope(scope, base, ctx, tier)) return null;
    const cands = this.models.filter((m) => (tools.length === 0 ? true : m.toolCall));
    return this.askJudge(judge, ctx, cands, { tier, reason }, this.opts.config.judge?.minConfidence ?? 0.6);
  }

  /** When L4 fires (§3 scope table): gray band / first+tier-flip / always. */
  private judgeInScope(scope: string, base: { gray: boolean }, ctx: TurnContext, tier: Tier): boolean {
    if (scope === "always") return true;
    if (scope === "first") return ctx.step <= 1 || (this.hyst.tier !== null && this.hyst.tier !== tier);
    return scope === "gray" && base.gray;
  }

  /**
   * One judge round with full anti-hallucination validation (§3 table).
   * Rejects return the untouched L1+L2 result — a judge can upgrade a
   * decision, never break one.
   */
  private async askJudge(
    judge: Judge,
    ctx: TurnContext,
    cands: RouterModel[],
    base: { tier: Tier; reason: string },
    minConfidence: number,
  ): Promise<{ tier: Tier; reason: string; hit: RouterModel | null; info: NonNullable<RouteDecision["judge"]> }> {
    const v = await judge.judge(ctx, cands, base).catch((err) => {
      // Contract says Judge never throws — but a plugin judge that does must
      // not sink the run (plan §Risks: "0 exception mới").
      return { tier: null, ref: null, confidence: 0, reason: `judge-error:${(err as Error).message}`, ms: 0, tokens: 0 } as JudgeVerdict;
    });
    const info: NonNullable<RouteDecision["judge"]> = {
      model: v.ref ?? "",
      confidence: v.confidence,
      ms: v.ms,
      tokens: v.tokens,
      verdict: "fallback",
    };
    const hit = v.ref ? cands.find((m) => m.ref === v.ref || m.model === v.ref) : undefined;
    if (!hit) {
      // Honest audit: a missing ref is NOT a hallucination — timeouts and
      // errors fall back quietly (plan AC: "⤳j fallback").
      const why = v.ref ? "reject-hallucinated" : v.reason.startsWith("judge-timeout") ? "timeout" : "fallback";
      info.verdict = why;
      info.model = "";
      const tag = why === "timeout" ? "judge-timeout" : why === "fallback" ? "judge-fallback" : "judge-reject(hallucinated)";
      return { tier: base.tier, reason: `${base.reason} · ${tag}`, hit: null, info };
    }
    if (v.confidence < minConfidence) {
      info.verdict = "reject-confidence";
      return { tier: base.tier, reason: `${base.reason} · judge-reject(confidence)`, hit: null, info };
    }
    // Accept: ref wins, tier is DERIVED from the candidate (a tier mismatch is
    // audited as judge-tier-mismatch but never vetoes the model itself).
    info.verdict = "accept";
    info.model = hit.ref;
    const mismatch = v.tier !== null && v.tier !== hit.tier;
    return {
      tier: hit.tier,
      reason: `judge: ${v.reason || hit.ref}${mismatch ? " · judge-tier-mismatch" : ""}`,
      hit,
      info,
    };
  }

  /**
   * Tier-internal pick with prompt-cache affinity: keep the previous ref when
   * the tier did not flip; otherwise rank — small = cheapest, large = most
   * context (cost as tie-break). No usable model in the tier → fallback.
   */
  private pickInTier(tier: Tier, turnHasTools: boolean): RouterModel {
    const inTier = this.models.filter((m) => m.tier === tier && (turnHasTools ? m.toolCall : true));
    if (inTier.length === 0) return this.fallback;
    const last = this.lastDecision;
    if (last && last.tier === tier) {
      const keep = inTier.find((m) => m.ref === last.ref);
      if (keep) return keep;
    }
    const NO_PRICE = Number.MAX_SAFE_INTEGER; // unknown cost ≠ cheapest — sort last
    const byCtx = (a: RouterModel, b: RouterModel) =>
      (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || (a.pricing?.output ?? 0) - (b.pricing?.output ?? 0);
    const byCost = (a: RouterModel, b: RouterModel) =>
      (a.pricing?.output ?? NO_PRICE) - (b.pricing?.output ?? NO_PRICE) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
    const ranked = [...inTier].sort(tier === "large" ? byCtx : byCost);
    return ranked[0];
  }
}
