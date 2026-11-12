#!/usr/bin/env node
/**
 * P2-4 (plan/performance-issue.md §8): mô phỏng CHIẾN LƯỢC quản lý history để
 * đo "prefill lãng phí" — số token engine phải tính lại ở mỗi lượt gọi LLM.
 *
 * Vì sao mô phỏng thay vì gọi model thật: biến số gây chậm (RC-1) nằm ở phía
 * agent — history có phải append-only hay không — nên đo được deterministic,
 * không cần GPU, chạy lại được mỗi lần đổi code.
 *
 *   node scripts/bench-context.mjs
 *   node scripts/bench-context.mjs --steps 60 --prefill 2000
 *
 * Mỗi scenario chạy 2 chiến lược:
 *   legacy — trim MỖI BƯỚC (trimHistory tại aec95ef, luôn sửa in-place tool
 *            result), read_file trả tối đa 20k ký tự, schema 16.222 token.
 *   fixed  — trim chỉ khi over budget + cooldown 3 bước (P0-1), read_file cắt
 *            theo dòng ở limits.toolOutputChars (P0-2), schema có trần
 *            (P0-3) khi scenario bật mcpSchemaTokens.
 *
 * Chỉ số chính:
 *   promptTokens         = tổng input gửi lên model (billing/thực tế)
 *   wastedPrefillTokens  = phần đã gửi ở lượt trước nhưng phải tính lại
 *   cacheHitRatio        = 1 − wasted/prompt (KV-cache reuse)
 *   wastedSeconds        = wasted / prefill tok/s
 */
import { encode } from "gpt-tokenizer";
import { messageHashes, commonPrefixLength } from "../dist/llm/prompt-metrics.js";
import { trimHistory, historyPressure, MAX_HISTORY_TOKENS, historyTokenBudget } from "../dist/context/context.js";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};

const STEPS = flag("steps", 40);
const PREFILL_TOK_PER_SEC = flag("prefill", 1_000); // máy cá nhân ≈ 1k tok/s
const TRIM_COOLDOWN_STEPS = 3;

const tokens = (text) => encode(text).length;
const filler = (n) => "x".repeat(n);

/** History của một run MỘT task (dạng hay gặp nhất trong log: 1 user task rồi 40+ bước). */
function pushStep(messages, step, { readChars }) {
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `c${step}`, name: "read_file", arguments: JSON.stringify({ path: `src/mod${step}.ts` }) }],
  });
  messages.push({ role: "tool", tool_call_id: `c${step}`, content: `${step}: ${filler(readChars)}` });
  messages.push({ role: "assistant", content: `Phân tích bước ${step}: ${filler(400)}` });
  messages.push({ role: "user", content: `verify output bước ${step}: ${filler(300)}` });
}

/** Bản copy thuật toán trimHistory tại commit aec95ef (chỉ dùng để so sánh). */
function legacyTrim(messages, maxTokens) {
  const MAX_MESSAGES = 120;
  const KEEP_RECENT_TOOL_RESULTS = 20;
  const mt = (m) => tokens((m.content ?? "") + (m.tool_calls ?? []).map((t) => t.name + t.arguments).join(""));
  const sum = (ms) => ms.reduce((n, m) => n + mt(m), 0);
  let out = messages;
  if (out.length > MAX_MESSAGES) {
    const system = out[0].role === "system" ? out[0] : null;
    const rest = system ? out.slice(1) : out;
    out = system ? [system, ...rest.slice(-(MAX_MESSAGES - 1))] : rest.slice(-(MAX_MESSAGES - 1));
  }
  while (out.length > 2 && sum(out) > maxTokens) {
    const firstIdx = out[0].role === "system" ? 1 : 0;
    if (out[firstIdx]?.role !== "user") break;
    let next = firstIdx + 1;
    while (next < out.length && out[next].role !== "user") next++;
    out = [...out.slice(0, firstIdx), ...out.slice(next)];
  }
  const toolIdx = [];
  for (let i = 0; i < out.length; i++) if (out[i].role === "tool") toolIdx.push(i);
  const pruneBefore = toolIdx.length - KEEP_RECENT_TOOL_RESULTS;
  if (pruneBefore > 0) {
    out = out.map((m, i) =>
      toolIdx.includes(i) && toolIdx.indexOf(i) < pruneBefore && (m.content?.length ?? 0) > 200
        ? { ...m, content: "[pruned — old tool result]" }
        : m,
    );
  }
  return out;
}

