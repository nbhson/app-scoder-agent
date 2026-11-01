import type { AgentConfig } from "./config.js";
import { loadPermissionLists, loadPolicyRules, loadSavedApprovals, saveApproval } from "./config.js";
import { LlmClient, LlmError, redactSecrets, type ChatMessage, type ChatResult, type ToolCall, type ToolSpec } from "./llm.js";
import type { ToolResult } from "./tools.js";
import { AnthropicClient } from "./provider-anthropic.js";
import { spawnSync } from "node:child_process";
import { getTool, setTaskRunner, allToolSpecs, type ToolContext, type ToolDiff, type TodoItem } from "./tools.js";
import { detectBuildCommand, runBuild, type BuildResult } from "./build.js";
import { trimHistory, summariseOutput, expandMentions } from "./context.js";
import { createGuardrailEngine, CHAT_DONE_MARKER, type GuardrailDecision } from "./guardrails.js";
import { PROMPT_VERSION, buildSystemPrompt } from "./prompt.js";
import { PermissionChecker } from "./permissions.js";
import { SessionStore, EventSessionStore, type SessionFile } from "./session.js";
import { DEFAULT_COMPACTION, shouldCompact, extractSummaryInput, COMPACTION_INSTRUCTION, applyCompaction, type CompactionConfig } from "./compaction.js";
import { SnapshotManager } from "./snapshot.js";
import { contextWindowFor } from "./model-catalog.js";
import { JsonlLogger } from "./logger.js";
import { McpManager } from "./mcp.js";
import { discoverSkills, findSkill, formatSkillIndex, type Skill } from "./skills.js";
import { discoverAgents, findAgent } from "./agents.js";
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
  /** I-05: reasoning/thinking stream delta (rendered dim, toggleable). */
  | { type: "llm_reasoning"; delta: string }
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
  /** User steering input accepted into the inbox (delivered at next step boundary). */
  | { type: "steer_queued"; mode: "steer" | "queue"; text: string }
  /** Steering batch delivered into the conversation at a step boundary. */
  | { type: "steer_delivered"; count: number }
  /** MCP connect/status line (routed through the event stream, not stderr). */
  | { type: "mcp_status"; line: string }
  /** Guardrail Engine kích hoạt một rule (dùng cho metrics/debug frontend). */
  | { type: "guardrail"; rule: string; action: string; reason: string }
  | { type: "finish"; success: boolean; steps: number; summary: string }
  | { type: "error"; message: string };

export class Agent {
  private client: LlmClient | AnthropicClient;
  private messages: ChatMessage[] = [];
  private tools: ToolSpec[] = allToolSpecs();
  private ctx: ToolContext;
  private permissions: PermissionChecker;
  private session: SessionStore;
  /** v2 durable event log (session/ + events.jsonl) — crash recovery + steering. */
  private events: EventSessionStore;
  /** Git shadow-repo checkpoints before write batches (H-11). */
  readonly snapshots: SnapshotManager;
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
  /** Steering inbox — user input delivered at safe step boundaries (H-08). */
  private steerInbox: string[] = [];
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
  /** Guardrail Engine — khởi tạo trong constructor (cần this.config). */
  private guardrails: ReturnType<typeof createGuardrailEngine>;

  /** Log một quyết định guardrail ra JSONL + event (quan sát được, không ồn ào UI). */
  private logGuardrailDecision(d: GuardrailDecision): void {
    const kind = d.action.kind;
    this.logger.log({ type: "guardrail", rule: d.rule, action: kind, reason: d.reason });
    this.emit({ type: "guardrail", rule: d.rule, action: kind, reason: d.reason });
  }

