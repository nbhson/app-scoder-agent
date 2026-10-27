import type { AgentConfig } from "./config.js";
import { loadPermissionLists } from "./config.js";
import { LlmClient, LlmError, type ChatMessage, type ChatResult, type ToolSpec } from "./llm.js";
import { AnthropicClient } from "./provider-anthropic.js";
import { AGENT_TOOLS, getTool, type ToolContext } from "./tools.js";
import { detectBuildCommand, runBuild, type BuildResult } from "./build.js";
import { trimHistory, summariseOutput } from "./context.js";
import { PermissionChecker } from "./permissions.js";
import { SessionStore, type SessionFile } from "./session.js";
import { JsonlLogger } from "./logger.js";
import { McpManager, mcpToolKey } from "./mcp.js";
import * as ui from "./ui.js";

const SYSTEM_PROMPT = `You are Coder, an autonomous coding agent running in a terminal.
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
   communicate the limitation to the user.`;

export interface AgentRunResult {
  success: boolean;
  steps: number;
  buildCmd: string | null;
  summary: string;
}

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
  private mcp: McpManager | null = null;

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
    };
    this.session = new SessionStore(config.workdir, config.noSave !== true);
    this.logger = JsonlLogger.forSession(config.workdir, this.session.id, config.logFile);
  }

  /** Handle SIGINT: abort gracefully after current tool finishes. */
  abort(): void {
    this.aborted = true;
  }

  /**
   * One LLM turn: streaming if enabled (renders deltas live), with automatic
   * fallback to non-streaming when the provider/stream fails.
   */
  private async chatWithStream(): Promise<ChatResult> {
    if (!this.config.stream) {
      return this.client.chat(this.messages, this.tools);
    }
    try {
      let streamedText = "";
      let final: ChatResult | undefined;
      let started = false;

      for await (const chunk of this.client.streamChat(this.messages, this.tools)) {
        if (chunk.contentDelta) {
          if (!started) {
            ui.llmStreamStart("assistant");
            started = true;
          }
          ui.llmStreamChunk(chunk.contentDelta);
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
        "No API key configured. Set CODER_API_KEY or OPENAI_API_KEY (or put apiKey in .coderrc.json).",
      );
    }

    const buildCmd = this.buildCmd;
    ui.header("TASK");
    ui.info(task);
    ui.info(`model=${this.client.model}  workdir=${this.config.workdir}  build="${buildCmd}"  maxSteps=${this.config.maxSteps}`);

    this.currentTask = task;
    this.messages = [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          `\n\nWorking directory: ${this.config.workdir}\nBuild command (stop condition): ${buildCmd}`,
      },
      { role: "user", content: task },
    ];

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
    this.messages = session.messages ?? [];

    ui.header(`RESUME ${session.id}`);
    ui.info(`previous task: ${session.task} (${session.steps} step(s) done)`);

    if (followUp) {
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

    while (steps < this.config.maxSteps && !this.aborted) {
      steps++;
      ui.step(steps, this.config.maxSteps, "thinking...");

      const { message, usage } = await this.chatWithStream();
      if (usage) {
        ui.info(`tokens: in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"}`);
        this.logger.log({ type: "step", step: steps, usage });
      } else {
        this.logger.log({ type: "step", step: steps });
      }

      // No tool calls => assistant produced a text answer
      if (!message.tool_calls || message.tool_calls.length === 0) {
        const text = message.content ?? "";
        this.messages.push({ role: "assistant", content: text });

        // If the assistant says it's done without building, force a build check.
        if (/task (is )?complete|done|finished/i.test(text) && steps < this.config.maxSteps) {
          ui.info("agent claims completion -> verifying with build");
          lastBuild = this.checkBuild(buildCmd);
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

      // Execute each tool call (validate args before running)
      for (const tc of message.tool_calls) {
        if (this.aborted) break;
        const tool = getTool(tc.name);
        let args: Record<string, unknown> = {};
        try {
          args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
        } catch {
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: `ERROR: invalid JSON arguments: ${tc.arguments.slice(0, 200)}`,
          });
          continue;
        }

        ui.toolCall(tc.name, args);

        if (!tool && !(this.mcp?.hasTool(tc.name))) {
          ui.toolResult(tc.name, false, "unknown tool");
          this.logger.log({ type: "tool", step: steps, tool: tc.name, ok: false, error: "unknown tool" });
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: `ERROR: unknown tool "${tc.name}". Available: ${AGENT_TOOLS.map((t) => t.spec.function.name).join(", ")}${this.mcp ? " + MCP tools (mcp__<server>__<tool>)" : ""}`,
          });
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
              ui.toolResult(tc.name, false, result.output);
              this.logger.log({ type: "tool", step: steps, tool: tc.name, args, ok: false, denied: decision.reason });
              this.messages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: tc.name,
                content: result.output,
              });
              continue;
            }
            if (decision.decision === "ask") {
              const allowed = await this.permissions.confirm(args.command as string);
              if (!allowed) {
                result = {
                  ok: false,
                  output: `ERROR: user denied permission to run: ${String(args.command).slice(0, 200)}`,
                };
                ui.toolResult(tc.name, false, result.output);
                this.logger.log({ type: "tool", step: steps, tool: tc.name, args, ok: false, denied: "user" });
                this.messages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  name: tc.name,
                  content: result.output,
                });
                continue;
              }
            }
          }

          const t0 = Date.now();
          // Route MCP tools first (they carry the mcp__ prefix, not in AGENT_TOOLS)
          if (!tool && this.mcp?.hasTool(tc.name)) {
            const reg = this.mcp.getTool(tc.name)!;
            const r = await reg.conn.callTool(reg.toolName, args);
            result = { ok: r.ok, output: r.output.length > 20_000 ? r.output.slice(0, 20_000) + "\n... [truncated]" : r.output };
          } else {
            result = await tool!.run(this.ctx, args);
          }
          this.logger.log({ type: "tool", step: steps, tool: tc.name, args, ok: result.ok, elapsedMs: Date.now() - t0 });
        } catch (err) {
          result = { ok: false, output: `ERROR: ${(err as Error).message}` };
          this.logger.log({ type: "tool", step: steps, tool: tc.name, args, ok: false, error: (err as Error).message });
        }

        ui.toolResult(tc.name, result.ok, result.output);
        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: summariseOutput(result.output),
        });
      }

      // After a build-command run, treat success as the terminal condition.
      const ranBuild = message.tool_calls.some(
        (tc) => tc.name === "run_command" && tc.arguments.includes(buildCmd.split(" ")[0]),
      );
      if (ranBuild) {
        lastBuild = this.checkBuild(buildCmd);
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

  /** Persist current agent state to .coder/sessions/<id>.json. */
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
      },
      this.sessionCreatedAt,
    );
  }

  /** Explicitly verify the build (independent of what the LLM claims). */
  private checkBuild(buildCmd: string): BuildResult {
    const res = runBuild(this.config.workdir, buildCmd);
    ui.buildStatus(res.success, res.output);
    this.logger.log({ type: "build", success: res.success, command: buildCmd, output: res.output.slice(0, 10_000) });
    return res;
  }

  private finish(success: boolean, steps: number, buildCmd: string, summary: string): AgentRunResult {
    if (success) {
      ui.success(`Task complete in ${steps} step(s). Build passed: ${buildCmd}`);
    } else {
      ui.error(`Task NOT complete. ${summary}`);
    }
    this.logger.log({ type: "finish", success, steps });
    return { success, steps, buildCmd, summary: summary.slice(0, 2000) };
  }
}
