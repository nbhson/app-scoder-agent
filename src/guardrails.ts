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
import type { AssistantMessage } from "./llm.js";
import { claimsCompletion } from "./context.js";

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
  /** Có tool call nào chạy đúng build command và thành công không. */
  buildPassedThisStep: boolean;
  /** Có tool call nào chạy đúng build command (dù fail) không. */
  buildCallPresent: boolean;
  /** Đã có file nào được sửa trong run này chưa. */
  filesModified: boolean;
  /** Số bước liên tiếp chỉ trả text (không gọi tool). */
  textOnlyStreak: number;
  /** Số lần lặp lại chuỗi tool call giống hệt bước trước (0 = lần đầu). */
  sigRepeat: number;
  /** Wrap-up reminder đã được inject trong run này chưa. */
  wrapUpInjected: boolean;
  /** Assistant vừa phát marker kết thúc lượt chat. */
  chatDone: boolean;
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
  /** Trả về {action, reason} khi rule kích hoạt, null khi không vi phạm. */
  evaluate(ctx: GuardrailContext): { action: GuardrailAction; reason: string } | null;
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
      if (ctx.wrapUpInjected) return null;
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
      if (ctx.hasToolCalls) return null;
      if (ctx.textOnlyStreak < opts.textOnlyStreakLimit) return null;
      if (ctx.filesModified) return null;
      return {
        action: { kind: "finish", success: true, summary: ctx.text || "(agent replied without acting)" },
        reason: `${ctx.textOnlyStreak} consecutive text-only steps with no file changes`,
      };
    },
  };
}

/** Nudge: trả lời text thường (không claim, không hết streak) → nhắc tiếp tục làm việc. */
const continueNudgeRule: GuardrailRule = {
  name: "continue-nudge",
  description: "tool-less step that neither claims completion nor ends the run — nudge the agent to act",
  evaluate(ctx) {
    if (ctx.hasToolCalls) return null;
    if (ctx.chatDone) return null;
    if (claimsCompletion(ctx.text)) return null; // completion-claim rule phụ trách
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
      if (!ctx.hasToolCalls) return null;
      if (ctx.sigRepeat < opts.doomLoopRepeats) return null;
      return {
        action: {
          kind: "inject",
          reminder:
            "<system-reminder>You have made the identical tool call 3 times in a row. This is a loop: read the last output carefully, change your approach, or report the blocker in your final message. Do NOT repeat the same call again.</system-reminder>",
        },
        reason: `identical tool-call batch repeated ${ctx.sigRepeat + 1}x`,
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
    completionClaimRule,
    textOnlyStreakRule(opts),
    continueNudgeRule,
    doomLoopRule(opts),
    buildStopRule,
    historyTrimRule,
  ];
}

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * Engine chạy toàn bộ rule mỗi bước và thu thập các decision đã kích hoạt.
 * runLoop áp dụng: finish đầu tiên thắng; inject/trim gom lại áp một lần.
 */
export class GuardrailEngine {
  private rules: GuardrailRule[];

  constructor(
    rules?: GuardrailRule[],
    private onDecision?: (d: GuardrailDecision) => void,
  ) {
    this.rules = rules ?? defaultGuardrailRules();
  }

  /** Đăng ký thêm rule (chạy sau các rule mặc định nếu thêm sau khi tạo). */
  register(rule: GuardrailRule): void {
    this.rules.push(rule);
  }

  listRules(): Array<{ name: string; description: string }> {
    return this.rules.map((r) => ({ name: r.name, description: r.description }));
  }

  /** Chạy tất cả rule; trả về các decision ĐÃ kích hoạt (theo thứ tự ưu tiên). */
  evaluate(ctx: GuardrailContext): GuardrailDecision[] {
    const out: GuardrailDecision[] = [];
    for (const rule of this.rules) {
      let r: { action: GuardrailAction; reason: string } | null = null;
      try {
        r = rule.evaluate(ctx);
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

