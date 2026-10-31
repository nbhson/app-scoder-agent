import type { AgentConfig } from "./config.js";
import { loadPermissionLists } from "./config.js";
import { LlmClient, LlmError, type ChatMessage, type ChatResult, type ToolCall, type ToolSpec } from "./llm.js";
import { AnthropicClient } from "./provider-anthropic.js";
import { spawnSync } from "node:child_process";
import { AGENT_TOOLS, getTool, type ToolContext, type ToolDiff, type TodoItem } from "./tools.js";
import { detectBuildCommand, runBuild, type BuildResult } from "./build.js";
import { trimHistory, summariseOutput } from "./context.js";
import { createGuardrailEngine, CHAT_DONE_MARKER, type GuardrailDecision } from "./guardrails.js";
import { PROMPT_VERSION, buildSystemPrompt } from "./prompt.js";
import { PermissionChecker } from "./permissions.js";
import { SessionStore, type SessionFile } from "./session.js";
import { JsonlLogger } from "./logger.js";
import { McpManager } from "./mcp.js";
import { discoverSkills, findSkill, formatSkillIndex, type Skill } from "./skills.js";
import * as ui from "./ui.js";

// CHAT_DONE_MARKER import từ guardrails.js (marker chat thuần, rule 9).

/** One-line environment snapshot for the system prompt (cache-stable per run). */
function buildEnvInfo(workdir: string): string {
  let git = "";
  try {
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workdir, encoding: "utf8" });
    if (branch.status === 0) git = ` · git:${branch.stdout.trim()}`;
  } catch {
    /* git unavailable */
  }
  return `Environment: ${process.platform} · node ${process.version}${git} · today ${new Date().toISOString().slice(0, 10)}`;
}


