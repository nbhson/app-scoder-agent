/**
 * Guardrail Engine — các luật an toàn & tiến trình bao quanh vòng lặp tự chủ.
 *
 * Trước đây các guardrail (doom-loop breaker, wrap-up prefill, text-only
 * streak, kiểm tra claim hoàn thành...) nằm rải rác trong runLoop. Module này
 * tách chúng thành một **registry các rule thuần function**: mỗi rule nhận
 * context của bước hiện tại và trả về decision (hoặc null nếu không vi phạm).
 *
 * Lợi ích:
 *  - Cấu hình được ngưỡng (GuardrailOptions) mà không sửa runLoop.
 *  - Mỗi quyết định được log qua callback → JSONL / metrics / UI.
 *  - Test độc lập được (không cần LLM thật).
 *
 * Không copy code từ opencode — chỉ tham khảo ý tưởng "guardrails quanh loop".
 */
import type { AssistantMessage, ToolCall } from "../llm/llm.js";
import { claimsCompletion } from "../context/context.js";

/** Marker do system prompt quy ước: lượt chat thuần, không cần build. */
export const CHAT_DONE_MARKER = "<<CHAT_DONE>>";

// ── Action: những gì loop phải làm khi một rule được kích hoạt ──────────────

export type GuardrailAction =
  | { kind: "none" }
  /** Chèn một lời nhắc (role=user) vào messages. */
  | { kind: "inject"; reminder: string }
  /** Kết thúc run ngay lập tức. */
  | {
      kind: "finish";
      success: boolean;
      summary: string;
      /** True: lượt chat thuần (không build) — hiển thị khác trên UI. */
      chatOnly?: boolean;
    }
  /** Yêu cầu loop tự chạy build để xác minh (async — rule không tự chạy được). */
  | { kind: "verify-build"; successSummary: string; failReminder: string }
  /** Cắt gọn lịch sử hội thoại (context management). */
  | { kind: "trim" };

/** Một quyết định của rule: rule nào, làm gì, vì sao. */
export interface GuardrailDecision {
  rule: string;
  action: GuardrailAction;
  reason: string;
}

// ── Context: thông tin loop cung cấp cho rule mỗi bước ──────────────────────

export interface GuardrailContext {
  /** Bước hiện tại (1-based). */
  step: number;
  maxSteps: number;
  /** Văn bản assistant trả về bước này (đã làm sạch marker chat nếu có). */
  text: string;
  /** Message gốc của assistant (để biết có tool_calls không). */
  message: AssistantMessage | null;
  /** Có tool_calls trong bước này không. */
  hasToolCalls: boolean;
  /** Kết quả tool đã chạy bước này (id → {ok, output}) — error-loop tracking. */
  toolResults?: ReadonlyMap<string, { ok: boolean; output: string }>;
  /** Có tool call nào chạy đúng build command và thành công không. */
  buildPassedThisStep: boolean;
  /** Có tool call nào chạy đúng build command (dù fail) không. */
  buildCallPresent: boolean;
  /** Đã có file nào được sửa trong run này chưa. */
  filesModified: boolean;
  /** Assistant vừa phát marker kết thúc lượt chat. */
  chatDone: boolean;
  /** Output tokens của bước này (token-no-progress, H-12). */
  outputTokensThisStep?: number;
  /** G6: tổng token tích luỹ cả run (budget rule). */
  totalTokensIn?: number;
  totalTokensOut?: number;
}

// ── Per-run tracker state (G1) — sống trong engine, không còn trong runLoop ──

interface TrackerState {
  /** Số bước liên tiếp chỉ trả text (không gọi tool). */
  textOnlyStreak: number;
  /** Chuỗi tool call của bước trước + số lần lặp lại giống hệt. */
  lastCallSig: string;
  sigRepeat: number;
  /** Wrap-up reminder đã được inject trong run này chưa. */
  wrapUpInjected: boolean;
  /** Signature "tool+error" gần nhất — error-loop tracking (H-12). */
  toolErrorSig: string;
  toolErrorRepeat: number;
  /** Số bước liên tiếp outputTokens < 20 (H-12). */
  lowTokenStreak: number;
}

// ── Options: ngưỡng cấu hình được cho các rule ──────────────────────────────

