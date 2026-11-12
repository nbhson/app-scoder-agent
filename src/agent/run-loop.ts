import type { AgentConfig } from "../config/config.js";
import type { BuildResult } from "../workspace/build.js";
import { trimHistory, summariseOutput, historyPressure, MAX_HISTORY_TOKENS, historyTokenBudget } from "../context/context.js";
import { CHAT_DONE_MARKER } from "./guardrails.js";
import { parseDiagnostics, formatDiagnostics, classifyError } from "../workspace/diagnostics.js";
import { shouldCompact, estimateTokens, extractSummaryInput, COMPACTION_INSTRUCTION, applyCompaction, type CompactionConfig } from "../context/compaction.js";
import { redactSecrets, type ChatMessage, type ChatResult, type ToolSpec } from "../llm/llm.js";
import type { ProviderRuntimeContract } from "../llm/provider-registry.js";
import type { PermissionChecker } from "../security/permissions.js";
import type { EventSessionStore } from "../session/session.js";
import type { SnapshotManager } from "../workspace/snapshot.js";
import type { JsonlLogger } from "../session/logger.js";
import type { Reporter } from "../io/reporter.js";
import { createGuardrailEngine } from "./guardrails.js";
import { memoryIsMeaningful, formatWorkingMemory, scanDecisions, type WorkingMemory } from "../context/memory.js";
import { READONLY_TOOLS, type ToolExecutor } from "./tool-executor.js";
import type { AgentEvent, AgentRunResult, UsageTotals } from "./types.js";

/** P0-1: số bước tối thiểu giữa hai lần trim cơ học trong một run. */
export const TRIM_COOLDOWN_STEPS = 3;

/** Dependencies for the autonomous loop. Agent owns state; this module preserves its order of effects. */
export interface RunLoopRuntime {
  config: AgentConfig;
  client: ProviderRuntimeContract;
  messages: ChatMessage[];
  aborted: boolean;
  currentTask: string;
  filesModified: boolean;
  plan: unknown[];
  planNudged: boolean;
  memory: WorkingMemory;
  usageTotals: UsageTotals;
  verifyStrikes: number;
  lastVerifySignature: string;
  selfReviewDone: boolean;
  runSignal: AbortController;
  guardrails: ReturnType<typeof createGuardrailEngine>;
  permissions: PermissionChecker;
  snapshots: SnapshotManager;
  events: EventSessionStore;
  logger: JsonlLogger;
  reporter: Reporter;
  drainSteerInbox(): string[];
  steerCounts(): { pending: number; steering: number };
  chatWithStream(): Promise<ChatResult & { incomplete?: boolean }>;
  recordLlmUsage(usage: ChatResult["usage"]): void;
  /** P1-1: tool specs đang quảng cáo — chi phí cố định của mỗi lượt gọi. */
  tools(): ToolSpec[];
  /** P1-1: chi phí cố định/lượt (schema + chat template), ưu tiên số đo thật. */
  fixedPromptTokens(): number;
  fixedPromptSource(): "measured" | "estimate";
  emit(event: AgentEvent): void;
  emitContextEvent(force?: boolean): void;
  toolExecutor(): ToolExecutor;
  verifyAll(buildCmd: string): Promise<BuildResult>;
  selfReviewGate(): Promise<string | null>;
  failureSignature(output: string): string;
  compactionSettings(): CompactionConfig;
  memoryBlock(): { instruction: string; suffix: string };
  snapshotMemory(trigger: string): void;
  saveSession(steps: number, buildCmd: string, lastBuild: BuildResult | null): void;
  finish(success: boolean, steps: number, buildCmd: string, summary: string, chatOnly?: boolean): AgentRunResult;
}