export interface AgentRunResult {
  success: boolean;
  steps: number;
  buildCmd: string | null;
  summary: string;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * Structured run events — emitted by the Agent so alternative frontends
 * (the `scoder serve` HTTP/SSE API) can render runs without touching the UI.
 */
export type AgentEvent =
  | { type: "run_start"; task: string; model: string; provider: string; workdir: string; buildCmd: string; permission: string }
  | { type: "step"; step: number; maxSteps: number }
  | { type: "llm_delta"; delta: string }
  | { type: "llm_usage"; usage: { input_tokens?: number; output_tokens?: number; cached_tokens?: number } }
  | { type: "tool_call"; step: number; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_output"; name: string; stream: "stdout" | "stderr"; delta: string }
  | {
      type: "tool_result";
      step: number;
      name: string;
      ok: boolean;
      output: string;
      /** Present for file-writing tools — unified diff of the change. */
      diff?: ToolDiff;
    }
  | { type: "build"; success: boolean; command: string; output: string }
  | { type: "todo"; items: TodoItem[] }
  /** Guardrail Engine kích hoạt một rule (dùng cho metrics/debug frontend). */
  | { type: "guardrail"; rule: string; action: string; reason: string }
  | { type: "finish"; success: boolean; steps: number; summary: string }
  | { type: "error"; message: string };

export class Agent {
  private client: LlmClient | AnthropicClient;
  private messages: ChatMessage[] = [];
  private tools: ToolSpec[] = AGENT_TOOLS.map((t) => t.spec);
  private ctx: ToolContext;
  private permissions: PermissionChecker;
  private session: SessionStore;
  private logger: JsonlLogger;
  private aborted = false;
  private streamFallbackWarned = false;
  private sessionCreatedAt: string | undefined;
  private currentTask = "";
  private lastBuildResult: BuildResult | null = null;
  /** Accumulated token usage across the current run (session state). */
  private usageTotals: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  private mcp: McpManager | null = null;
  /** Aborted when abort() is called — cancels in-flight LLM requests (SIGINT). */
  private runSignal = new AbortController();
  /** Optional structured-event sink (used by the HTTP/SSE server frontend). */
  onEvent: ((ev: AgentEvent) => void) | null = null;
  /** Set while a tool call is executing, for tool_output event correlation. */
  private currentToolCall: { step: number; id: string; name: string } | null = null;
  /** True once any file-writing tool succeeded during the current run. */
  private filesModified = false;
  /** Discovered skills (project + global). */
  private skills: Skill[] = [];
  /** Content staged via /skill — injected before the next run/turn. */
  private pendingContext: string[] = [];
  /** Session plan (write_todos tool). */
  private plan: TodoItem[] = [];
  /** Guardrail Engine — các rule an toàn/tiến trình của runLoop. */
  private guardrails = createGuardrailEngine({}, (d) => this.logGuardrailDecision(d));

  /** Log một quyết định guardrail ra JSONL + event (quan sát được, không ồn ào UI). */
  private logGuardrailDecision(d: GuardrailDecision): void {
    const kind = d.action.kind;
    this.logger.log({ type: "guardrail", rule: d.rule, action: kind, reason: d.reason });
    this.emit({ type: "guardrail", rule: d.rule, action: kind, reason: d.reason });
  }

  constructor(private config: AgentConfig) {
    const commonOpts = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    };
    this.client =
      config.provider === "anthropic"
        ? new AnthropicClient(commonOpts)
        : new LlmClient({ ...commonOpts, stream: config.stream });
    const permLists = loadPermissionLists(config.workdir);
    this.permissions = new PermissionChecker({
      mode: config.permissionMode,
      allowCommands: permLists.allowCommands,
      denyCommands: permLists.denyCommands,
      nonInteractive: config.yes,
    });
    this.ctx = {
      workdir: config.workdir,
      permissions: this.permissions,
      permissionMode: config.permissionMode,
      onToolOutput: this.handleToolOutput,
      plan: {
        get: () => this.plan,
        set: (items) => {
          this.plan = items;
          const done = items.filter((t) => t.status === "completed").length;
          ui.info(`plan: ${done}/${items.length} completed`);
          this.emit({ type: "todo", items: [...items] });
          this.logger.log({ type: "todo", items });
        },
      },
    };
    this.session = new SessionStore(config.workdir, config.noSave !== true);
    this.logger = JsonlLogger.forSession(config.workdir, this.session.id, config.logFile);
    this.skills = discoverSkills(config.workdir);
  }

  /**
   * Handle SIGINT: abort gracefully after current tool finishes.
   * Also kills any in-flight run_command child process via the context signal.
   */
  abort(): void {
    this.aborted = true;
    this.runSignal.abort(new DOMException("interrupted by user", "AbortError"));
  }

  /** Reset the run-signal so a new run() can use a fresh controller. */
  private resetRunSignal(): void {
    this.runSignal = new AbortController();
    this.aborted = false;
    // Keep the tool context in sync so run_command can observe SIGINT and
    // terminate its child process immediately (long builds must be interruptible).
    this.ctx.signal = this.runSignal.signal;
  }

  /** Emit one structured run event to the sink (if attached). */
  private emit(ev: AgentEvent): void {
    this.onEvent?.(ev);
  }

  /**
   * Live tool-output handler: renders chunks in the terminal (dimmed block) and
   * forwards them as `tool_output` events. Opens the stream block lazily on the
   * first chunk; `endToolStream()` closes it after the tool completes.
   */
  private handleToolOutput = (name: string, stream: "stdout" | "stderr", delta: string): void => {
    if (!ui.isToolStreamOpen()) {
      ui.toolStreamStart();
    }
    ui.toolStreamChunk(delta);
    this.emit({ type: "tool_output", name, stream, delta });
  };

  /** Close the live tool-output block (if open) before printing the next UI element. */
  private endToolStream(): void {
    if (ui.isToolStreamOpen()) ui.toolStreamEnd();
  }

  /** Push one tool-result message back into the conversation. */
  private pushToolResult(tc: ToolCall, content: string): void {
    this.messages.push({
      role: "tool",
      tool_call_id: tc.id,
      name: tc.name,
      content,
    });
  }

  /**
   * Handle a rejected tool call (unknown tool, policy denial, user denial):
   * render the failure, log the event, and push an ERROR tool message so the
   * LLM can react. Replaces the previously duplicated denied/deny/unknown blocks.
   */
  private rejectToolCall(
    step: number,
    tc: ToolCall,
    output: string,
    logExtra: Record<string, unknown>,
  ): void {
    ui.toolResult(tc.name, false, output);
    this.emit({ type: "tool_result", step, name: tc.name, ok: false, output });
    this.logger.log({ type: "tool", step, tool: tc.name, ok: false, ...logExtra });
    this.pushToolResult(tc, output);
  }

  /**
   * Record usage of one LLM call: render token counts, log an `llm_usage`
   * event, and accumulate totals into session state.
   */
  /** Token usage totals accumulated in this session (for REPL `/cost`). */
  getUsage(): UsageTotals {
    return { ...this.usageTotals };
  }

  private recordLlmUsage(usage: ChatResult["usage"]): void {    if (!usage) return;
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const cached = usage.cached_tokens ?? 0;
    this.usageTotals.calls += 1;
    this.usageTotals.inputTokens += input;
    this.usageTotals.outputTokens += output;
    this.usageTotals.cachedTokens += cached;
    ui.info(`tokens: in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"}`);
    this.emit({
      type: "llm_usage",
      usage: { input_tokens: input, output_tokens: output, cached_tokens: cached },
    });
    this.logger.log({
      type: "llm_usage",
      model: this.client.model,
      provider: this.config.provider,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
      },
    });
  }