export interface GuardrailOptions {
  /** Số bước liên tiếp chỉ-tr-text (không sửa file) trước khi dừng run. */
  textOnlyStreakLimit: number;
  /** Số lần LẶP lại chuỗi tool call giống hệt trước khi can thiệp
   *  (2 nghĩa là lần gọi thứ 3 giống hệt sẽ bị chặn). */
  doomLoopRepeats: number;
  /** Còn bao nhiêu bước trước khi hết budget thì inject wrap-up reminder. */
  wrapUpStepsBeforeEnd: number;
  /** G6: tổng token (in+out) tối đa mỗi run — bỏ qua khi không set. */
  tokenBudget?: number;
}

export const DEFAULT_GUARDRAIL_OPTIONS: GuardrailOptions = {
  textOnlyStreakLimit: 2,
  doomLoopRepeats: 2,
  wrapUpStepsBeforeEnd: 2,
};

// ── Rule ────────────────────────────────────────────────────────────────────

export interface GuardrailRule {
  name: string;
  description: string;
  /**
   * Trả về {action, reason} khi rule kích hoạt, null khi không vi phạm.
   * G6: có thể async (Promise) — engine await tuần tự; rule sync vẫn chạy
   * như cũ (verify-build pattern: rule async không tự chạy build, trả action
   * để loop chạy).
   */
  evaluate(ctx: GuardrailContext): { action: GuardrailAction; reason: string } | null | Promise<{ action: GuardrailAction; reason: string } | null>;
}

/**
 * Wrap-up prefill: gần hết step budget → ép model dừng mở việc mới, chạy build
 * và tổng kết. Nếu không, model thường đốt nốt các bước cuối để khám phá và
 * run thất bại mà không có summary.
 */
export function wrapUpRule(opts: GuardrailOptions): GuardrailRule {
  return {
    name: "wrap-up",
    description: `inject reminder ${opts.wrapUpStepsBeforeEnd} steps before budget end`,
    evaluate(ctx) {
      const t = ctx as GuardrailContext & TrackerState;
      if (t.wrapUpInjected) return null;
      if (ctx.maxSteps - ctx.step !== opts.wrapUpStepsBeforeEnd) return null;
      return {
        action: {
          kind: "inject",
          reminder:
            "<system-reminder>Step budget nearly exhausted (2 steps left). Stop starting new work: finish the current change, run the build command, and reply with a final summary. If the build cannot pass in the remaining steps, report exactly what remains in your final message.</system-reminder>",
        },
        reason: `${opts.wrapUpStepsBeforeEnd} steps left in budget`,
      };
    },
  };
}

/** Lượt chat thuần (marker CHAT_DONE) → kết thúc, không cần build. */
const chatDoneRule: GuardrailRule = {
  name: "chat-done",
  description: "assistant emitted the chat-done marker — end the conversational turn",
  evaluate(ctx) {
    if (!ctx.chatDone) return null;
    // Phòng vệ: làm sạch marker dù loop đã làm trước — summary không bao giờ
    // lộ marker nội bộ ra UI.
    const clean = ctx.text.split(CHAT_DONE_MARKER)[0].trim();
    return {
      action: {
        kind: "finish",
        success: true,
        summary: clean || "Conversation turn complete.",
        chatOnly: true,
      },
      reason: "chat-done marker present",
    };
  },
};

/**
 * Completion claim: model tuyên bố xong việc → không tin lời nói, ép build xác
 * minh. Trường hợp không sửa file nào (chỉ trả lời câu hỏi) thì bỏ qua build.
 */
const completionClaimRule: GuardrailRule = {
  name: "completion-claim",
  description: "assistant claims completion — force a build verification",
  evaluate(ctx) {
    if (ctx.hasToolCalls) return null;
    if (!claimsCompletion(ctx.text)) return null;
    if (ctx.step >= ctx.maxSteps) return null;
    if (!ctx.filesModified) {
      return {
        action: { kind: "finish", success: true, summary: ctx.text },
        reason: "claims completion but no files were modified — skip build",
      };
    }
    return {
      action: {
        kind: "verify-build",
        successSummary: ctx.text,
        // Loop sẽ ghép thêm "\nOutput:\n<build output>\nFix and continue."
        failReminder: "Build still FAILED after your claimed completion.",
      },
      reason: "claims completion with modified files — verifying build",
    };
  },
};

/**
 * Text-only streak breaker: model chỉ nói không làm (không gọi tool, không sửa
 * file) đủ N bước liên tiếp → dừng run thay vì đốt step budget bằng vòng lặp
 * "nudge" vô sản (failure mode "chào" nổi tiếng).
 */