/**
 * @param {"legacy"|"fixed"} strategy
 * @param {{window:number, schemaTokens:number, systemTokens:number, compaction:boolean, readChars:number}} cfg
 */
function simulate(strategy, cfg) {
  let messages = [
    { role: "system", content: filler(cfg.systemTokens * 4) },
    { role: "user", content: `Nhiệm vụ: sửa lỗi hiệu năng trong plan/performance-issue.md ${filler(600)}` },
  ];
  // Ngân sách history: legacy dùng 90k cứng (compaction mặc định tắt thì đây
  // là ngưỡng thật); fixed trừ schema + chỗ cho reply theo window THẬT (P1-1).
  const budget = cfg.compaction
    ? historyTokenBudget(cfg.window, cfg.schemaTokens, 8_192)
    : MAX_HISTORY_TOKENS;
  const compactTrigger = cfg.compaction ? Math.max(2_000, cfg.window * 0.8 - cfg.schemaTokens) : Infinity;

  let calls = 0;
  let promptTokens = 0;
  let wastedPrefillTokens = 0;
  let trimEvents = 0;
  let compactEvents = 0;
  let peakHistoryTokens = 0;
  let lastTrimStep = -Infinity;
  let prevHashes = null;

  for (let step = 1; step <= STEPS; step++) {
    pushStep(messages, step, { readChars: cfg.readChars });

    const pressure = historyPressure(messages, budget);
    peakHistoryTokens = Math.max(peakHistoryTokens, pressure.tokens);

    // ── compaction (H-10): giữ lại đuôi, summary thay phần cũ ───────────────
    if (pressure.tokens > compactTrigger) {
      const keep = Math.max(4, Math.floor(messages.length * 0.3));
      messages = [messages[0], { role: "user", content: `[summary history] ${filler(1_200)}` }, ...messages.slice(-keep)];
      compactEvents++;
    }

    // ── mechanical trim ─────────────────────────────────────────────────────
    if (strategy === "legacy") {
      const before = messages.map((m) => m.content?.length ?? -1).join(",");
      messages = legacyTrim(messages, budget);
      if (messages.map((m) => m.content?.length ?? -1).join(",") !== before) trimEvents++;
    } else {
      const p = historyPressure(messages, budget);
      const eligible = step - lastTrimStep >= TRIM_COOLDOWN_STEPS;
      if (p.over && eligible) {
        const next = trimHistory(messages, budget);
        if (next !== messages) {
          messages = next;
          lastTrimStep = step;
          trimEvents++;
        }
      }
    }

    // ── "gọi LLM": prefix reuse = schema (không đổi) + history tiền tố ──────
    const hashes = messageHashes(messages);
    const perMsg = messages.map((m) => tokens(m.content ?? "") + 4);
    const callTokens = cfg.schemaTokens + perMsg.reduce((a, b) => a + b, 0);
    let prefix = 0;
    if (prevHashes) {
      const { commonPrefix } = commonPrefixLength(prevHashes, hashes);
      for (let i = 0; i < commonPrefix; i++) prefix += perMsg[i];
      prefix += cfg.schemaTokens;
    }
    promptTokens += callTokens;
    wastedPrefillTokens += Math.max(0, callTokens - prefix);
    prevHashes = hashes;
    calls++;
  }

  return {
    calls,
    trimEvents,
    compactEvents,
    finalMessages: messages.length,
    peakHistoryTokens,
    promptTokens,
    wastedPrefillTokens,
    cacheHitRatio: Number((1 - wastedPrefillTokens / Math.max(1, promptTokens)).toFixed(3)),
    wastedSeconds: Math.round(wastedPrefillTokens / PREFILL_TOK_PER_SEC),
  };
}