  /** Reset per-run usage accumulation (called when a fresh run starts). */
  private resetUsageTotals(): void {
    this.usageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  }

  /**
   * One LLM turn: streaming if enabled (renders deltas live), with automatic
   * fallback to non-streaming when the provider/stream fails.
   */
  private async chatWithStream(): Promise<ChatResult> {
    const signal = this.runSignal.signal;
    if (!this.config.stream) {
      return this.client.chat(this.messages, this.tools, { signal });
    }
    try {
      let streamedText = "";
      let final: ChatResult | undefined;
      let started = false;

      for await (const chunk of this.client.streamChat(this.messages, this.tools, { signal })) {
        if (chunk.contentDelta) {
          if (!started) {
            ui.llmStreamStart("assistant");
            started = true;
          }
          ui.llmStreamChunk(chunk.contentDelta);
          this.emit({ type: "llm_delta", delta: chunk.contentDelta });
          streamedText += chunk.contentDelta;
        }
        if (chunk.final) final = chunk.final;
      }

      if (started) ui.llmStreamEnd();

      if (final) {
        if ((final.message.content == null || final.message.content === "") && streamedText) {
          final.message.content = streamedText;
        }
        return final;
      }
      // No finish_reason seen — fall through to non-streaming
      return this.client.chat(this.messages, this.tools);
    } catch (err) {
      // A timeout is a real failure, not a streaming quirk — falling back to
      // non-streaming would just wait the full timeout a second time.
      const e = err as Error;
      if (e?.name === "TimeoutError" || /timed out|TimeoutError/i.test(e?.message ?? "")) {
        throw err instanceof LlmError ? err : new LlmError(`LLM request timed out: ${e?.message ?? err}`);
      }
      if (err instanceof LlmError && !this.streamFallbackWarned) {
        this.streamFallbackWarned = true;
        ui.warn(`streaming unavailable (${err.message.slice(0, 120)}) — falling back to non-streaming`);
      }
      return this.client.chat(this.messages, this.tools);
    }
  }

  private get buildCmd(): string {
    return this.config.buildCmd ?? detectBuildCommand(this.config.workdir) ?? "echo BUILD";
  }

