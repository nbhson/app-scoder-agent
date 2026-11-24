/**
 * P2.2 Phase E (plan/P2-02-model-router.md §3) — the L4 "judge": one cheap
 * model looks at the gray-band decision and NAMES THE EXACT candidate.
 *
 * Contract with RouterRuntime: `judge()` NEVER throws. Every failure —
 * timeout, transport error, junk output — comes back as a null-ref verdict,
 * and the pipeline falls through to the plain L1+L2 result. A judge can
 * upgrade a decision, never break one.
 *
 * Cost discipline (§3): prompt ≤ ~600 tokens, a TTL cache so repeated
 * same-shape turns ask once, and the call goes through a bare client — it
 * never touches the Agent loop, so judge traffic is invisible to
 * `llm_usage`/modelStats/cost by construction.
 */
import type { ChatMessage, ToolSpec } from "../llm/llm.js";
import type { Judge, JudgeVerdict, RouterModel, TurnContext } from "./types.js";

/** Minimal client surface (ProviderRuntimeContract satisfies this). */
export interface JudgeClient {
  chat(messages: ChatMessage[], tools: ToolSpec[], opts?: { signal?: AbortSignal; maxTokens?: number }): Promise<{
    message: { content: string | null };
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>;
}

export interface JudgeOptions {
  client: JudgeClient;
  /** Display label for audit (`/router`, route events). */
  model: string;
  timeoutMs?: number;
  /** Same-shape turns reuse the verdict (default 10 minutes). */
  ttlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_TTL_MS = 600_000;
const CACHE_MAX = 64;

const JUDGE_SYSTEM =
  "You are a model-routing judge for a coding agent. Given the current turn context and a list of candidate models, pick the single best candidate for THIS turn. " +
  "Rules: small-tier models are cheap and fine for short mechanical turns; large-tier models are for architecture, multi-file edits, hard debugging or failing builds. " +
  'Reply with EXACTLY one JSON object and nothing else: {"ref":"<candidate ref>","tier":"small"|"large","confidence":<0..1>,"reason":"<max 12 words>"}. ' +
  "If unsure, set confidence to 0.";

/** Cache key: everything the verdict can depend on (task text is NOT included by design — §3 keeps the prompt tiny). */
function cacheKey(ctx: TurnContext, base: { tier: string; reason: string }, cands: RouterModel[]): string {
  return JSON.stringify([ctx.step, ctx.phase, ctx.buildFailStreak, ctx.guardrailStreak, ctx.toolArgsRepairStreak, base.tier, cands.map((m) => m.ref)]);
}

function renderCandidates(cands: RouterModel[]): string {
  return cands
    .map((m) => {
      const price = m.pricing ? `, output $${m.pricing.output}/M` : "";
      const ctx = m.contextWindow ? `, ctx ${Math.round(m.contextWindow / 1000)}k` : "";
      const tools = m.toolCall ? "" : ", text-only (no tool calls)";
      return `- ${m.ref} (tier ${m.tier}${ctx}${price}${tools})`;
    })
    .join("\n");
}

function renderContext(ctx: TurnContext, base: { tier: string; reason: string }): string {
  return [
    `turn: step ${ctx.step}${ctx.maxSteps ? `/${ctx.maxSteps}` : ""} · phase ${ctx.phase ?? "unknown"}`,
    `signals: build-fails ${ctx.buildFailStreak} · guardrail-streak ${ctx.guardrailStreak} · arg-repair ${ctx.toolArgsRepairStreak}`,
    `first-pass tier: ${base.tier} (${base.reason})`,
  ].join("\n");
}

/** Strict extraction: first balanced JSON object → validated fields; junk → null-ref verdict. */
function parseVerdict(text: string, ms: number, tokens: number): JudgeVerdict {
  const bad = (reason: string): JudgeVerdict => ({ tier: null, ref: null, confidence: 0, reason, ms, tokens });
  const m = /\{[\s\S]*\}/.exec(text ?? "");
  if (!m) return bad("judge-unparseable");
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return bad("judge-unparseable");
  }
  if (typeof obj !== "object" || obj === null) return bad("judge-unparseable");
  const j = obj as Record<string, unknown>;
  const ref = typeof j.ref === "string" ? j.ref.trim() : "";
  if (!ref) return bad("judge-unparseable");
  const tier = j.tier === "small" || j.tier === "large" ? j.tier : null;
  const c = j.confidence;
  const confidence = typeof c === "number" && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
  const reason = typeof j.reason === "string" ? j.reason.slice(0, 80) : "";
  return { tier, ref, confidence, reason, ms, tokens };
}

/** One chat that cannot outlive `timeoutMs`. Abort is best-effort cleanup for the client. */
async function chatWithTimeout(client: JudgeClient, messages: ChatMessage[], timeoutMs: number): Promise<Awaited<ReturnType<JudgeClient["chat"]>>> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      client.chat(messages, [], { signal: ac.signal, maxTokens: 160 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("judge-timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    ac.abort();
  }
}

/**
 * Build the L4 judge. `model` is only a label — RouterRuntime validates the
 * returned ref against its own candidate allowlist (hallucinations are
 * rejected there), so this module never needs the tier table again.
 */
export function createJudge(o: JudgeOptions): Judge {
  const timeoutMs = o.timeoutMs && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, { verdict: JudgeVerdict; at: number }>();
  return {
    describe: () => o.model,
    async judge(ctx, candidates, base): Promise<JudgeVerdict> {
      const key = cacheKey(ctx, base, candidates);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return { ...hit.verdict };
      const started = Date.now();
      let verdict: JudgeVerdict;
      try {
        const res = await chatWithTimeout(o.client, [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `${renderContext(ctx, base)}\n\ncandidates:\n${renderCandidates(candidates)}` },
        ], timeoutMs);
        const usage = res.usage;
        const tokens = (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
        verdict = parseVerdict(res.message?.content ?? "", Date.now() - started, tokens);
      } catch (err) {
        const why = (err as Error)?.message === "judge-timeout" ? "judge-timeout" : "judge-error";
        verdict = { tier: null, ref: null, confidence: 0, reason: why, ms: Date.now() - started, tokens: 0 };
      }
      // Only cache trustworthy answers; a timeout/error should retry next turn.
      if (!verdict.reason.startsWith("judge-timeout") && !verdict.reason.startsWith("judge-error")) {
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(key, { verdict: { ...verdict }, at: Date.now() });
      }
      return verdict;
    },
  };
}