const pct = (a, b) => (a === 0 ? "—" : `${Math.round(((a - b) / a) * 100)}%`);

const scenarios = [
  {
    name: "A. window 128k, compaction tắt, 46 MCP tool (RC-1 thuần)",
    cfg: { window: 128_000, schemaTokens: 16_222, systemTokens: 2_500, compaction: false },
  },
  {
    name: "B. window 32k (num_ctx Ollama), compaction bật, đủ 46 tool",
    cfg: { window: 32_768, schemaTokens: 16_222, systemTokens: 2_500, compaction: true },
  },
  {
    name: "C. window 32k + local profile (mcpSchemaTokens 6k, toolOutputChars 6k)",
    cfg: { window: 32_768, schemaTokens: 6_000, systemTokens: 2_500, compaction: true },
  },
];

/**
 * Ba biến thể để quy đúng trách nhiệm từng fix:
 *   legacy        — trim mỗi bước (aec95ef) + read_file 20k ký tự
 *   p0_1          — CHỈ đổi chiến lược trim (read_file vẫn 20k)
 *   p0_1_and_p0_2 — trim mới + read_file cắt theo dòng ở 6k
 */
const report = { steps: STEPS, prefillTokPerSec: PREFILL_TOK_PER_SEC, trimCooldownSteps: TRIM_COOLDOWN_STEPS, scenarios: [] };
for (const s of scenarios) {
  const legacy = simulate("legacy", { ...s.cfg, readChars: 20_000 });
  const p01 = simulate("fixed", { ...s.cfg, readChars: 20_000 });
  const all = simulate("fixed", { ...s.cfg, readChars: 6_000 });
  report.scenarios.push({
    name: s.name,
    legacy,
    p0_1_trim_only: p01,
    p0_1_p0_2: all,
    effect: {
      trimOnly: {
        wastedPrefillTokens: `${pct(legacy.wastedPrefillTokens, p01.wastedPrefillTokens)} (${legacy.wastedPrefillTokens} → ${p01.wastedPrefillTokens})`,
        cacheHitRatio: `${legacy.cacheHitRatio} → ${p01.cacheHitRatio}`,
        wastedSeconds: legacy.wastedSeconds - p01.wastedSeconds,
        trimEvents: `${legacy.trimEvents} → ${p01.trimEvents}`,
      },
      plusOutputCap: {
        promptTokens: `${pct(p01.promptTokens, all.promptTokens)} (${p01.promptTokens} → ${all.promptTokens})`,
        wastedPrefillTokens: `${pct(p01.wastedPrefillTokens, all.wastedPrefillTokens)} (${p01.wastedPrefillTokens} → ${all.wastedPrefillTokens})`,
        cacheHitRatio: `${p01.cacheHitRatio} → ${all.cacheHitRatio}`,
        wastedSeconds: p01.wastedSeconds - all.wastedSeconds,
      },
      total: {
        promptTokens: `${pct(legacy.promptTokens, all.promptTokens)} (${legacy.promptTokens} → ${all.promptTokens})`,
        wastedPrefillTokens: `${pct(legacy.wastedPrefillTokens, all.wastedPrefillTokens)}`,
        cacheHitRatio: `${legacy.cacheHitRatio} → ${all.cacheHitRatio}`,
        wastedSeconds: `${legacy.wastedSeconds}s → ${all.wastedSeconds}s`,
        trimEvents: `${legacy.trimEvents} → ${all.trimEvents}`,
      },
    },
  });
}
console.log(JSON.stringify(report, null, 2));