  /** Connect configured MCP stdio servers (if any) and merge their tools. */
  private async connectMcp(): Promise<void> {
    const servers = this.config.mcpServers ?? {};
    if (Object.keys(servers as Record<string, unknown>).length === 0) return;
    // Idempotent: /mcp may connect while idle — never spawn a second set of
    // server processes (the first manager's children would leak).
    if (this.mcp) return;
    if (this.config.permissionMode === "readonly") {
      ui.warn("readonly mode: MCP tools are disabled (they bypass the permission system)");
    }
    this.mcp = new McpManager(servers);
    await this.mcp.connectAll();
    const mcpSpecs = this.mcp.toToolSpecs();
    if (mcpSpecs.length > 0) {
      this.tools = [...AGENT_TOOLS.map((t) => t.spec), ...mcpSpecs];
    }
  }

  /** Disconnect MCP servers at the end of a run. */
  private shutdownMcp(): void {
    this.mcp?.killAll();
    this.mcp = null;
  }

  /**
   * Autonomous closed loop:
   * task -> LLM plans -> tool calls -> build -> on failure: read error, patch, retry.
   */
  async run(task: string): Promise<AgentRunResult> {
    if (!this.config.apiKey) {
      throw new Error(
        "No API key configured. Set SCODER_API_KEY or OPENAI_API_KEY (or put apiKey in .scoderrc.json).",
      );
    }

    const buildCmd = this.buildCmd;
    ui.banner("scoder", [
      ["task", task],
      ["model", `${this.client.model} (${this.config.provider}${this.config.stream ? ", stream" : ""})`],
      ["workdir", this.config.workdir],
      ["build", buildCmd],
      ["steps", `max ${this.config.maxSteps}  ·  permission ${this.config.permissionMode}`],
    ]);

    this.currentTask = task;
    this.resetRunSignal();
    this.resetUsageTotals();
    this.filesModified = false;
    this.plan = [];
    const skillsBlock =
      this.skills.length > 0
        ? `\n\nAVAILABLE SKILLS (project + global .scoder/skills/<name>/SKILL.md):\n${formatSkillIndex(this.skills)}\nDynamic selection: BEFORE planning, scan this index against the task. If any skill's description matches the task's domain or workflow, call load_skill with its name FIRST and follow the returned instructions — the skill may change how you approach the whole task. Do not load a skill merely because it is listed; only when it genuinely matches. If two skills match, prefer the more specific one.`
        : "";
    this.messages = [
      {
        role: "system",
        content: buildSystemPrompt({
          workdir: this.config.workdir,
          buildCmd,
          envInfo: buildEnvInfo(this.config.workdir),
          skillsBlock,
        }),
      },
      ...this.pendingContext.map((content) => ({ role: "user" as const, content })),
      { role: "user", content: task },
    ];
    this.pendingContext = [];
    // Phiên bản system prompt được ghi vào log — giúp so sánh chất lượng
    // giữa các phiên bản prompt khi phân tích JSONL.
    this.logger.log({ type: "prompt_version", version: PROMPT_VERSION });
    this.emit({
      type: "run_start",
      task,
      model: this.client.model,
      provider: this.config.provider,
      workdir: this.config.workdir,
      buildCmd,
      permission: this.config.permissionMode,
    });

    try {
      await this.connectMcp();
      return await this.runLoop(0, buildCmd, null);
    } finally {
      this.shutdownMcp();
    }
  }

  /**
   * One conversational turn in an ongoing session (used by the REPL):
   * appends the task to the existing message history instead of resetting it,
   * then runs the autonomous loop. First call behaves like run().
   */
  async runTurn(task: string): Promise<AgentRunResult> {
    if (this.messages.length === 0) {
      return this.run(task);
    }
    const buildCmd = this.buildCmd;
    this.currentTask = `${this.currentTask}\n${task}`.trim();
    this.resetRunSignal();
    this.resetUsageTotals();
    this.filesModified = false;
    this.plan = [];
    for (const content of this.pendingContext) this.messages.push({ role: "user", content });
    this.pendingContext = [];
    this.messages.push({ role: "user", content: task });
    try {
      await this.connectMcp();
      return await this.runLoop(0, buildCmd, null);
    } finally {
      this.shutdownMcp();
    }
  }

