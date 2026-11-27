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
import { batchSignature, callSignature, READ_ONLY_TOOLS, SIG_WINDOW } from "./tool-signature.js";

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
  /** P0-8: run CÓ plan còn mở (todo pending/in_progress) — bước text-only khi
   *  ấy là "nghỉ giữa task", không phải lượt chat ⇒ vẫn nudge như cũ. */
  planOpen?: boolean;
  /** Output tokens của bước này (token-no-progress, H-12). */
  outputTokensThisStep?: number;
  /** G6: tổng token tích luỹ cả run (budget rule). */
  totalTokensIn?: number;
  totalTokensOut?: number;
  /**
   * P0-1: áp lực history so với ngân sách token (loop ước lượng bằng
   * `historyPressure()` trước khi evaluate). Không truyền → rule history-trim
   * không kích hoạt (mặc định an toàn: không phá KV-cache).
   */
  historyPressure?: { tokens: number; budget: number; over: boolean };
  /**
   * F2: các câu assistant ĐÃ có trong history (cũ hơn bước hiện tại, cũ→mới) —
   * nền để nhận ra model lặp lại nguyên văn/nửa đầu câu trả lời cũ thay vì đáp
   * ứng yêu cầu hiện tại. Loop chỉ truyền khi bước này là ứng viên kết thúc.
   */
  priorAssistantTexts?: readonly string[];
  /** F2: số bước có tool call đã chạy trong run này (0 ⇒ đây là lượt chat thường). */
  toolsUsedThisRun?: number;
  /** F2: đáp án đầy đủ tốt nhất tìm được trong history — dùng cho summary khi fail. */
  lastSubstantiveAnswer?: string;
  /** F2: yêu cầu hiện tại của user — đưa vào reminder để model biết phải trả lời gì. */
  currentRequest?: string;
}

// ── Per-run tracker state (G1) — sống trong engine, không còn trong runLoop ──

interface TrackerState {
  /** Số bước liên tiếp chỉ trả text (không gọi tool). */
  textOnlyStreak: number;
  /** Chuỗi tool call của bước trước + số lần lặp lại giống hệt LIÊN TIẾP. */
  lastCallSig: string;
  sigRepeat: number;
  /**
   * Chữ ký batch của các bước gần nhất (cửa sổ trượt) — bộ đếm chu kỳ
   * A→B→C→A→B→C đọc từ đây, vì loop thật của model local hiếm khi là
   * "một batch giống hệt liên tiếp".
   */
  sigWindow: string[];
  /**
   * Số lần xuất hiện của TỪNG tool call (tool + args đã chuẩn hoá) tính trên
   * cả run — bắt lặp rải rác, xen giữa các lệnh khác.
   */
  callCounts: Map<string, number>;
  /** Chu kỳ phát hiện được ở bước này (0 = không có) + số vòng lặp lại. */
  cyclePeriod: number;
  cycleCount: number;
  /** Số lần lặp nhiều nhất của MỘT tool call trong batch hiện tại (cả run). */
  maxCallCount: number;
  /** Số lần doom-loop đã can thiệp trong run (escalate inject → finish). */
  loopInterventions: number;
  /**
   * Tập dòng nội dung đã thấy trong output tool của run (chuẩn hoá) — nền của
   * bộ đếm "thông tin mới". Loop nguy hiểm nhất KHÔNG lặp args: model tăng dần
   * URL (`/angular-22-1`, `-2`, …) nên mọi chữ ký đều "mới", nhưng cả 39 lần
   * fetch đều trả về đúng một trang ⇒ run học thêm không gì (log thật:
   * session 20261126-141619-e507).
   */
  infoLines: Set<string>;
  /** Số bước liên tiếp mà output gần như toàn chữ đã thấy trước đó. */
  noInfoStreak: number;
  /** Số lần no-new-information đã can thiệp (bậc thang inject → finish). */
  noInfoInterventions: number;
  /** Trạng thái filesModified bước trước — chuyển false→true là tiến trình thật. */
  lastFilesModified: boolean;
  /** Wrap-up reminder đã được inject trong run này chưa. */
  wrapUpInjected: boolean;
  /** Số lần stale-answer đã can thiệp trong run (mỗi lần một bậc: nhắc → fail). */
  degenerateInterventions: number;
  /** Signature "tool+error" gần nhất — error-loop tracking (H-12). */
  toolErrorSig: string;
  toolErrorRepeat: number;
  /** Số bước liên tiếp outputTokens < 20 (H-12). */
  lowTokenStreak: number;
  /** F2: kết quả dò degenerate của bước này (null = ổn) — engine tính, rule đọc. */
  degenerateInfo: DegenerateAnswer | null;
}