export function textOnlyStreakRule(opts: GuardrailOptions): GuardrailRule {
  return {
    name: "text-only-streak",
    description: `end the run after ${opts.textOnlyStreakLimit} consecutive tool-less steps with no file changes`,
    evaluate(ctx) {
      const t = ctx as GuardrailContext & TrackerState;
      if (ctx.hasToolCalls) return null;
      if (t.textOnlyStreak < opts.textOnlyStreakLimit) return null;
      if (ctx.filesModified) return null;
      return {
        action: { kind: "finish", success: true, summary: ctx.text || "(agent replied without acting)" },
        reason: `${t.textOnlyStreak} consecutive text-only steps with no file changes`,
      };
    },
  };
}

/**
 * Error-loop breaker (H-12): cùng tool + cùng error lặp lại 3 lần ⇒ inject
 * "change approach" — doom-loop mở rộng bằng signature bao gồm error hash.
 */
export function errorLoopRule(_opts: GuardrailOptions): GuardrailRule {
  return {
    name: "error-loop",
    description: "same tool + same error 3x in a row — force a strategy change",
    evaluate(ctx) {
      const t = ctx as GuardrailContext & TrackerState;
      if (t.toolErrorRepeat < 2) return null; // 3rd occurrence = repeat 2
      return {
        action: {
          kind: "inject",
          reminder:
            "<system-reminder>The same tool call has failed with the same error 3 times. Stop retrying: the approach itself is wrong. Diagnose the root cause, try a fundamentally different method, or report the blocker in your final message.</system-reminder>",
        },
        reason: `same tool+error repeated ${t.toolErrorRepeat + 1}x`,
      };
    },
  };
}

/**
 * Token-no-progress (H-12): outputTokens < 20 trong 3 step liên tiếp ⇒ finish
 * (model degenerate — tránh treo run không tiến triển).
 */
export function tokenNoProgressRule(opts: GuardrailOptions): GuardrailRule {
  return {
    name: "token-no-progress",
    description: "output tokens < 20 for 3 consecutive steps — end a degenerate run",
    evaluate(ctx) {
      const t = ctx as GuardrailContext & TrackerState;
      void opts;
      if (ctx.outputTokensThisStep === undefined) return null;
      if (ctx.outputTokensThisStep >= 20) return null;
      if (t.lowTokenStreak < 3) return null;
      return {
        action: {
          kind: "finish",
          success: false,
          summary: "Run stopped: 3 consecutive near-empty LLM responses (no progress).",
        },
        reason: `output tokens ${ctx.outputTokensThisStep} < 20 for ${t.lowTokenStreak} steps`,
      };
    },
  };
}

/** Nudge: trả lời text thường (không claim, không hết streak) → nhắc tiếp tục làm việc. */
const continueNudgeRule: GuardrailRule = {  name: "continue-nudge",
  description: "tool-less step that neither claims completion nor ends the run — nudge the agent to act",
  evaluate(ctx) {
    if (ctx.hasToolCalls) return null;
    if (ctx.chatDone) return null;
    if (claimsCompletion(ctx.text)) return null; // completion-claim rule phụ trách
    // No file changed yet → never demand a build for what may be a pure Q&A or
    // an explanation-only answer. Give the model the explicit conversational
    // exit instead; text-only-streak still ends the run if it keeps stalling.
    if (!ctx.filesModified) {
      return {
        action: {
          kind: "inject",
          reminder:
            `Continue working on the task. Use tools only if code changes are needed. ` +
            `If the user only asked a question and no code change is needed, do NOT run the build — ` +
            `end your reply with ${CHAT_DONE_MARKER} on its own last line instead.`,
        },
        reason: "plain text answer without tool calls (no files modified)",
      };
    }
    return {
      action: {
        kind: "inject",
        reminder: "Continue working on the task. Use tools. Build must pass before you finish.",
      },
      reason: "plain text answer without tool calls",
    };
  },
};

/**
 * Doom-loop breaker: chuỗi tool call giống hệt nhau lặp lại quá ngưỡng →
 * can thiệp bằng lời nhắc đổi chiến lược (model hiếm khi tự thoát khỏi loop;
 * run không người trông sẽ đốt sạch step budget).
 */