  /**
   * Resume a previous session: restore messages/step count and continue the loop.
   * An optional follow-up task is appended as a new user message.
   */
  async resume(session: SessionFile, followUp?: string): Promise<AgentRunResult> {
    const buildCmd = this.buildCmd;
    this.sessionCreatedAt = session.createdAt;
    this.currentTask = session.task;
    this.resetRunSignal();
    this.resetUsageTotals();
    this.filesModified = false;
    this.skills = discoverSkills(this.config.workdir);
    this.messages = session.messages ?? [];

    ui.header(`RESUME ${session.id}`);
    ui.info(`previous task: ${session.task} (${session.steps} step(s) done)`);

    if (followUp) {
      for (const content of this.pendingContext) this.messages.push({ role: "user", content });
      this.pendingContext = [];
      this.messages.push({ role: "user", content: followUp });
    } else {
      this.messages.push({
        role: "user",
        content: "Continue working on the original task. Build must pass before you finish.",
      });
    }

    const lastBuild: BuildResult | null = session.lastBuild
      ? { success: session.lastBuild.success, command: session.lastBuild.command, output: session.lastBuild.output }
      : null;

    try {
      await this.connectMcp();
      return await this.runLoop(session.steps ?? 0, buildCmd, lastBuild);
    } finally {
      this.shutdownMcp();
    }
  }

