import type { AgentConfig } from "./config.js";
import { loadPermissionLists } from "./config.js";
import { LlmClient, LlmError, type ChatMessage, type ChatResult, type ToolCall, type ToolSpec } from "./llm.js";
import { AnthropicClient } from "./provider-anthropic.js";
import { spawnSync } from "node:child_process";
import { AGENT_TOOLS, getTool, type ToolContext, type ToolDiff, type TodoItem } from "./tools.js";
import { detectBuildCommand, runBuild, type BuildResult } from "./build.js";
import { trimHistory, summariseOutput, claimsCompletion } from "./context.js";
import { PermissionChecker } from "./permissions.js";
import { SessionStore, type SessionFile } from "./session.js";
import { JsonlLogger } from "./logger.js";
import { McpManager } from "./mcp.js";
import { discoverSkills, findSkill, formatSkillIndex, type Skill } from "./skills.js";
import * as ui from "./ui.js";

/** Marker the model appends to a purely conversational reply (rule 9). */
const CHAT_DONE_MARKER = "<<CHAT_DONE>>";

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

const SYSTEM_PROMPT = `You are Scoder, an autonomous coding agent running in a terminal.
You complete coding tasks by using tools: reading/writing/editing files, listing
files, and running shell commands.

RULES:
1. Work autonomously. Do NOT ask the user questions mid-task; make reasonable
   decisions and proceed.
2. When you believe the task is done, call run_command with the project's build
   command (or the one the user specified). The loop ends only when the build
   succeeds.
3. If the build fails, read the error output carefully, fix the code, and build
   again. Iterate until it passes.
4. Prefer small, focused edits. Read a file before editing it.
5. If an external/environmental problem (missing dependency, wrong environment)
   makes the task impossible, stop editing and report it clearly in your final
   message.
6. Never invent requirements beyond the given task.
7. IMPORTANT: if a run_command is denied by permission policy, you will receive
   an error message. Use this as a signal to find a safer alternative or to
   communicate the limitation to the user.
8. You have web access ONLY through web_fetch (it fetches exact URLs, it cannot
   search). Use it when the task depends on external or fast-changing knowledge:
   library/API documentation, a URL found in an error message or code comment,
   current package versions, changelogs, release notes, standards. Skip it when
   the answer is in the working directory or is stable general knowledge. After
   fetching, ground your edits in what the page actually says.
9. CONVERSATIONAL INPUT: if the user's message is purely conversational — a
   greeting, thanks, a short question, or anything that needs no code changes
   and no shell commands — do NOT use any tools and do NOT run a build. Reply
   briefly in the user's language and end your reply with the exact marker
   <<CHAT_DONE>> on its own last line.
10. PLANNING: for any multi-step task, FIRST call write_todos with the full
   plan, then work through it — mark each item completed IMMEDIATELY after it
   is done (keep exactly one in_progress), and add newly discovered steps.
   Keep the list current; the user watches it live.`;

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
        ? `\n\nAVAILABLE SKILLS (project + global .scoder/skills/<name>/SKILL.md):\n${formatSkillIndex(this.skills)}\nWhen a task matches a skill, read its SKILL.md with read_file and follow it.`
        : "";
    this.messages = [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          `\n\nWorking directory: ${this.config.workdir}\nBuild command (stop condition): ${buildCmd}\n${buildEnvInfo(this.config.workdir)}` +
          skillsBlock,
      },
      ...this.pendingContext.map((content) => ({ role: "user" as const, content })),
      { role: "user", content: task },
    ];
    this.pendingContext = [];
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

      const { message, usage } = await this.chatWithStream().catch((err: unknown) => {
        // SIGINT during the LLM call — stop gracefully instead of crashing
        if (this.aborted) {
          return {
            message: { role: "assistant", content: null, tool_calls: undefined },
            usage: undefined,
          };
        }
        throw err;
      });
      if (this.aborted) break;
      this.recordLlmUsage(usage);
      this.logger.log({ type: "step", step: steps });

      // Wrap-up prefill: two steps before the budget ends, force the model to
      // stop starting new work and converge (otherwise it burns the last
      // steps exploring and the run fails without a summary).
      if (!wrapUpInjected && this.config.maxSteps - steps === 2) {
        wrapUpInjected = true;
        this.messages.push({
          role: "user",
          content:
            "<system-reminder>Step budget nearly exhausted (2 steps left). Stop starting new work: finish the current change, run the build command, and reply with a final summary. If the build cannot pass in the remaining steps, report exactly what remains in your final message.</system-reminder>",
        });
      }

      // No tool calls => assistant produced a text answer
      if (!message.tool_calls || message.tool_calls.length === 0) {
        const text = message.content ?? "";
        this.messages.push({ role: "assistant", content: text });

        // Conversational reply (rule 9 marker): answer only, no build.
        if (text.includes(CHAT_DONE_MARKER)) {
          const clean = text.split(CHAT_DONE_MARKER)[0].trim();
          this.messages[this.messages.length - 1] = { role: "assistant", content: clean };
          ui.llm("agent", clean || "(no text)");
          return this.finish(true, steps, buildCmd, clean || "Conversation turn complete.", true);
        }

        // If the assistant says it's done without building, force a build check.
        if (claimsCompletion(text) && steps < this.config.maxSteps) {
          // Nothing was written during this run — no build to verify (e.g. the
          // agent only answered a question after reading the code).
          if (!this.filesModified) {
            ui.info("no files modified — skipping build verification");
            ui.llm("agent", text);
            return this.finish(true, steps, buildCmd, text);
          }
          ui.info("agent claims completion -> verifying with build");
          lastBuild = await this.checkBuild(buildCmd);
          if (lastBuild.success) {
            return this.finish(true, steps, buildCmd, text);
          }
          this.messages.push({
            role: "user",
            content: `Build still FAILED after your claimed completion. Output:\n${summariseOutput(lastBuild.output)}\nFix and continue.`,
          });
          continue;
        }

        ui.llm("agent", text);
        // Treat a plain text answer with no build as interim commentary; nudge loop.
        // Safety valve: if the model only talks for 2 consecutive steps and
        // hasn't modified any file, end the run instead of burning the step
        // budget on an unproductive nudge loop (the "chào" failure mode).
        textOnlyStreak++;
        if (textOnlyStreak >= 2 && !this.filesModified) {
          return this.finish(true, steps, buildCmd, text);
        }
        this.messages.push({
          role: "user",
          content: "Continue working on the task. Use tools. Build must pass before you finish.",
        });
        continue;
      }

      this.messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      });
      textOnlyStreak = 0;

      // Execute each tool call (validate args before running)
      const stepToolResults = new Map<string, { ok: boolean; output: string }>();
      for (const tc of message.tool_calls) {
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

      // Doom-loop breaker: identical tool call(s) repeated 3x in a row →
      // intervene with a strategy-change reminder (models rarely recover on
      // their own; unattended runs would burn the whole step budget).
      const callSig = message.tool_calls
        .map((tc) => `${tc.name}:${tc.arguments}`)
        .sort()
        .join("|");
      sigRepeat = callSig === lastCallSig ? sigRepeat + 1 : 0;
      lastCallSig = callSig;
      if (sigRepeat >= 2) {
        this.messages.push({
          role: "user",
          content:
            "<system-reminder>You have made the identical tool call 3 times in a row. This is a loop: read the last output carefully, change your approach, or report the blocker in your final message. Do NOT repeat the same call again.</system-reminder>",
        });
      }

      // After a build-command run, treat success as the terminal condition.
      // Match the FULL build command (not just its first word): matching "npm"
      // would falsely trigger on "npm install" mid-task and end the agent.
      const buildCall = message.tool_calls.find(
        (tc) => tc.name === "run_command" && tc.arguments.includes(buildCmd),
      );
      if (buildCall) {
        // Reuse the tool result when the agent ran the exact build command —
        // avoids executing the build a second time just to verify.
        const result = stepToolResults.get(buildCall.id);
        if (result && result.ok) {
          return this.finish(true, steps, buildCmd, message.content ?? "Build passed.");
        }
        lastBuild = await this.checkBuild(buildCmd);
        if (lastBuild.success) {
          return this.finish(true, steps, buildCmd, message.content ?? "Build passed.");
        }
        this.messages.push({
          role: "user",
          content: `Build FAILED (stop condition not met). Error output:\n${summariseOutput(lastBuild.output)}\nAnalyze the errors, fix the code, and rebuild.`,
        });
      }

      this.messages = trimHistory(this.messages);

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
  async callMcpTool(fullName: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
    if (this.config.permissionMode === "readonly") {
      return { ok: false, output: "ERROR: readonly mode — MCP tools are disabled (they bypass the permission policy)." };
    }
    await this.connectMcp();
    const reg = this.mcp?.getTool(fullName);
    if (!reg) {
      return { ok: false, output: `ERROR: unknown MCP tool "${fullName}" — run /mcp to list servers and tools.` };
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