export function doomLoopRule(opts: GuardrailOptions): GuardrailRule {
  return {
    name: "doom-loop",
    description: `intervene after ${opts.doomLoopRepeats + 1} identical consecutive tool-call batches`,
    evaluate(ctx) {
      const t = ctx as GuardrailContext & TrackerState;
      if (!ctx.hasToolCalls) return null;
      if (t.sigRepeat < opts.doomLoopRepeats) return null;
      return {
        action: {
          kind: "inject",
          reminder:
            "<system-reminder>You have made the identical tool call 3 times in a row. This is a loop: read the last output carefully, change your approach, or report the blocker in your final message. Do NOT repeat the same call again.</system-reminder>",
        },
        reason: `identical tool-call batch repeated ${t.sigRepeat + 1}x`,
      };
    },
  };
}

/** Context management: luôn cắt gọn lịch sử sau mỗi bước. */
const historyTrimRule: GuardrailRule = {
  name: "history-trim",
  description: "trim message history after every step (token budget)",
  evaluate() {
    return { action: { kind: "trim" }, reason: "routine context management" };
  },
};

/**
 * G6: token budget per run — tổng (input+output) vượt cap → kết thúc run
 * (pause thay vì đốt tiền). Đọc usage từ ctx (loop truyền usageTotals).
 */
export function tokenBudgetRule(capTokens: number): GuardrailRule {
  return {
    name: "token-budget",
    description: `end the run when total session tokens exceed ${capTokens}`,
    evaluate(ctx) {
      const total = (ctx.totalTokensIn ?? 0) + (ctx.totalTokensOut ?? 0);
      if (total < capTokens) return null;
      return {
        action: {
          kind: "finish",
          success: false,
          summary:
            `Token budget exhausted: ${total} tokens used (cap ${capTokens}). ` +
            "Report current progress in the summary.",
        },
        reason: `token budget ${total}/${capTokens}`,
      };
    },
  };
}

/**
 * Build stop condition: bước này có tool call chạy ĐÚNG build command →
 * thành công là điều kiện kết thúc run (dùng lại kết quả tool, không build
 * lần 2); thất bại thì tự xác minh lại rồi nudge fix.
 */
const buildStopRule: GuardrailRule = {
  name: "build-stop",
  description: "a tool call ran the exact build command — success ends the run, failure re-verifies",
  evaluate(ctx) {
    if (!ctx.hasToolCalls || !ctx.buildCallPresent) return null;
    const summary = ctx.text || "Build passed.";
    if (ctx.buildPassedThisStep) {
      return {
        action: { kind: "finish", success: true, summary },
        reason: "build command succeeded this step",
      };
    }
    return {
      action: {
        kind: "verify-build",
        successSummary: summary,
        // Loop sẽ ghép thêm output build thật vào sau.
        failReminder: "Build FAILED (stop condition not met).",
      },
      reason: "build command ran and failed — re-verifying independently",
    };
  },
};

/** Bộ rule mặc định, theo thứ tự ưu tiên (finish đầu tiên thắng). */
export function defaultGuardrailRules(opts: GuardrailOptions = DEFAULT_GUARDRAIL_OPTIONS): GuardrailRule[] {
  return [
    wrapUpRule(opts),
    chatDoneRule,
    // G6: budget rule đứng sớm — vượt cap là finish ngay, trước mọi rule khác
    // (trừ wrap-up, vốn vô hại khi budget đã cạn).
    ...(opts.tokenBudget ? [tokenBudgetRule(opts.tokenBudget)] : []),
    completionClaimRule,
    textOnlyStreakRule(opts),
    continueNudgeRule,
    doomLoopRule(opts),
    errorLoopRule(opts),
    tokenNoProgressRule(opts),
    buildStopRule,
    historyTrimRule,
  ];
}

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * Engine chạy toàn bộ rule mỗi bước và thu thập các decision đã kích hoạt.
 * runLoop áp dụng: finish đầu tiên thắng; inject/trim gom lại áp một lần.
 * G1: toàn bộ tracker state (textOnlyStreak, sigRepeat, wrapUpInjected,
 * toolError*, lowTokenStreak) sống ở đây — runLoop chỉ emit sự kiện thô.
 */
export class GuardrailEngine {
  private rules: GuardrailRule[];
  /** G1: per-run tracker — reset() khi bắt đầu run mới. */
  private tracker: TrackerState = {
    textOnlyStreak: 0,
    lastCallSig: "",
    sigRepeat: 0,
    wrapUpInjected: false,
    toolErrorSig: "",
    toolErrorRepeat: 0,
    lowTokenStreak: 0,
  };

  constructor(
    rules?: GuardrailRule[],
    private onDecision?: (d: GuardrailDecision) => void,
  ) {
    this.rules = rules ?? defaultGuardrailRules();
  }