/** Tracker khởi tạo lại đầu mỗi run — mảng/Map phải là object MỚI, không dùng chung. */
function freshTracker(): TrackerState {
  return {
    textOnlyStreak: 0,
    lastCallSig: "",
    sigRepeat: 0,
    sigWindow: [],
    callCounts: new Map<string, number>(),
    cyclePeriod: 0,
    cycleCount: 0,
    maxCallCount: 0,
    loopInterventions: 0,
    infoLines: new Set<string>(),
    noInfoStreak: 0,
    noInfoInterventions: 0,
    lastFilesModified: false,
    wrapUpInjected: false,
    toolErrorSig: "",
    toolErrorRepeat: 0,
    lowTokenStreak: 0,
    degenerateInterventions: 0,
    degenerateInfo: null,
  };
}

// ── Options: ngưỡng cấu hình được cho các rule ──────────────────────────────

export interface GuardrailOptions {
  /** Số bước liên tiếp chỉ-tr-text (không sửa file) trước khi dừng run. */
  textOnlyStreakLimit: number;
  /**
   * Ngưỡng lặp của doom-loop breaker, tính theo "số lần LẶP lại" (lần xuất hiện
   * thứ N+1). Cùng một ngưỡng dẫn ba tín hiệu với mức nghiêm trọng tăng dần:
   *  - batch giống hệt N+1 lần LIÊN TIẾP;
   *  - cùng một tool+args N+2 lần rải rác trong run;
   *  - chu kỳ 2–4 bước lặp lại.
   */
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

/**
 * F2: engine đã dò xong đáp án degenerate của bước này (tracker được spread vào
 * ctx TRƯỚC khi rule chạy). Rule nào sắp `finish success:true` phải nhường quyền
 * cho stale-answer, nếu không câu lạc hướng vẫn thoát với tư cách "kết quả".
 */
function degenerateHere(ctx: GuardrailContext): boolean {
  return Boolean((ctx as GuardrailContext & TrackerState).degenerateInfo);
}

/** Lượt chat thuần (marker CHAT_DONE) → kết thúc, không cần build. */
const chatDoneRule: GuardrailRule = {
  name: "chat-done",
  description: "assistant emitted the chat-done marker — end the conversational turn",
  evaluate(ctx) {
    if (!ctx.chatDone) return null;
    // F2: marker đặt sau một câu cụt/echo KHÔNG được tha cho run — stale-answer
    // đang giữ quyền xử lý (retry, rồi fail). Nếu không, model local chỉ cần viết
    // "<<CHAT_DONE>>" sau câu lạc hướng là lọt rule.
    if (degenerateHere(ctx)) return null;
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

/**
 * Model (đặc biệt model local) hay MỞ ĐẦU bằng lời hứa hành động rồi dừng:
 * "Tôi sẽ tìm hiểu những tính năng mới nhất của Angular cho bạn." — không tool
 * call, không sửa file. Log thật (session 20261126-141447-93ef) cho thấy run kết
 * thúc steps=1 llmCalls=1 success=true với chính câu hứa đó làm summary ⇒ user
 * "không thấy kết quả cuối cùng".
 *
 * Dấu hiệu phải HẸP để không biến câu trả lời thật thành nudge: message ngắn,
 * có marker ý định ("tôi sẽ / để tôi / i will / let me") VÀ động từ tra cứu
 * (tìm/đọc/check/fetch…), hoặc kết thúc bằng ":" / "…" (mở đầu cho việc chưa làm).
 */
export function announcesIntention(text: string): boolean {
  const t = (text || "").trim();
  if (!t || t.length > 400) return false;
  if (/[:…]\s*$/.test(t)) return true;
  // \b ASCII fail với tiếng Việt ("sẽ" kết thúc bằng ẽ, "đọc" bắt đầu bằng đ —
  // không phải word-char ⇒ không có boundary). Dùng boundary Unicode.
  const B = "(?<![\\p{L}\\p{N}\\p{M}])";
  const E = "(?![\\p{L}\\p{N}\\p{M}])";
  const intends = new RegExp(`${B}(i\\s+will|i'?ll|let\\s+me|i\\s+am\\s+going\\s+to|để\\s+tôi|tôi\\s+sẽ|mình\\s+sẽ|chúng\\s+ta\\s+sẽ)${E}`, "iu");
  const acts = new RegExp(`${B}(find|look|check|search|read|fetch|investigate|explore|inspect|gather|tìm|kiểm tra|xem|đọc|tra cứu|tổng hợp)${E}`, "iu");
  return intends.test(t) && acts.test(t);
}

// ── F2: đáp án degenerate (cắt giữa câu / lặp câu trả lời cũ) ───────────────
//
// Ba log thật cùng ngày (2026-11-27) cho thấy loop nhận VĂN BẢN CUỐI của model
// làm kết quả mà không hề kiểm tra nó:
//   - 20261127-104714-602d: lượt chạy sau các bước fetch mở đầu bằng ĐÚNG câu chào
//     của lượt đầu phiên (ledger goal cũ — xem memory.ts) và được chốt success:true;
//   - 20261127-105851-7fb8: câu chào cũ chen vào giữa run research 4 bước fetch;
//   - 20261127-103715-f250: 3 lượt cuối cắt giữa câu, 93 → 26 → 4 ký tự ("Dưới",
//     outputTokens: 3) — vẫn success:true.
// Rule này cho model MỘT cơ hội sửa (inject); vẫn degenerate ⇒ báo THẤT BẠI kèm
// đáp án tốt nhất tìm được, thay vì xác nhận câu trả lời rác.

/** Chuẩn hoá câu trả lời để so sánh: bỏ marker chat, gộp whitespace. */
export function normalizeAnswerText(text: string): string {
  return (text || "").split(CHAT_DONE_MARKER)[0].replace(/\s+/g, " ").trim();
}

/** Dài quá trần này thì không xét "cụt" — đáp án thật thường dài hơn nhiều. */
const TRUNCATED_MAX_CHARS = 120;

/** Xác nhận ngắn hợp lệ (không dấu câu vẫn trọn nghĩa) — tránh đốt thêm 1 LLM call. */
const ACK_WORDS = new Set([
  "ok", "okay", "okie", "được", "duoc", "rồi", "roi", "xong", "done",
  "vâng", "vang", "dạ", "da", "yes", "no", "không", "khong", "thanks", "cảm", "ơn",
  "chốt", "chot", "tốt", "tot", "good", "hello", "hi", "chào", "chao", "xin",
  "bạn", "ban", "ạ", "ơi", "vậy", "vay", "luôn", "luon", "nhe", "nhé",
]);

/** Kết thúc TRỌN câu: dấu chấm câu, cho phép hậu tố đóng ngoặc/trích dẫn. */
const TERMINATED = /[.!?…]["'”’)\]]?\s*$/;

/** True cho "Xong", "OK", "cảm ơn bạn"… — câu ngắn trọn nghĩa dù thiếu dấu chấm. */
export function isAcknowledgement(text: string): boolean {
  const words = normalizeAnswerText(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  return words.some((w) => ACK_WORDS.has(w));
}

/**
 * True khi văn bản là một CÂU CHƯA XONG: ngắn, một dòng, không kết thúc bằng dấu
 * câu, và có dấu hiệu mở (dưới 12 ký tự, hoặc kết thúc bằng ":", ";", "…", "-",
 * dấu ngoặc mở). Điều kiện HẸP có chủ đích: "Mình là Scoder, agent lập trình" là
 * đáp án hợp lệ, không được bị coi là cụt.
 */
export function looksTruncated(text: string): boolean {
  const raw = (text || "").split(CHAT_DONE_MARKER)[0].trim();
  if (!raw || raw.length > TRUNCATED_MAX_CHARS) return false;
  if (/\n/.test(raw)) return false;
  const t = normalizeAnswerText(raw);
  if (TERMINATED.test(t)) return false;
  if (isAcknowledgement(t)) return false;
  return t.length <= 12 || /[:,;…\-([{]$/.test(t);
}

/** Loại degenerate + mô tả ngắn (đưa vào reason/log để đọc được JSONL). */
export interface DegenerateAnswer {
  kind: "restarted-answer" | "stale-echo" | "truncated";
  detail: string;
}

/**
 * Phát hiện "đáp án" thực ra là câu cũ bị viết lại dở:
 *  - restarted-answer: văn bản là PREFIX chặt của một câu assistant trước đó
 *      ("Dưới" ← "Dưới đây, mỗi câu 3 option…") — model khởi động lại câu cũ rồi chết;
 *  - stale-echo: lặp NGUYÊN VĂN câu cũ khi run đã thực sự làm việc (6 bước fetch
 *      rồi chào lại) — lặp y hệt ở lượt chat thường là HACK hợp lệ, không phạt;
 *  - truncated: câu cụt giữa dòng.
 */
export function degenerateAnswer(
  text: string,
  priorAssistantTexts: readonly string[],
  toolsUsedThisRun: number,
): DegenerateAnswer | null {
  const t = normalizeAnswerText(text);
  if (!t) return null;
  const priors = (priorAssistantTexts ?? []).map(normalizeAnswerText).filter((p) => p.length >= 4);
  for (const p of priors) {
    if (p.length > t.length + 4 && p.startsWith(t)) {
      return { kind: "restarted-answer", detail: `lặp phần đầu câu trả lời cũ "${p.slice(0, 80)}…"` };
    }
  }
  if (toolsUsedThisRun > 0) {
    const dup = priors.find((p) => p === t);
    if (dup) return { kind: "stale-echo", detail: `lặp nguyên văn câu trước đó ("${dup.slice(0, 80)}") dù run đã gọi ${toolsUsedThisRun} bước tool` };
  }
  if (looksTruncated(text)) return { kind: "truncated", detail: `chỉ ${t.length} ký tự và không kết thúc thành câu` };
  return null;
}

const staleAnswerRule: GuardrailRule = {
  name: "stale-answer",
  description: "final text is cut off mid-sentence or repeats an earlier answer — retry once, then fail the run instead of confirming the junk",
  evaluate(ctx) {
    const t = ctx as GuardrailContext & TrackerState;
    if (ctx.hasToolCalls) return null;
    const bad = t.degenerateInfo;
    if (!bad) return null;
    const request = normalizeAnswerText(ctx.currentRequest ?? "").slice(0, 160);
    const why = bad.kind === "stale-echo" ? "repeated an earlier message instead of answering"
      : bad.kind === "restarted-answer" ? "restarted an old answer and stopped mid-sentence"
        : "was cut off mid-sentence";

    if (t.degenerateInterventions >= 1) {
      const rescued = ctx.lastSubstantiveAnswer || "";
      const junk = normalizeAnswerText(ctx.text).slice(0, 160);
      return {
        action: {
          kind: "finish",
          success: false,
          summary:
            `The model ended the run without answering the request (${why}${junk ? `: "${junk}"` : ""}).` +
            (rescued
              ? `\n\nBest complete answer from earlier in this session:\n${rescued}`
              : `\n\nSend the message again — nothing complete was produced.`),
        },
        reason: `${bad.kind}: ${bad.detail}; still degenerate after one retry`,
      };
    }
    return {
      action: {
        kind: "inject",
        reminder:
          `<system-reminder>Your last reply ${why}. Do NOT greet again and do NOT restart a previous answer. ` +
          `Answer the user's CURRENT request${request ? ` ("${request}")` : ""} in full, using the work already done ` +
          `in this run. When the answer is complete, end your reply with ${CHAT_DONE_MARKER} on its own last line.` +
          `</system-reminder>`,
      },
      reason: `${bad.kind}: ${bad.detail}`,
    };
  },
};

/** Nudge: trả lời text thường (không claim, không hết streak) → nhắc tiếp tục làm việc. */
const continueNudgeRule: GuardrailRule = {
  name: "continue-nudge",
  description: "tool-less step that neither claims completion nor ends the run — nudge the agent to act",
  evaluate(ctx) {
    if (ctx.hasToolCalls) return null;
    if (ctx.chatDone) return null;
    if (claimsCompletion(ctx.text)) return null; // completion-claim rule phụ trách
    // Lời hứa hành động chưa thực hiện ⇒ chưa phải lượt chat: nhắc gọi tool
    // ngay. text-only-streak vẫn chặn run nếu model chỉ nói tiếp lần nữa.
    if (announcesIntention(ctx.text)) {
      return {
        action: {
          kind: "inject",
          reminder:
            `You announced an intention but this step used no tools. Do it now with the actual tool call ` +
            `(read/grep/web_fetch/run_command) — a promise to look something up is not an answer. ` +
            `If you already have the answer, give it and end with ${CHAT_DONE_MARKER} on its own last line.`,
        },
        reason: "announced an intention without acting on it",
      };
    }
    // P0-8: text-only + không sửa file + không có plan mở ⇒ đây là LƯỢT CHAT.
    // Finish ngay với chính text làm summary — trước đây rule này inject nudge
    // ⇒ thêm 1 LLM call ~14,5k token mỗi câu chào (đo: call 2 in=14.569, chỉ
    // thêm đúng dòng nudge 81 token). Bài học aec95ef giữ nguyên: nhánh CÓ
    // sửa file vẫn nudge/ép build bên dưới; plan còn mở (model nghỉ giữa
    // task, quên gọi tool) cũng vẫn nudge.
    if (!ctx.filesModified && ctx.planOpen !== true) {
      return {
        action: {
          kind: "finish",
          success: true,
          summary: ctx.text || "(agent replied without acting)",
          chatOnly: true,
        },
        reason: "chat turn: tool-less step, no files modified, no open plan — one LLM call per message",
      };
    }
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
 * Doom-loop breaker. Ba tín hiệu, từ hẹp đến rộng (model local lặp theo CHU KỲ
 * chứ hiếm khi lặp y hệt một batch liên tiếp — detector cũ chỉ có tín hiệu #1 nên
 * phần lớn loop lọt lưới, run đốt sạch 40 step mà không ra kết quả):
 *
 *  1. streak   — cùng một batch giống hệt N+1 lần LIÊN TIẾP;
 *  2. scattered — cùng một tool+args xuất hiện N+2 lần rải rác trong run
 *                 (xen giữa là các lệnh khác — đúng pattern "gọi lệnh → phân
 *                  tích → fetch → gọi lệnh…");
 *  3. cycle    — chuỗi batch có kỳ (chu kỳ 2–4 bước lặp lại 2 vòng trở lên).
 *
 * Bậc thang: can thiệp đầu tiên inject reminder; model vẫn lặp ⇒ finish ngay với
 * summary, trả kết quả cho user thay vì treo đến hết budget.
 */
export function doomLoopRule(opts: GuardrailOptions): GuardrailRule {
  const scatterLimit = Math.max(4, opts.doomLoopRepeats + 2);
  return {
    name: "doom-loop",
    description:
      `intervene on ${opts.doomLoopRepeats + 1} identical consecutive batches, the same read-only call ` +
      `${scatterLimit}x anywhere in the run, or a repeated cycle of 2-${CYCLE_MAX_PERIOD} steps; end the run when it continues`,
    evaluate(ctx) {
      const t = ctx as GuardrailContext & TrackerState;
      if (!ctx.hasToolCalls) return null;

      const streak = t.sigRepeat >= opts.doomLoopRepeats ? t.sigRepeat + 1 : 0;
      const scattered = t.maxCallCount >= scatterLimit ? t.maxCallCount : 0;
      const cycle = t.cycleCount >= 2 ? t.cycleCount : 0;
      if (!streak && !scattered && !cycle) return null;

      const why = streak
        ? `identical tool-call batch repeated ${streak}x in a row`
        : cycle
          ? `cyclic pattern (period ${t.cyclePeriod} steps) repeated ${cycle}x`
          : `the same read-only call ran ${t.maxCallCount}x across the run`;

      // Sâu (quá ngưỡng nhiều) hoặc đã nhắc một lần rồi ⇒ dừng run. Kèm text cuối
      // của assistant để user nhận được kết quả thật, không phải "reached max
      // steps" — đó chính là triệu chứng "loop mãi không ra gì".
      const severe =
        t.sigRepeat >= opts.doomLoopRepeats + 1 || t.cycleCount >= 3 || t.maxCallCount >= scatterLimit + 2;
      if (severe || t.loopInterventions >= 1) {
        const tail = (ctx.text || "").trim().slice(0, 400);
        return {
          action: {
            kind: "finish",
            success: false,
            summary:
              `Stopped a repeated tool-call loop (${why}) — the agent was not making progress. ` +
              (tail ? `Last answer before stopping:\n${tail}` : "Re-run with a narrower request if you still need this."),
          },
          reason: `${why}; ended the run (interventions=${t.loopInterventions})`,
        };
      }
      return {
        action: {
          kind: "inject",
          reminder:
            `<system-reminder>This is a loop: ${why}. You already have the information these calls return. ` +
            `Do NOT repeat them. Either take a genuinely different action that changes files or gathers new facts, ` +
            `or stop and reply with a final summary of what you know and what is blocking you.</system-reminder>`,
        },
        reason: why,
      };
    },
  };
}

/** Chu kỳ dài nhất mà detector đi tìm (A→B→C→A→B→C = period 3). */
const CYCLE_MAX_PERIOD = 4;
/** Chu kỳ tối thiểu để xét cycle — period 1 đã thuộc detector streak. */
const CYCLE_MIN_PERIOD = 2;

/**
 * Phát hiện tính tuần hoàn ở đuôi cửa sổ chữ ký: tồn tại p (2–4) sao cho khối p
 * bước cuối lặp lại nguyên văn `repeats` lần liên tiếp. Khối phải có ít nhất hai
 * chữ KHÁC nhau — block toàn một chữ ký là streak, detector streak lo.
 */
export function detectCycle(window: readonly string[]): { period: number; repeats: number } | null {
  let best: { period: number; repeats: number } | null = null;
  for (let p = CYCLE_MIN_PERIOD; p <= CYCLE_MAX_PERIOD; p++) {
    if (window.length < p * CYCLE_MIN_PERIOD) break;
    const tail = window.slice(window.length - p);
    if (new Set(tail).size < 2) continue;
    let repeats = 1;
    for (let k = 2; k * p <= window.length; k++) {
      const prev = window.slice(window.length - k * p, window.length - (k - 1) * p);
      if (!prev.every((s, i) => s === tail[i])) break;
      repeats++;
    }
    if (repeats >= 2 && (!best || repeats > best.repeats)) best = { period: p, repeats };
  }
  return best;
}

/** Số dòng chuẩn hoá tối thiểu để một output được xét là "có nội dung". */
const NO_INFO_MIN_LINES = 5;
/** Tỉ lệ dòng mới dưới mức này ⇒ bước này không dạy thêm gì cho agent. */
const NO_INFO_NOVELTY = 0.15;
/** Trần bộ nhớ của tập dòng đã thấy (run rất dài không phình vô hạn). */
const INFO_LINE_CAP = 40_000;

/**
 * Dòng "thông tin" của một output: lowercase, collapse whitespace, bỏ số dòng
 * đầu dòng (`12: code…`), bỏ dòng quá ngắn/quá dài (boilerplate, divider).
 */
export function informationLines(output: string): string[] {
  const out: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\s*\d+[:|)]\s?/, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (line.length < 12 || line.length > 400) continue;
    if (/^[-=*_.\s|]+$/.test(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * Cập nhật streak "không có thông tin mới". Tool biến đổi chạy thành công ⇒ thế
 * giới đổi ⇒ reset (đó là tiến trình, dù output lặp). File mới sửa trong run ⇒
 * reset một lần (false→true).
 */
function trackInformation(t: TrackerState, ctx: GuardrailContext, calls: readonly ToolCall[]): void {
  const results = ctx.toolResults;
  if (!results || results.size === 0) return;
  const mutated = calls.some((tc) => !READ_ONLY_TOOLS.has(tc.name) && results.get(tc.id)?.ok);
  if (mutated || (ctx.filesModified && !t.lastFilesModified)) {
    t.lastFilesModified = ctx.filesModified;
    t.noInfoStreak = 0;
    return;
  }
  t.lastFilesModified = ctx.filesModified;

  let fresh = 0;
  let total = 0;
  for (const r of results.values()) {
    const stepLines = new Set(informationLines(r.output));
    for (const line of stepLines) {
      total++;
      if (!t.infoLines.has(line)) {
        fresh++;
        if (t.infoLines.size < INFO_LINE_CAP) t.infoLines.add(line);
      }
    }
  }
  if (total < NO_INFO_MIN_LINES) return; // output quá bé: chưa đủ cơ sở
  t.noInfoStreak = fresh / total < NO_INFO_NOVELTY ? t.noInfoStreak + 1 : 0;
}

/**
 * No-new-information breaker — loop NGUY HIỂM NHẤT vì nó không lặp args.
 *
 * Log thật (`~/.scoder/sessions/20261126-141619-e507`): model fetch
 * `angular.dev/what-new/angular-22-1 … -39`, mỗi URL một chữ ký khác nhau nên
 * streak/cycle/scattered đều im lặng, nhưng cả 39 response là CÙNG một trang ⇒
 * 5 phút và ~40 bước không thêm gì. Detector này đo thông tin, không đo lệnh.
 */
export function noNewInformationRule(opts: GuardrailOptions): GuardrailRule {
  const injectAt = Math.max(3, opts.doomLoopRepeats + 1);
  return {
    name: "no-new-information",
    description:
      `end a run whose tool outputs keep repeating already-seen content — warn after ` +
      `${injectAt} consecutive uninformative steps, stop after the next one`,
    evaluate(ctx) {
      const t = ctx as GuardrailContext & TrackerState;
      if (!ctx.hasToolCalls) return null;
      if (t.noInfoStreak < injectAt) return null;
      const why = `${t.noInfoStreak} consecutive tool steps returned under ${Math.round(NO_INFO_NOVELTY * 100)}% new content`;
      if (t.noInfoInterventions >= 1) {
        const tail = (ctx.text || "").trim().slice(0, 400);
        return {
          action: {
            kind: "finish",
            success: false,
            summary:
              `Stopped: ${why} — the agent kept gathering the same information. ` +
              (tail ? `Last answer before stopping:\n${tail}` : "Answer from what is already in the conversation."),
          },
          reason: `${why}; ended the run (interventions=${t.noInfoInterventions})`,
        };
      }
      return {
        action: {
          kind: "inject",
          reminder:
            `<system-reminder>${why} — including different URLs/paths that return the SAME content. ` +
            `More calls of this kind will not help. Stop collecting and answer with the information you ` +
            `already have, or state exactly what is missing.</system-reminder>`,
        },
        reason: why,
      };
    },
  };
}

/**
 * Context management: chỉ cắt gọn lịch sử khi history THẬT SỰ vượt ngân sách.
 *
 * Trước đây rule này trả `trim` vô điều kiện mỗi bước (RC-1) → `trimHistory()`
 * chạy mỗi bước và dịch chuyển boundary prune → prefix prompt đổi từng token
 * → local model (llama.cpp/Ollama) re-prefill toàn bộ history mỗi lượt.
 * Loop truyền `historyPressure` (tokens/budget đã ước lượng sẵn); thiếu nó thì
 * rule không kích hoạt — an toàn theo hướng "không phá cache".
 */
export const historyTrimRule: GuardrailRule = {
  name: "history-trim",
  description: "trim message history only when it exceeds the token budget (KV-cache stable prefix)",
  evaluate(ctx) {
    const p = ctx.historyPressure;
    if (!p || !p.over) return null;
    return {
      action: { kind: "trim" },
      reason: `history ${p.tokens} tokens > budget ${p.budget}`,
    };
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
  description: "a tool call ran the exact build command — success ends the run (coding tasks), failure re-verifies",
  evaluate(ctx) {
    if (!ctx.hasToolCalls || !ctx.buildCallPresent) return null;
    const summary = ctx.text || "Build passed.";
    // Review/report/read-only tasks do not modify files: a passing build is only
    // verification, not a stop condition — do not end the run on it, so the
    // agent can deliver its final report instead of stopping on the build result.
    if (!ctx.filesModified && ctx.buildPassedThisStep) {
      return null;
    }
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
    // F2 phải đứng TRƯỚC mọi rule finish: chat-done / text-only-streak /
    // continue-nudge đều coi text cuối của model là đáp án đúng — chính chúng gây
    // ra triệu chứng "run dừng bằng vài chữ". Có retry ở đây thì các rule kia còn
    // nguyên vai trò cho câu trả lời hợp lệ.
    staleAnswerRule,
    chatDoneRule,
    // G6: budget rule đứng sớm — vượt cap là finish ngay, trước mọi rule khác
    // (trừ wrap-up, vốn vô hại khi budget đã cạn).
    ...(opts.tokenBudget ? [tokenBudgetRule(opts.tokenBudget)] : []),
    completionClaimRule,
    textOnlyStreakRule(opts),
    continueNudgeRule,
    doomLoopRule(opts),
    noNewInformationRule(opts),
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
  private tracker: TrackerState = freshTracker();

  constructor(
    rules?: GuardrailRule[],
    private onDecision?: (d: GuardrailDecision) => void,
  ) {
    this.rules = rules ?? defaultGuardrailRules();
  }

  /** Reset tracker — gọi ở đầu mỗi run (per-run state, không rò rỉ giữa các run). */
  reset(): void {
    this.tracker = freshTracker();
  }

  /** Steer batch được deliver — reset text-only allowance một lần cho cả batch. */
  notifySteered(): void {
    this.tracker.textOnlyStreak = 0;
  }

  /** Wrap-up reminder vừa được apply — chỉ inject một lần mỗi run. */
  markWrapUpInjected(): void {
    this.tracker.wrapUpInjected = true;
  }

  /**
   * Doom-loop reminder vừa được inject — can thiệp lần sau sẽ finish thay vì nhắc
   * tiếp. runLoop gọi khi áp decision inject của rule doom-loop.
   */
  markLoopIntervention(): void {
    this.tracker.loopInterventions++;
  }

  /** No-new-information reminder vừa inject — lần vô sản tiếp theo sẽ finish. */
  markNoInfoIntervention(): void {
    this.tracker.noInfoInterventions++;
  }

  /**
   * stale-answer reminder vừa inject (F2) — model vẫn trả lời cụt/lặp ở bước sau
   * ⇒ run kết thúc THẤT BẠI với đáp án tốt nhất, không xác nhận rác là kết quả.
   */
  markDegenerateIntervention(): void {
    this.tracker.degenerateInterventions++;
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
      // Doom-loop: chữ ký batch ĐÃ CHUẨN HOÁ args. So với bước trước (streak) và
      // tích luỹ cả run (scattered/cycle) — loop thật của model local đan xen
      // nhiều tool khác nhau nên chỉ so liên tiếp là không đủ.
      const calls = ctx.message?.tool_calls ?? [];
      const callSig = batchSignature(calls);
      t.sigRepeat = callSig === t.lastCallSig ? t.sigRepeat + 1 : 0;
      t.lastCallSig = callSig;
      t.sigWindow.push(callSig);
      if (t.sigWindow.length > SIG_WINDOW) t.sigWindow.shift();
      let maxCount = 0;
      for (const tc of calls) {
        // Chỉ tool đọc mới là bằng loop chắc chắn: `npm test`/`edit_file` lặp lại
        // là vòng verify–fix hợp lệ, không được tính vào scattered counter.
        if (!READ_ONLY_TOOLS.has(tc.name)) continue;
        const key = callSignature(tc.name, tc.arguments);
        const n = (t.callCounts.get(key) ?? 0) + 1;
        t.callCounts.set(key, n);
        if (n > maxCount) maxCount = n;
      }
      t.maxCallCount = maxCount;
      const cycle = detectCycle(t.sigWindow);
      t.cyclePeriod = cycle?.period ?? 0;
      t.cycleCount = cycle?.repeats ?? 0;
      // No-new-information: đếm dòng NỘI DUNG MỚI mà output của bước này mang lại.
      trackInformation(t, ctx, calls);
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
    // F2: dò đáp án degenerate NGAY ở engine — rule nhận bản COPY của tracker nên
    // tự tính trong evaluate thì mutate không sống qua bước kế tiếp.
    t.degenerateInfo = ctx.hasToolCalls
      ? null
      : degenerateAnswer(ctx.text, ctx.priorAssistantTexts ?? [], ctx.toolsUsedThisRun ?? 0);
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