/** The shared autonomous loop; it intentionally retains the existing event and persistence ordering. */
export async function runAgentLoop(
  runtime: RunLoopRuntime,
  startSteps: number,
  buildCmd: string,
  initialBuild: BuildResult | null = null,
): Promise<AgentRunResult> {
    let steps = startSteps;
    let lastBuild: BuildResult | null = initialBuild;
    // G1: guardrail tracker state (textOnlyStreak, sigRepeat, toolError*,
    // lowTokenStreak, wrapUpInjected) sống trong GuardrailEngine — reset mỗi run.
    runtime.guardrails.reset();
    // H-10 compaction config (false = disabled → mechanical trim only).
    // I-02: contextWindow từ model catalog (lookup sync, cache/fallback) thay
    // vì default 128k cứng — compaction trigger chính xác theo model.
    const compactionCfg: CompactionConfig | null =
      runtime.config.compaction === false ? null : runtime.compactionSettings();
    // Compaction-aware trim: mechanical trim scales with the model window and
    // starts AFTER compaction (95% vs 80% trigger). Disabled compaction keeps
    // the legacy conservative 90k cap.
    // P1-1 (RC-4): ngân sách history = window − tool schema − chỗ cho reply.
    // Tool schema không nằm trong messages nên trước đây nó bị tính thiếu
    // ~16–20k token, compaction/trim kích hoạt muộn hơn thực tế đúng bằng
    // chừng đó.
    const fixedPromptTokens = (): number => runtime.fixedPromptTokens();
    const window = compactionCfg?.contextWindow ?? 0;
    const trimBudget = compactionCfg
      ? historyTokenBudget(window, fixedPromptTokens(), runtime.config.maxTokens)
      : MAX_HISTORY_TOKENS;
    // When a run ends early (guardrail finish/build verification) compaction is
    // skipped, so never leave a near-full window for the next turn.
    const safeTrimBudget = Math.min(trimBudget, MAX_HISTORY_TOKENS);
    runtime.logger.log({
      type: "context_budget",
      contextWindow: window,
      toolSchemaTokens: fixedPromptTokens(),
      /** "measured" = suy ra từ prompt_tokens thật của engine (có cả chat
       * template); "estimate" = bộ đếm cl100k trên tool defs, trước lượt gọi đầu. */
      fixedSource: runtime.fixedPromptSource(),
      outputReserve: runtime.config.maxTokens,
      trimBudget,
      tools: runtime.tools().length,
    });
    // Cảnh báo sớm: riêng chi phí cố định đã ăn gần hết window thì mọi tối ưu
    // history đều vô nghĩa — user cần tắt MCP tool hoặc tăng num_ctx.
    const baseline = fixedPromptTokens();
    if (window > 0 && baseline > window * 0.5) {
      runtime.reporter.warn(
        `context window ${window} token nhưng riêng tool schema đã ${baseline} token (${runtime.tools().length} tools) — ` +
        `giảm tool MCP ("mcpTools": {"include":[…]}, "limits": {"mcpSchemaTokens": …}) hoặc tăng num_ctx của server.`,
      );
    }
    // P0-1: trim phá KV-cache từ điểm cắt trở về sau → cooldown giữa hai lần
    // cắt cơ học (trừ khi sắp finish, lúc đó cache không còn giá trị).
    let lastTrimStep = -Infinity;
    const applyTrim = (budget: number, force = false): void => {
      const before = runtime.messages.length;
      const pressure = historyPressure(runtime.messages, budget);
      if (!pressure.over) return;
      if (!force && steps - lastTrimStep < TRIM_COOLDOWN_STEPS) return;
      const next = trimHistory(runtime.messages, budget);
      if (next === runtime.messages) return;
      lastTrimStep = steps;
      runtime.messages = next;
      runtime.logger.log({
        type: "context_trim",
        step: steps,
        tokens: pressure.tokens,
        budget,
        messagesBefore: before,
        messagesAfter: next.length,
      });
    };

    while (steps < runtime.config.maxSteps && !runtime.aborted) {
      // ── Safe step boundary: deliver steered user input (H-08) ────────────
      const steered = runtime.drainSteerInbox();
      if (steered.length > 0) {
        for (const s of steered) {
          runtime.messages.push({ role: "user", content: s });
          runtime.events.append({ type: "message.added", message: { role: "user", content: s } });
        }
        // One allowance reset for the whole steering batch (opencode behavior)
        // — engine exposes a hook so the runLoop doesn't touch tracker state.
        runtime.guardrails.notifySteered();
        runtime.emit({ type: "steer_delivered", count: steered.length });
        runtime.emit({ type: "queue", ...runtime.steerCounts() });
        runtime.reporter.info(`steer: +${steered.length} user message(s) delivered`);
      }

      // v2 (3.4): fold the ledger into the conversation every 6 steps.
      if (steps > 0 && steps % 6 === 0 && memoryIsMeaningful(runtime.memory)) {
        runtime.messages.push({ role: "user", content: formatWorkingMemory(runtime.memory) });
      }

      steps++;
      runtime.reporter.step(steps, runtime.config.maxSteps, "thinking...");
      runtime.events.claimExecution(steps);
      runtime.emit({ type: "step", step: steps, maxSteps: runtime.config.maxSteps });

      // Metrics: thời gian phần LLM của bước này (điều chỉnh chất lượng +
      // so sánh provider; hiển thị trong `scoder cost`).
      const stepStart = Date.now();
      const { message, usage, incomplete } = await runtime.chatWithStream().catch((err: unknown) => {
        // SIGINT during the LLM call — stop gracefully instead of crashing
        if (runtime.aborted) {
          return {
            message: { role: "assistant" as const, content: null, tool_calls: undefined },
            usage: undefined,
            incomplete: undefined,
          };
        }
        throw err;
      });
      if (runtime.aborted) break;
      runtime.recordLlmUsage(usage);
      runtime.emitContextEvent();
      runtime.logger.log({ type: "step", step: steps, durationMs: Date.now() - stepStart, toolCalls: message.tool_calls?.length ?? 0 });

      // H-09: after an interrupted stream, nudge the model to continue rather
      // than restart (synthetic continuation instruction, opencode pattern).
      if (incomplete) {
        runtime.messages.push({
          role: "user",
          content: "[system] The previous response was cut off mid-stream. The tool call(s) above were received in full — continue exactly where you left off; do not repeat completed work.",
        });
        runtime.events.append({ type: "retry.scheduled", reason: "incomplete-stream continuation" });
      }

      // ── Chuẩn bị context cho Guardrail Engine ─────────────────────────────
      // Chat marker được làm sạch ở đây để rule nhận text đã chuẩn hoá.
      const hasToolCalls = !!message.tool_calls && message.tool_calls.length > 0;
      let text = message.content ?? "";
      let chatDone = false;
      if (!hasToolCalls && text.includes(CHAT_DONE_MARKER)) {
        chatDone = true;
        text = text.split(CHAT_DONE_MARKER)[0].trim();
      }

      if (!hasToolCalls) {
        runtime.messages.push({ role: "assistant", content: text });
        runtime.events.append({ type: "message.added", message: { role: "assistant", content: text } });
        runtime.reporter.llm("agent", text);
        scanDecisions(runtime.memory, text);
      } else {
        runtime.messages.push({
          role: "assistant",
          content: message.content ?? null,
          tool_calls: message.tool_calls,
        });
        runtime.events.append({ type: "message.added", message: runtime.messages[runtime.messages.length - 1] });
        if (typeof message.content === "string") scanDecisions(runtime.memory, message.content);
      }

      // v2 (3.3): soft guardrail — editing without a plan gets a reminder.
      const batchMayWriteEarly = (message.tool_calls ?? []).some((tc) => tc.name === "write_file" || tc.name === "edit_file" || tc.name === "apply_patch");
      if (batchMayWriteEarly && runtime.plan.length === 0 && !runtime.planNudged) {
        runtime.planNudged = true;
        runtime.messages.push({
          role: "user",
          content:
            "[system] You modified files without a plan. Call write_todos now with the full remaining plan " +
            "(steps with verify + acceptance), then continue. One step in_progress at a time.",
        });
      }
      // Execute each tool call (validate args before running)
      const stepToolResults = new Map<string, { ok: boolean; output: string }>();
      // H-11: checkpoint before any batch that may write files.
      const batchMayWrite = (message.tool_calls ?? []).some((tc) => tc.name === "write_file" || tc.name === "edit_file" || tc.name === "apply_patch");
      if (batchMayWrite) runtime.snapshots.capture(`step ${steps}: ${(message.tool_calls ?? []).map((t) => t.name).join(",")}`);
      // I-09: parallelize read-only tool calls (concurrency cap 4); mutating
      // calls (and any batch containing an ask-gated call) run sequentially.
      const calls = message.tool_calls ?? [];
      const needsAsk = calls.some((tc) => {
        if (tc.name !== "run_command") return false;
        try {
          const a = JSON.parse(tc.arguments || "{}") as { command?: unknown };
          if (typeof a.command !== "string") return false;
          const d = runtime.permissions.classifyShell(a.command);
          return d.decision === "ask" || d.decision === "deny";
        } catch {
          return true;
        }
      });
      if (calls.length > 1 && !needsAsk) {
        const readOnly = calls.every((tc) => READONLY_TOOLS.has(tc.name));
        if (readOnly) {
          const executor = runtime.toolExecutor();
          const results = await executor.parallelMap(calls, (tc) => executor.executeToolCall(tc, steps, stepToolResults), Math.max(1, runtime.config.limits?.toolConcurrency ?? 4));
          for (const r of results) {
            if (r.post) r.post();
          }
        } else {
          for (const tc of calls) {
            if (runtime.aborted) break;
            const r = await runtime.toolExecutor().executeToolCall(tc, steps, stepToolResults);
            if (r.post) r.post();
          }
        }
      } else {
        for (const tc of calls) {
          if (runtime.aborted) break;
          const r = await runtime.toolExecutor().executeToolCall(tc, steps, stepToolResults);
          if (r.post) r.post();
        }
      }
      // ── Guardrail Engine — đánh giá toàn bộ rule sau khi tools chạy xong ──
      // Thông tin build stop condition: có tool call nào chạy ĐÚNG buildCmd?
      // Match theo arguments đã parse (đúng hơn substring: "npm run build && rm -rf /"
      // vẫn tính là build call, nhưng lệnh echo chứa chuỗi buildCmd thì không).
      const buildCall = hasToolCalls
        ? (message.tool_calls ?? []).find(
            (tc) =>
              tc.name === "run_command" &&
              (() => {
                try {
                  const a = JSON.parse(tc.arguments || "{}") as { command?: unknown };
                  return typeof a.command === "string" && a.command.includes(buildCmd);
                } catch {
                  return false;
                }
              })(),
          )
        : undefined;
      let buildPassedThisStep = false;
      if (buildCall) {
        const r = stepToolResults.get(buildCall.id);
        if (r && r.ok) buildPassedThisStep = true;
      }

      const decisions = await runtime.guardrails.evaluate({
        step: steps,
        maxSteps: runtime.config.maxSteps,
        text,
        message,
        hasToolCalls,
        toolResults: stepToolResults,
        buildPassedThisStep,
        buildCallPresent: !!buildCall,
        filesModified: runtime.filesModified,
        chatDone,
        outputTokensThisStep: usage?.completion_tokens,
        totalTokensIn: runtime.usageTotals.inputTokens, // G6 budget rule
        totalTokensOut: runtime.usageTotals.outputTokens,
        // P0-1: rule history-trim chỉ fires khi history THẬT SỰ vượt ngân sách
        // (trước đây nó fires mỗi bước → trim mỗi bước → mất KV-cache).
        historyPressure: historyPressure(runtime.messages, trimBudget),
      });

      // Áp dụng decision: finish đầu tiên thắng; inject gom lại đẩy một lần.
      const reminders: string[] = [];
      let doTrim = false;
      for (const d of decisions) {
        const a = d.action;
        if (a.kind === "inject") {
          if (d.rule === "wrap-up") runtime.guardrails.markWrapUpInjected(); // chỉ inject một lần / run
          reminders.push(a.reminder);
          continue;
        }
        if (a.kind === "trim") {
          doTrim = true;
          continue;
        }
        if (a.kind === "verify-build") {
          // Xác minh độc lập với lời của model (async — loop tự chạy verify).
          lastBuild = await runtime.verifyAll(buildCmd);
          if (lastBuild.success) {
            // v2: self-review the diff before calling it done.
            const reviewNote = await runtime.selfReviewGate();
            if (reviewNote) {
              reminders.push(`[self-review] blocking findings — fix these, then verify again:\n${reviewNote}`);
              continue;
            }
            if (doTrim) applyTrim(safeTrimBudget, true);
            return runtime.finish(true, steps, buildCmd, a.successSummary);
          }
          // Structured diagnostics + error class instead of a raw log tail.
          const diags = parseDiagnostics(lastBuild.output);
          const errClass = classifyError(lastBuild.output);
          const signature = runtime.failureSignature(lastBuild.output);
          runtime.verifyStrikes = signature === runtime.lastVerifySignature ? runtime.verifyStrikes + 1 : 1;
          runtime.lastVerifySignature = signature;
          const failBlock = diags.length > 0 ? formatDiagnostics(diags) : summariseOutput(lastBuild.output);
          reminders.push(`${a.failReminder}\n${failBlock}\nError class: ${errClass.kind} — ${errClass.strategy}\nFix and continue.`);
          if (runtime.verifyStrikes >= 4) {
            for (const r of reminders) runtime.messages.push({ role: "user", content: r });
            if (doTrim) applyTrim(safeTrimBudget, true);
            return runtime.finish(false, steps, buildCmd, `Verification failed the same way ${runtime.verifyStrikes} times — stopping. Last error class: ${errClass.kind}.`);
          }
          if (runtime.verifyStrikes >= 2) {
            reminders.push("<system-reminder>The SAME verification failed repeatedly. Stop retrying the identical approach — change strategy fundamentally, or report the blocker in your final message.</system-reminder>");
          }
          continue;
        }
        if (a.kind === "finish") {
          // Giữ nguyên thứ tự tin nhắn như bản inline cũ: reminder (wrap-up)
          // đã đẩy trước khi kết thúc.
          if (a.success && runtime.filesModified && !a.chatOnly && !runtime.selfReviewDone && runtime.config.selfReview !== false) {
            const reviewNote = await runtime.selfReviewGate();
            if (reviewNote) {
              reminders.push(`[self-review] blocking findings — fix these, then verify again:\n${reviewNote}`);
              continue;
            }
          }
          for (const r of reminders) runtime.messages.push({ role: "user", content: r });
          if (doTrim) applyTrim(safeTrimBudget, true);
          return runtime.finish(a.success, steps, buildCmd, a.summary, a.chatOnly ?? false);
        }
      }
      for (const r of reminders) runtime.messages.push({ role: "user", content: r });

      // H-10: LLM compaction when history approaches the context window.
      // Runs BEFORE mechanical trim: trim drops whole turns, which could push
      // the history below the trigger before compaction ever sees it.
      // P1-1 (RC-4): cộng thêm tool schema (chi phí cố định của mỗi lượt) —
      // nếu không, ngưỡng 80% bị đánh giá thấp đúng bằng số token schema
      // (~16k với 46 tool MCP) và compaction đến muộn gần 20k token.
      const schemaTokens = fixedPromptTokens();
      if (compactionCfg && shouldCompact(runtime.messages, compactionCfg, schemaTokens)) {
        try {
          runtime.reporter.info("compaction: summarizing older history…");
          const tokensBefore = estimateTokens(runtime.messages, schemaTokens);
          const summaryInput = extractSummaryInput(runtime.currentTask, runtime.messages);
          const mem = runtime.memoryBlock();
          const summaryRes = await runtime.client.chat(
            [
              ...runtime.messages,
              { role: "user", content: `${summaryInput}\n\n${COMPACTION_INSTRUCTION}${mem.instruction}` },
            ],
            [], // no tools for the summarizer call
            { signal: runtime.runSignal.signal },
          );
          runtime.recordLlmUsage(summaryRes.usage);
          const summary =
            redactSecrets(summaryRes.message.content ?? "History summarized.") + mem.suffix;
          runtime.messages = applyCompaction(runtime.messages, summary, compactionCfg);
          const tokensAfter = estimateTokens(runtime.messages, schemaTokens);
          runtime.events.append({
            type: "compaction.ran",
            tokensBefore,
            tokensAfter,
            summary: summary.slice(0, 2000),
          });
          runtime.snapshotMemory("compaction");
          runtime.reporter.info(`compaction: done (${tokensBefore} → ${tokensAfter} tokens, history now ${runtime.messages.length} messages)`);
          runtime.emit({ type: "compaction", tokensBefore, tokensAfter, manual: false });
          runtime.emitContextEvent(true);
        } catch (err) {
          // Compaction is best-effort — mechanical trim stays as fallback.
          runtime.reporter.warn(`compaction failed (${(err as Error).message.slice(0, 100)}) — using mechanical trim`);
          // Fallback uses the legacy conservative cap: the next LLM call must
          // not leave a near-full window if summarization failed.
          applyTrim(safeTrimBudget, true);
        }
      }
      // P0-1: trim cơ học CHỈ khi guardrail báo over budget (doTrim) và có
      // cooldown — mỗi lần cắt là một lần mất KV-cache của phần còn lại.
      if (doTrim) applyTrim(trimBudget);

      // Persist session state after every step (enables resume after crash/SIGINT)
      runtime.saveSession(steps, buildCmd, lastBuild);
      runtime.events.releaseExecution(steps);
    }

    // Max steps reached or aborted
    const reason = runtime.aborted ? "interrupted by user (SIGINT)" : `reached max steps (${runtime.config.maxSteps})`;
    runtime.saveSession(steps, buildCmd, lastBuild);
    return runtime.finish(false, steps, buildCmd, `Agent stopped: ${reason}`);
  }