  /**
   * The shared autonomous loop:
   * LLM plans -> tool calls -> build -> on failure: read error, patch, retry.
   */
  private async runLoop(
    startSteps: number,
    buildCmd: string,
    initialBuild: BuildResult | null = null,
  ): Promise<AgentRunResult> {
    let steps = startSteps;
    let lastBuild: BuildResult | null = initialBuild;
    let textOnlyStreak = 0;
    let lastCallSig = "";
    let sigRepeat = 0;
    let wrapUpInjected = false;

    while (steps < this.config.maxSteps && !this.aborted) {
      steps++;
      ui.step(steps, this.config.maxSteps, "thinking...");
      this.emit({ type: "step", step: steps, maxSteps: this.config.maxSteps });

      // Metrics: thời gian phần LLM của bước này (điều chỉnh chất lượng +
      // so sánh provider; hiển thị trong `scoder cost`).
      const stepStart = Date.now();
      const { message, usage } = await this.chatWithStream().catch((err: unknown) => {
        // SIGINT during the LLM call — stop gracefully instead of crashing
        if (this.aborted) {
          return {
            message: { role: "assistant" as const, content: null, tool_calls: undefined },
            usage: undefined,
          };
        }
        throw err;
      });
      if (this.aborted) break;
      this.recordLlmUsage(usage);
      this.logger.log({ type: "step", step: steps, durationMs: Date.now() - stepStart, toolCalls: message.tool_calls?.length ?? 0 });

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
        this.messages.push({ role: "assistant", content: text });
        textOnlyStreak++;
        ui.llm("agent", text);
      } else {
        this.messages.push({
          role: "assistant",
          content: message.content ?? null,
          tool_calls: message.tool_calls,
        });
        textOnlyStreak = 0;
        // Doom-loop tracking: chữ ký chuỗi tool call so với bước trước.
        const callSig = message
          .tool_calls!.map((tc) => `${tc.name}:${tc.arguments}`)
          .sort()
          .join("|");
        sigRepeat = callSig === lastCallSig ? sigRepeat + 1 : 0;
        lastCallSig = callSig;
      }

      // Execute each tool call (validate args before running)
      const stepToolResults = new Map<string, { ok: boolean; output: string }>();
      for (const tc of message.tool_calls ?? []) {
        if (this.aborted) break;
        const tool = getTool(tc.name);
        let args: Record<string, unknown>;
        try {
          args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
        } catch {
          this.pushToolResult(tc, `ERROR: invalid JSON arguments: ${tc.arguments.slice(0, 200)}`);
          continue;
        }

        ui.toolCall(tc.name, args);
        this.currentToolCall = { step: steps, id: tc.id, name: tc.name };
        this.emit({ type: "tool_call", step: steps, id: tc.id, name: tc.name, args });

        if (!tool && !(this.mcp?.hasTool(tc.name))) {
          this.rejectToolCall(steps, tc, `ERROR: unknown tool "${tc.name}". Available: ${AGENT_TOOLS.map((t) => t.spec.function.name).join(", ")}${this.mcp ? " + MCP tools (mcp__<server>__<tool>)" : ""}`, { error: "unknown tool" });
          continue;
        }

        let result;
        try {
          // Permission gate for shell commands
          if (tc.name === "run_command" && typeof args.command === "string") {
            const decision = this.permissions.classify(args.command as string);
            if (decision.decision === "deny") {
              result = {
                ok: false,
                output: `ERROR: command denied by permission policy (${decision.reason}): ${String(args.command).slice(0, 200)}`,
              };
              this.rejectToolCall(steps, tc, result.output, { args, denied: decision.reason });
              continue;
            }
            if (decision.decision === "ask") {
              const allowed = await this.permissions.confirm(args.command as string);
              if (!allowed) {
                result = {
                  ok: false,
                  output: `ERROR: user denied permission to run: ${String(args.command).slice(0, 200)}`,
                };
                this.rejectToolCall(steps, tc, result.output, { args, denied: "user" });
                continue;
              }
            }
          }

          const t0 = Date.now();
          // Route MCP tools first (they carry the mcp__ prefix, not in AGENT_TOOLS)
          if (tool) {
            result = await tool.run(this.ctx, args);
          } else if (this.config.permissionMode === "readonly") {
            // MCP tools are not covered by the permission system (no command
            // classification, no diff preview) — deny them entirely in readonly.
            result = {
              ok: false,
              output: `ERROR: readonly mode — MCP tool "${tc.name}" is disabled. MCP tools bypass the built-in permission policy, so they cannot run in readonly mode.`,
            };
          } else {
            const reg = this.mcp?.getTool(tc.name);
            if (!reg) {
              result = { ok: false, output: `ERROR: unknown tool "${tc.name}"` };
            } else {
              const r = await reg.conn.callTool(reg.toolName, args);
              result = { ok: r.ok, output: r.output.length > 20_000 ? r.output.slice(0, 20_000) + "\n... [truncated]" : r.output };
            }
          }
          this.logger.log({ type: "tool", step: steps, tool: tc.name, args, ok: result.ok, elapsedMs: Date.now() - t0 });
        } catch (err) {
          result = { ok: false, output: `ERROR: ${(err as Error).message}` };
          this.logger.log({ type: "tool", step: steps, tool: tc.name, args, ok: false, error: (err as Error).message });
        }

        // User pressed [q]uit in an edit-confirmation prompt — stop the whole run.
        if (this.permissions.abortRequested) {
          this.aborted = true;
          ui.warn("edit confirmation aborted by user ([q]uit) — stopping the run");
        }

        // Track file modifications — a completion claim with no edits needs no
        // build verification, and conversational turns never touch files.
        if (result.ok && (tc.name === "write_file" || tc.name === "edit_file")) {
          this.filesModified = true;
        }

        this.endToolStream();
        this.currentToolCall = null;
        ui.toolResult(tc.name, result.ok, result.output);
        this.emit({
          type: "tool_result",
          step: steps,
          name: tc.name,
          ok: result.ok,
          output: result.output,
          ...(result.diff ? { diff: result.diff } : {}),
        });
        stepToolResults.set(tc.id, { ok: result.ok, output: result.output });
        this.pushToolResult(tc, summariseOutput(result.output));
      }

      // ── Guardrail Engine — đánh giá toàn bộ rule sau khi tools chạy xong ──
      // Thông tin build stop condition: có tool call nào chạy ĐÚNG buildCmd?
      const buildCall = hasToolCalls
        ? message.tool_calls!.find((tc) => tc.name === "run_command" && tc.arguments.includes(buildCmd))
        : undefined;
      let buildPassedThisStep = false;
      if (buildCall) {
        const r = stepToolResults.get(buildCall.id);
        if (r && r.ok) buildPassedThisStep = true;
      }

      const decisions = this.guardrails.evaluate({
        step: steps,
        maxSteps: this.config.maxSteps,
        text,
        message,
        hasToolCalls,
        buildPassedThisStep,
        buildCallPresent: !!buildCall,
        filesModified: this.filesModified,
        textOnlyStreak,
        sigRepeat,
        wrapUpInjected,
        chatDone,
      });

      // Áp dụng decision: finish đầu tiên thắng; inject gom lại đẩy một lần.
      let reminders: string[] = [];
      let doTrim = false;
      for (const d of decisions) {
        const a = d.action;
        if (a.kind === "inject") {
          if (d.rule === "wrap-up") wrapUpInjected = true; // chỉ inject một lần / run
          reminders.push(a.reminder);
          continue;
        }
        if (a.kind === "trim") {
          doTrim = true;
          continue;
        }
        if (a.kind === "verify-build") {
          // Xác minh độc lập với lời của model (async — loop tự chạy build).
          lastBuild = await this.checkBuild(buildCmd);
          if (lastBuild.success) {
            if (doTrim) this.messages = trimHistory(this.messages);
            return this.finish(true, steps, buildCmd, a.successSummary);
          }
          reminders.push(`${a.failReminder}\n${summariseOutput(lastBuild.output)}\nFix and continue.`);
          continue;
        }
        if (a.kind === "finish") {
          // Giữ nguyên thứ tự tin nhắn như bản inline cũ: reminder (wrap-up)
          // đã đẩy trước khi kết thúc.
          for (const r of reminders) this.messages.push({ role: "user", content: r });
          if (doTrim) this.messages = trimHistory(this.messages);
          return this.finish(a.success, steps, buildCmd, a.summary, a.chatOnly ?? false);
        }
      }
      for (const r of reminders) this.messages.push({ role: "user", content: r });
      if (doTrim) this.messages = trimHistory(this.messages);

      // Persist session state after every step (enables resume after crash/SIGINT)
      this.saveSession(steps, buildCmd, lastBuild);
    }