  constructor(private config: AgentConfig) {
    this.guardrails = createGuardrailEngine(config.guardrails ?? {}, (d) => this.logGuardrailDecision(d));
    const commonOpts = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    };
    // I-01: registry-driven runtime — providerDef (custom/builtin) wins; else legacy ternary.
    // I-05: thinking budget = 10% maxTokens khi reasoning on (Anthropic only).
    // I-12: eval harness — scripted client override thay vì construct.
    const thinkingBudget = config.reasoning === "on" ? Math.max(1024, Math.floor(config.maxTokens * 0.25)) : 0;
    this.client = config.clientFactory?.() ??
      (config.providerDef?.kind === "anthropic" || (!config.providerDef && config.provider === "anthropic")
        ? new AnthropicClient({ ...commonOpts, enableCache: config.providerDef?.supportCache ?? true, thinkingBudgetTokens: thinkingBudget })
        : new LlmClient({ ...commonOpts, stream: config.stream }));
    const permLists = loadPermissionLists(config.workdir);
    this.permissions = new PermissionChecker({
      mode: config.permissionMode,
      allowCommands: permLists.allowCommands,
      denyCommands: permLists.denyCommands,
      nonInteractive: config.yes,
      rules: config.permissionRules,
      savedRules: loadSavedApprovals(config.workdir),
      policyRules: loadPolicyRules(config.workdir),
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
      formatter: config.formatter,
      allowSubagents: config.allowSubagents,
    };
    this.session = new SessionStore(config.workdir, config.noSave !== true);
    this.events = new EventSessionStore(config.workdir, config.noSave !== true, this.session.id);
    this.snapshots = new SnapshotManager(config.workdir, config.snapshots !== false);
    // I-06: task tool → child Agent run (same process, own session, event
    // relay, abort cascade via parent's runSignal). Depth-1 only: the runner
    // refuses when the calling agent was constructed with allowSubagents:false
    // (children set this; the runner checks ctx, not a global flag — global
    // registration alone allowed grandchildren through).
    if (config.allowSubagents !== false) {
      setTaskRunner(async (ctx, args) => {
        if ((ctx as { allowSubagents?: boolean }).allowSubagents === false) {
          return { ok: false, output: "ERROR: task tool not available — subagents cannot spawn further subagents (depth limit)." };
        }
        const def = args.agent ? findAgent(config.workdir, args.agent) : findAgent(config.workdir, "explore");
        if (args.agent && !def) {
          return { ok: false, output: `ERROR: agent "${args.agent}" not found — available: ${discoverAgents(config.workdir).filter((a) => a.mode !== "subagent" || a.name === "explore").map((a) => a.name).join(", ")}` };
        }
        const child = new Agent({
          ...config,
          allowSubagents: false,
          model: def?.model ?? config.model,
          maxSteps: def?.steps ?? Math.min(config.maxSteps, 20),
          noSave: true, // subagent runs are ephemeral — no session pollution
          // plan/explore agents stay read-only regardless of parent mode.
          permissionMode: def?.name === "plan" || def?.name === "explore" ? "readonly" : config.permissionMode,
        });
        // Abort cascade: parent abort kills child's in-flight LLM calls.
        this.runSignal.signal.addEventListener("abort", () => child.abort(), { once: true });
        // Event relay: child activity appears as subagent-tagged tool output.
        const tag = `subagent:${def?.name ?? "task"}`;
        child.onEvent = (ev) => {
          if (ev.type === "tool_call") this.emit({ type: "tool_output", name: tag, stream: "stdout", delta: `→ ${ev.name}\n` });
          else if (ev.type === "llm_delta") this.emit({ type: "tool_output", name: tag, stream: "stdout", delta: ev.delta });
        };
        try {
          const res = await child.run(args.prompt);
          return {
            ok: res.success,
            output: res.success
              ? `[subagent ${def?.name ?? "task"} done — ${res.steps} steps]\n${res.summary}`
              : `[subagent ${def?.name ?? "task"} FAILED — ${res.steps} steps]\n${res.summary}`,
          };
        } catch (err) {
          return { ok: false, output: `ERROR: subagent failed: ${(err as Error).message}` };
        }
      });
    }
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

  /**
   * Steer: user input delivered at the NEXT safe step boundary (pattern from
   * opencode "steer by default"). Injected as a user message before the next
   * LLM call; resets the doom-loop text-allowance once for the whole batch.
   */
  steer(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.steerInbox.push(t);
    this.events.append({ type: "steer.enqueued", mode: "steer", text: t });
    this.emit({ type: "steer_queued", mode: "steer", text: t });
  }

  /** Queue: same inbox, but only relevant when the agent is idle (queued run). */
  queue(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.steerInbox.push(t);
    this.events.append({ type: "steer.enqueued", mode: "queue", text: t });
    this.emit({ type: "steer_queued", mode: "queue", text: t });
  }

  /** Drain the steering inbox; delivered at the top of the next step. */
  private drainSteerInbox(): string[] {
    const drained = this.steerInbox;
    this.steerInbox = [];
    return drained;
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
    const msg: ChatMessage = {
      role: "tool",
      tool_call_id: tc.id,
      name: tc.name,
      content,
    };
    this.messages.push(msg);
    this.events.append({ type: "message.added", message: msg });
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

  /** I-09: tools safe to run concurrently (pure reads, no permission ask). */
  private static READONLY_TOOLS = new Set(["read_file", "list_files", "grep", "glob", "load_skill"]);

  /**
   * I-09: bounded-concurrency map preserving input order.
   */
  private async parallelMap<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    limit: number,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Execute one tool call end-to-end: validate args, render, permission gate,
   * run (builtin or MCP), log, and emit result. Returns `post` side-effects to
   * run by the caller AFTER the whole batch completes — in parallel mode these
   * must not interleave with other calls' work (messages order, abort checks).
   */
  private async executeToolCall(
    tc: ToolCall,
    steps: number,
    stepToolResults: Map<string, { ok: boolean; output: string }>,
  ): Promise<{ post?: () => void }> {
    const tool = getTool(tc.name);
    let args: Record<string, unknown>;
    try {
      args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
    } catch {
      this.pushToolResult(tc, `ERROR: invalid JSON arguments: ${tc.arguments.slice(0, 200)}`);
      return {};
    }

    ui.toolCall(tc.name, args);
    this.currentToolCall = { step: steps, id: tc.id, name: tc.name };
    this.emit({ type: "tool_call", step: steps, id: tc.id, name: tc.name, args });

    if (!tool && !this.mcp?.hasTool(tc.name)) {
      this.rejectToolCall(steps, tc, `ERROR: unknown tool "${tc.name}". Available: ${allToolSpecs().map((t) => t.function.name).join(", ")}${this.mcp ? " + MCP tools (mcp__<server>__<tool>)" : ""}`, { error: "unknown tool" });
      return {};
    }

    let result: ToolResult;
    try {
      // Permission gate for shell commands
      if (tc.name === "run_command" && typeof args.command === "string") {
        const decision = this.permissions.classifyShell(args.command as string);
        if (decision.decision === "deny") {
          const output = `ERROR: command denied by permission policy (${decision.reason}): ${String(args.command).slice(0, 200)}`;
          this.rejectToolCall(steps, tc, output, { args, denied: decision.reason });
          return {};
        }
        if (decision.decision === "ask") {
          const allowed = await this.permissions.confirm(args.command as string);
          if (!allowed) {
            const output = `ERROR: user denied permission to run: ${String(args.command).slice(0, 200)}`;
            this.rejectToolCall(steps, tc, output, { args, denied: "user" });
            return {};
          }
        }
      }

      const t0 = Date.now();
      // Route MCP tools first (they carry the mcp__ prefix, not in AGENT_TOOLS)
      if (tool) {
        result = await tool.run(this.ctx, args);
      } else {
        // MCP tools — per-tool permission action (pattern from opencode:
        // action mcp__<server>__<tool>; wildcard rules supported).
        const mcpDecision = this.permissions.classifyAction(tc.name, "*");
        if (mcpDecision?.decision === "deny") {
          const output = `ERROR: MCP tool "${tc.name}" denied by permission policy (${mcpDecision.reason}).`;
          this.rejectToolCall(steps, tc, output, { args, denied: mcpDecision.reason });
          return {};
        }
        if (this.config.permissionMode === "readonly" && mcpDecision?.decision !== "allow") {
          result = {
            ok: false,
            output: `ERROR: readonly mode — MCP tool "${tc.name}" is disabled. Allow it explicitly with a permission rule (mcp__${tc.name.replace(/^mcp__/, "").replace(/__/, "__")} or a wildcard).`,
          };
        } else if (mcpDecision?.decision === "ask" && !this.config.yes) {
          const allowed = await this.permissions.confirmMcpTool(tc.name);
          if (!allowed) {
            const output = `ERROR: user denied permission to call MCP tool: ${tc.name}`;
            this.rejectToolCall(steps, tc, output, { args, denied: "user" });
            return {};
          }
          result = await this.invokeMcpTool(tc.name, args);
        } else {
          result = await this.invokeMcpTool(tc.name, args);
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

    const filesModified = result.ok && (tc.name === "write_file" || tc.name === "edit_file");
    return {
      post: () => {
        // Track file modifications — a completion claim with no edits needs no
        // build verification, and conversational turns never touch files.
        if (filesModified) this.filesModified = true;
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
      },
    };
  }

  /** MCP tool call with output clamp (extracted for I-09 readability). */
  private async invokeMcpTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const reg = this.mcp?.getTool(name);
    if (!reg) return { ok: false, output: `ERROR: unknown tool "${name}"` };
    const r = await reg.conn.callTool(reg.toolName, args);
    return { ok: r.ok, output: r.output.length > 20_000 ? r.output.slice(0, 20_000) + "\n... [truncated]" : r.output };
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
   *
   * H-09 incomplete-stream continuation: when a stream dies mid-flight but a
   * COMPLETE tool-call delta was already accumulated, surface the partial
   * result (flagged `incomplete`) instead of discarding it — the run loop
   * executes the tool calls and continues with a synthetic instruction.
   */
  private async chatWithStream(): Promise<ChatResult & { incomplete?: boolean }> {
    const signal = this.runSignal.signal;
    if (!this.config.stream) {
      return this.client.chat(this.messages, this.tools, { signal });
    }
    let streamedText = "";
    let final: ChatResult | undefined;
    let started = false;
    let sawToolCallDelta = false;
    try {
      for await (const chunk of this.client.streamChat(this.messages, this.tools, { signal })) {
        if (chunk.reasoningDelta) {
          // I-05: reasoning hiển thị dim qua UI stream; không vào llm_delta.
          this.emit({ type: "llm_reasoning", delta: chunk.reasoningDelta });
        }
        if (chunk.contentDelta) {
          if (!started) {
            ui.llmStreamStart("assistant");
            started = true;
          }
          ui.llmStreamChunk(chunk.contentDelta);
          this.emit({ type: "llm_delta", delta: chunk.contentDelta });
          streamedText += chunk.contentDelta;
        }
        if (chunk.toolCallDelta) sawToolCallDelta = true;
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
    } catch (caught) {
      if (started) ui.llmStreamEnd();
      // A timeout is a real failure, not a streaming quirk — falling back to
      // non-streaming would just wait the full timeout a second time.
      const e = caught as Error;
      const isTimeout = e?.name === "TimeoutError" || /timed out|TimeoutError/i.test(e?.message ?? "");
      const err = isTimeout
        ? (caught instanceof LlmError ? caught : new LlmError(`LLM request timed out: ${e?.message ?? caught}`))
        : caught;
      // Incomplete-stream continuation: the stream died (timeout/disconnect)
      // after a complete tool-call delta → execute what we have rather than
      // failing the whole step (pattern from opencode runner).
      if (
        sawToolCallDelta &&
        (isTimeout || /ECONNRESET|socket hang up|network|terminated/i.test(e?.message ?? ""))
      ) {
        const partial = (this.client as { lastPartialToolCalls?: ToolCall[] }).lastPartialToolCalls ?? [];
        if (partial.length > 0) {
          ui.warn("stream interrupted after complete tool-call(s) — continuing with what was received");
          return {
            message: {
              role: "assistant",
              content: streamedText || null,
              tool_calls: partial,
            },
            usage: undefined,
            incomplete: true,
          };
        }
      }
      if (err instanceof LlmError && !this.streamFallbackWarned) {
        this.streamFallbackWarned = true;
        ui.warn(`streaming unavailable (${(err as Error).message.slice(0, 120)}) — falling back to non-streaming`);
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
    this.mcp.onStatus = (line) => {
      this.logger.log({ type: "mcp_status", line });
      this.emit({ type: "mcp_status", line });
      ui.info(line); // setQuiet suppresses this in the TUI — alt-screen stays clean
    };
    await this.mcp.connectAll();
    const mcpSpecs = this.mcp.toToolSpecs();
    if (mcpSpecs.length > 0) {
      this.tools = [...allToolSpecs(), ...mcpSpecs];
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
    // @file mention expansion — task trước khi build messages.
    task = expandMentions(task, this.config.workdir);
    ui.banner("scoder", [
      ["task", task],
      ["model", `${this.client.model} (${this.config.provider}${this.config.stream ? ", stream" : ""})`],
      ["workdir", this.config.workdir],
      ["build", buildCmd],
      ["steps", `max ${this.config.maxSteps}  ·  permission ${this.config.permissionMode}`],
    ]);

    this.currentTask = task;
    this.events.append({ type: "run.started", task });
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
    task = expandMentions(task, this.config.workdir);
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
      this.messages.push({ role: "user", content: expandMentions(followUp, this.config.workdir) });
    } else {
      this.messages.push({
        role: "user",
        content: "Continue working on the original task. Build must pass before you finish.",
      });
    }

    const lastBuild: BuildResult | null = session.lastBuild
      ? { success: session.lastBuild.success, command: session.lastBuild.command, output: session.lastBuild.output }
      : null;
    // v2: opening a resumed run stamps a fresh run.started (event log continuity).
    this.events.append({ type: "run.started", task: this.currentTask });

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
    let toolErrorSig = "";
    let toolErrorRepeat = 0;
    let lowTokenStreak = 0;
    // H-10 compaction config (false = disabled → mechanical trim only).
    // I-02: contextWindow từ model catalog (lookup sync, cache/fallback) thay
    // vì default 128k cứng — compaction trigger chính xác theo model.
    const catalogWindow = contextWindowFor(this.config.provider, this.config.model);
    const compactionCfg: CompactionConfig | null = this.config.compaction === false
      ? null
      : {
          ...DEFAULT_COMPACTION,
          contextWindow: this.config.contextWindow ?? catalogWindow,
          ...(this.config.compaction ?? {}),
        };

    while (steps < this.config.maxSteps && !this.aborted) {
      // ── Safe step boundary: deliver steered user input (H-08) ────────────
      const steered = this.drainSteerInbox();
      if (steered.length > 0) {
        for (const s of steered) {
          this.messages.push({ role: "user", content: s });
          this.events.append({ type: "message.added", message: { role: "user", content: s } });
        }
        // One allowance reset for the whole steering batch (opencode behavior).
        textOnlyStreak = 0;
        this.emit({ type: "steer_delivered", count: steered.length });
        ui.info(`steer: +${steered.length} user message(s) delivered`);
      }

      steps++;
      ui.step(steps, this.config.maxSteps, "thinking...");
      this.events.claimExecution(steps);
      this.emit({ type: "step", step: steps, maxSteps: this.config.maxSteps });

      // Metrics: thời gian phần LLM của bước này (điều chỉnh chất lượng +
      // so sánh provider; hiển thị trong `scoder cost`).
      const stepStart = Date.now();
      const { message, usage, incomplete } = await this.chatWithStream().catch((err: unknown) => {
        // SIGINT during the LLM call — stop gracefully instead of crashing
        if (this.aborted) {
          return {
            message: { role: "assistant" as const, content: null, tool_calls: undefined },
            usage: undefined,
            incomplete: undefined,
          };
        }
        throw err;
      });
      if (this.aborted) break;
      this.recordLlmUsage(usage);
      this.logger.log({ type: "step", step: steps, durationMs: Date.now() - stepStart, toolCalls: message.tool_calls?.length ?? 0 });

      // H-09: after an interrupted stream, nudge the model to continue rather
      // than restart (synthetic continuation instruction, opencode pattern).
      if (incomplete) {
        this.messages.push({
          role: "user",
          content: "[system] The previous response was cut off mid-stream. The tool call(s) above were received in full — continue exactly where you left off; do not repeat completed work.",
        });
        this.events.append({ type: "retry.scheduled", reason: "incomplete-stream continuation" });
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
        this.messages.push({ role: "assistant", content: text });
        this.events.append({ type: "message.added", message: { role: "assistant", content: text } });
        textOnlyStreak++;
        ui.llm("agent", text);
      } else {
        this.messages.push({
          role: "assistant",
          content: message.content ?? null,
          tool_calls: message.tool_calls,
        });
        this.events.append({ type: "message.added", message: this.messages[this.messages.length - 1] });
        textOnlyStreak = 0;
        // Doom-loop tracking: chữ ký chuỗi tool call so với bước trước.
        const callSig = (message.tool_calls ?? [])
          .map((tc) => `${tc.name}:${tc.arguments}`)
          .sort()
          .join("|");
        sigRepeat = callSig === lastCallSig ? sigRepeat + 1 : 0;
        lastCallSig = callSig;
      }

      // Execute each tool call (validate args before running)
      const stepToolResults = new Map<string, { ok: boolean; output: string }>();
      // H-11: checkpoint before any batch that may write files.
      const batchMayWrite = (message.tool_calls ?? []).some((tc) => tc.name === "write_file" || tc.name === "edit_file");
      if (batchMayWrite) this.snapshots.capture(`step ${steps}: ${(message.tool_calls ?? []).map((t) => t.name).join(",")}`);
      // I-09: parallelize read-only tool calls (concurrency cap 4); mutating
      // calls (and any batch containing an ask-gated call) run sequentially.
      const calls = message.tool_calls ?? [];
      const needsAsk = calls.some((tc) => {
        if (tc.name !== "run_command") return false;
        try {
          const a = JSON.parse(tc.arguments || "{}") as { command?: unknown };
          if (typeof a.command !== "string") return false;
          const d = this.permissions.classifyShell(a.command);
          return d.decision === "ask" || d.decision === "deny";
        } catch {
          return true;
        }
      });
      if (calls.length > 1 && !needsAsk) {
        const readOnly = calls.every((tc) => Agent.READONLY_TOOLS.has(tc.name));
        if (readOnly) {
          const results = await this.parallelMap(calls, (tc) => this.executeToolCall(tc, steps, stepToolResults), 4);
          for (const r of results) {
            if (r.post) r.post();
          }
        } else {
          for (const tc of calls) {
            if (this.aborted) break;
            const r = await this.executeToolCall(tc, steps, stepToolResults);
            if (r.post) r.post();
          }
        }
      } else {
        for (const tc of calls) {
          if (this.aborted) break;
          const r = await this.executeToolCall(tc, steps, stepToolResults);
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
        toolErrorSig,
        toolErrorRepeat,
        outputTokensThisStep: usage?.completion_tokens,
        textOnlyLowTokenStreak: lowTokenStreak,
      });
      // Update trackers AFTER evaluate (rules see this step's values).
      const outTok = usage?.completion_tokens ?? undefined;
      lowTokenStreak = outTok !== undefined && outTok < 20 ? lowTokenStreak + 1 : 0;
      const errSig = (message.tool_calls ?? [])
        .map((tc) => {
          const r = stepToolResults.get(tc.id);
          return r && !r.ok ? `${tc.name}:${r.output.slice(0, 80)}` : null;
        })
        .filter(Boolean)
        .sort()
        .join("|");
      toolErrorRepeat = errSig && errSig === toolErrorSig ? toolErrorRepeat + 1 : 0;
      if (errSig) toolErrorSig = errSig;

      // Áp dụng decision: finish đầu tiên thắng; inject gom lại đẩy một lần.
      const reminders: string[] = [];
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

      // H-10: LLM compaction when history approaches the context window.
      if (compactionCfg && shouldCompact(this.messages, compactionCfg)) {
        try {
          ui.info("compaction: summarizing older history…");
          const summaryInput = extractSummaryInput(this.currentTask, this.messages);
          const summaryRes = await this.client.chat(
            [
              ...this.messages,
              { role: "user", content: `${summaryInput}\n\n${COMPACTION_INSTRUCTION}` },
            ],
            [], // no tools for the summarizer call
            { signal: this.runSignal.signal },
          );
          this.messages = applyCompaction(this.messages, redactSecrets(summaryRes.message.content ?? "History summarized."), compactionCfg);
          this.events.append({ type: "compaction.ran", tokensBefore: 0, summary: (summaryRes.message.content ?? "").slice(0, 2000) });
          ui.info(`compaction: done (history now ${this.messages.length} messages)`);
        } catch (err) {
          // Compaction is best-effort — mechanical trim stays as fallback.
          ui.warn(`compaction failed (${(err as Error).message.slice(0, 100)}) — using mechanical trim`);
          this.messages = trimHistory(this.messages);
        }
      }

      // Persist session state after every step (enables resume after crash/SIGINT)
      this.saveSession(steps, buildCmd, lastBuild);
      this.events.releaseExecution(steps);
    }

    // Max steps reached or aborted
    const reason = this.aborted ? "interrupted by user (SIGINT)" : `reached max steps (${this.config.maxSteps})`;
    this.saveSession(steps, buildCmd, lastBuild);
    return this.finish(false, steps, buildCmd, `Agent stopped: ${reason}`);
  }

  /** Persist current agent state (v2 event log + manifest; crash-resumable). */
  private saveSession(steps: number, buildCmd: string, lastBuild: BuildResult | null): void {
    this.lastBuildResult = lastBuild;
    // v2: durable event log is authoritative; JSON manifest is a cheap summary.
    this.events.writeManifest({
      task: this.currentTask,
      model: this.client.model,
      provider: this.config.provider,
      buildCmd,
      steps,
      maxSteps: this.config.maxSteps,
      usage: {
        llmCalls: this.usageTotals.calls,
        inputTokens: this.usageTotals.inputTokens,
        outputTokens: this.usageTotals.outputTokens,
        cachedTokens: this.usageTotals.cachedTokens,
      },
    });
    // v1 snapshot kept in sync (back-compat for /sessions readers, cost, resume).
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

  /** Ask user to approve an MCP tool call; "always" persists a project-scoped rule. */
  async confirmMcpTool(fullName: string): Promise<boolean> {
    return this.permissions.confirmMcpTool(fullName, () => {
      try {
        saveApproval(this.config.workdir, { action: fullName, resource: "*", effect: "allow" });
      } catch { /* persistence failure must not block the run */ }
    });
  }

  /** Switch permission mode at runtime (/permission) — rebuilds the checker. */  setPermissionMode(mode: "auto" | "ask" | "readonly"): void {
    if (mode === this.config.permissionMode) return;
    this.config = { ...this.config, permissionMode: mode };
    const permLists = loadPermissionLists(this.config.workdir);
    this.permissions = new PermissionChecker({
      mode,
      allowCommands: permLists.allowCommands,
      denyCommands: permLists.denyCommands,
      nonInteractive: this.config.yes,
      rules: this.config.permissionRules,
      savedRules: loadSavedApprovals(this.config.workdir),
      policyRules: loadPolicyRules(this.config.workdir),
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
    this.events.append({ type: "finish", success, summary: summary.slice(0, 2000) });
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