  /** Reset tracker — gọi ở đầu mỗi run (per-run state, không rò rỉ giữa các run). */
  reset(): void {
    this.tracker = {
      textOnlyStreak: 0,
      lastCallSig: "",
      sigRepeat: 0,
      wrapUpInjected: false,
      toolErrorSig: "",
      toolErrorRepeat: 0,
      lowTokenStreak: 0,
    };
  }

  /** Steer batch được deliver — reset text-only allowance một lần cho cả batch. */
  notifySteered(): void {
    this.tracker.textOnlyStreak = 0;
  }

  /** Wrap-up reminder vừa được apply — chỉ inject một lần mỗi run. */
  markWrapUpInjected(): void {
    this.tracker.wrapUpInjected = true;
  }

  /** Đăng ký thêm rule (chạy sau các rule mặc định nếu thêm sau khi tạo). */
  register(rule: GuardrailRule): void {
    this.rules.push(rule);
  }

  listRules(): Array<{ name: string; description: string }> {
    return this.rules.map((r) => ({ name: r.name, description: r.description }));
  }

  /**
   * Chạy tất cả rule; trả về các decision ĐÃ kích hoạt (theo thứ tự ưu tiên).
   * Tracker được cập nhật từ ctx thô TRƯỚC khi rule chạy (rule thấy giá trị
   * của bước này — đúng semantics cũ của runLoop).
   */
  evaluate(ctx: GuardrailContext): Promise<GuardrailDecision[]> {
    this.updateTrackers(ctx);
    // Rules nhìn thấy tracker qua ctx mở rộng (internal — không thuộc API public).
    const full = { ...ctx, ...this.tracker };
    // G6: rule có thể async — chạy tuần tự (thứ tự ưu tiên giữ nguyên).
    return (async () => {
      const out: GuardrailDecision[] = [];
      for (const rule of this.rules) {
        let r: { action: GuardrailAction; reason: string } | null;
        try {
          r = await rule.evaluate(full);
        } catch (err) {
          // Một rule lỗi không được phép làm gãy vòng lặp agent.
          r = { action: { kind: "none" }, reason: `rule threw: ${(err as Error).message}` };
        }
        if (!r) continue;
        const d: GuardrailDecision = { rule: rule.name, action: r.action, reason: r.reason };
        out.push(d);
        try {
          this.onDecision?.(d);
        } catch {
          /* logging không được phép giết loop */
        }
      }
      return out;
    })();
  }

  /**
   * G1: cập nhật tracker từ sự kiện thô của bước này (thay cho state cục bộ
   * của runLoop cũ). Semantics giữ nguyên 100% so với code inline trước đây.
   */
  private updateTrackers(ctx: GuardrailContext): void {
    const t = this.tracker;
    if (ctx.hasToolCalls) {
      t.textOnlyStreak = 0;
      // Doom-loop: chữ ký chuỗi tool call so với bước trước.
      const callSig = (ctx.message?.tool_calls ?? [])
        .map((tc: ToolCall) => `${tc.name}:${tc.arguments}`)
        .sort()
        .join("|");
      t.sigRepeat = callSig === t.lastCallSig ? t.sigRepeat + 1 : 0;
      t.lastCallSig = callSig;
    } else {
      t.textOnlyStreak++;
    }
    // Error-loop (H-12): signature tool+error từ kết quả bước này.
    const errSig = (ctx.message?.tool_calls ?? [])
      .map((tc: ToolCall) => {
        const r = ctx.toolResults?.get(tc.id);
        return r && !r.ok ? `${tc.name}:${r.output.slice(0, 80)}` : null;
      })
      .filter(Boolean)
      .sort()
      .join("|");
    t.toolErrorRepeat = errSig && errSig === t.toolErrorSig ? t.toolErrorRepeat + 1 : 0;
    if (errSig) t.toolErrorSig = errSig;
    // Token-no-progress (H-12).
    const outTok = ctx.outputTokensThisStep;
    t.lowTokenStreak = outTok !== undefined && outTok < 20 ? t.lowTokenStreak + 1 : 0;
  }
}

/** Engine với bộ rule mặc định + ngưỡng tùy chọn. */
export function createGuardrailEngine(
  opts: Partial<GuardrailOptions> = {},
  onDecision?: (d: GuardrailDecision) => void,
): GuardrailEngine {
  const merged = { ...DEFAULT_GUARDRAIL_OPTIONS, ...opts };
  return new GuardrailEngine(defaultGuardrailRules(merged), onDecision);
}