    // Max steps reached or aborted
    const reason = this.aborted ? "interrupted by user (SIGINT)" : `reached max steps (${this.config.maxSteps})`;
    this.saveSession(steps, buildCmd, lastBuild);
    return this.finish(false, steps, buildCmd, `Agent stopped: ${reason}`);
  }

  /** Persist current agent state to .scoder/sessions/<id>.json. */
  private saveSession(steps: number, buildCmd: string, lastBuild: BuildResult | null): void {
    this.lastBuildResult = lastBuild;
    this.session.save(
      {
        task: this.currentTask,
        model: this.client.model,
        provider: this.config.provider,
        buildCmd,
        steps,
        maxSteps: this.config.maxSteps,
        messages: this.messages,
        lastBuild: lastBuild
          ? { success: lastBuild.success, command: lastBuild.command, output: lastBuild.output.slice(0, 10_000) }
          : null,
        usage: {
          llmCalls: this.usageTotals.calls,
          inputTokens: this.usageTotals.inputTokens,
          outputTokens: this.usageTotals.outputTokens,
          cachedTokens: this.usageTotals.cachedTokens,
        },
      },
      this.sessionCreatedAt,
    );
  }

  /** Explicitly verify the build (independent of what the LLM claims). */
  private async checkBuild(buildCmd: string): Promise<BuildResult> {
    const res = await runBuild(this.config.workdir, buildCmd, (stream, delta) =>
      this.handleToolOutput("build", stream, delta),
    );
    this.endToolStream();
    ui.buildStatus(res.success, res.output);
    this.emit({ type: "build", success: res.success, command: buildCmd, output: res.output });
    this.logger.log({ type: "build", success: res.success, command: buildCmd, output: res.output.slice(0, 10_000) });
    return res;
  }

  // ── Frontend-facing APIs (REPL/TUI slash commands) ─────────────────────────

  /** Skills visible to this project (for /skills). */
  getSkills(): Skill[] {
    return this.skills;
  }

  /**
   * Stage a skill's content for injection before the next run/turn (/skill).
   * Non-destructive: nothing is sent to the LLM until the user submits a task.
   */
  stageSkill(name: string): { ok: boolean; message: string } {
    const skill = findSkill(this.config.workdir, name);
    if (!skill) {
      const names = this.skills.map((s) => s.name).join(", ");
      return { ok: false, message: `skill "${name}" not found${names ? ` — available: ${names}` : " — no skills discovered (try /skills)"}` };
    }
    this.pendingContext.push(`[User loaded skill "${skill.name}" — follow these instructions for the upcoming task]\n\n${skill.body}`);
    return { ok: true, message: `skill "${skill.name}" staged — it will apply to your next task` };
  }

  /** MCP server overview (for /mcp): config always; tools once connected. */
  async mcpStatus(): Promise<Array<{ name: string; command: string; connected: boolean; tools: Array<{ name: string; description?: string }> }>> {
    const configs = (this.config.mcpServers ?? {}) as Record<string, { command: string }>;
    if (!this.mcp) {
      return Object.entries(configs).map(([name, cfg]) => ({ name, command: cfg.command, connected: false, tools: [] }));
    }
    await this.connectMcp();
    const byServer = new Map(this.mcp.listToolsByServer().map((s) => [s.server, s.tools]));
    return Object.entries(configs).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      connected: byServer.has(name),
      tools: byServer.get(name) ?? [],
    }));
  }

  /** Call one MCP tool directly by its full name (mcp__server__tool) (/mcp exec). */
  async callMcpTool(fullName: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string; structured?: Record<string, unknown> }> {
    if (this.config.permissionMode === "readonly") {
      return { ok: false, output: "ERROR: readonly mode — MCP tools are disabled (they bypass the permission policy)." };
    }
    await this.connectMcp();
    const reg = this.mcp?.getTool(fullName);
    if (!reg) {
      return { ok: false, output: `ERROR: unknown MCP tool "${fullName}" — run /mcp to list servers and tools.` };
    }
    // Text shorthand (`/mcp exec <tool> free text`): bind to the tool's first
    // required string property from its inputSchema, so users don't have to
    // hand-write JSON for the common one-argument case.
    if ("__text" in args && typeof args.__text === "string") {
      const props = (reg.def.inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
      const required = (reg.def.inputSchema?.required ?? []) as string[];
      const target =
        required.find((k) => props[k]?.type === "string") ??
        Object.keys(props).find((k) => props[k]?.type === "string");
      if (!target) {
        return { ok: false, output: `ERROR: "${fullName}" has no string parameter — pass JSON args instead.` };
      }
      args = { [target]: args.__text };
    }
    try {
      return await reg.conn.callTool(reg.toolName, args);
    } catch (err) {
      return { ok: false, output: `ERROR: ${(err as Error).message}` };
    }
  }

  /** Switch permission mode at runtime (/permission) — rebuilds the checker. */
  setPermissionMode(mode: "auto" | "ask" | "readonly"): void {
    if (mode === this.config.permissionMode) return;
    this.config = { ...this.config, permissionMode: mode };
    const permLists = loadPermissionLists(this.config.workdir);
    this.permissions = new PermissionChecker({
      mode,
      allowCommands: permLists.allowCommands,
      denyCommands: permLists.denyCommands,
      nonInteractive: this.config.yes,
    });
    this.ctx.permissionMode = mode;
    ui.info(`permission mode → ${mode}`);
  }

  private finish(
    success: boolean,
    steps: number,
    buildCmd: string,
    summary: string,
    chatOnly = false,
  ): AgentRunResult {
    if (success) {
      if (chatOnly) {
        ui.success(`Done in ${steps} step(s).`);
      } else {
        ui.success(`Task complete in ${steps} step(s). Build passed: ${buildCmd}`);
      }
    } else {
      ui.error(`Task NOT complete. ${summary}`);
    }
    this.emit({ type: "finish", success, steps, summary: summary.slice(0, 2000) });
    this.logger.log({ type: "finish", success, steps });
    return { success, steps, buildCmd, summary: summary.slice(0, 2000) };
  }
}
