import type { AgentConfig } from "./config/config.js";
import { loadPermissionLists, loadPolicyRules, loadSavedApprovals } from "./config/config.js";
import { LlmClient, LlmError, redactSecrets, type ChatMessage, type ChatResult, type ToolCall, type ToolSpec } from "./llm/llm.js";
import type {ToolResult} from "./tools/types.js";
import { AnthropicClient } from "./llm/provider-anthropic.js";
import {allToolSpecs} from "./tools/registry.js";
import {setMaxOutputChars, setMaxToolOutputChars} from "./tools/path-safety.js";
import { type TaskRunner, type ToolContext, type TodoItem, type AskUserRequest } from "./tools/types.js";
import { detectBuildCommand, type BuildResult } from "./workspace/build.js";
import { expandMentions } from "./context/context.js";
import { createGuardrailEngine, type GuardrailDecision } from "./agent/guardrails.js";
import type { VerifyCommands } from "./workspace/diagnostics.js";
import { PROMPT_VERSION } from "./context/prompt.js";
import { PermissionChecker, type PermissionAnswer, type PermissionRequest } from "./security/permissions.js";
import { SessionStore, EventSessionStore, type SessionFile } from "./session/session.js";
import { DEFAULT_COMPACTION, estimateTokens, estimateSchemaTokens, findCutIndex, extractSummaryInput, COMPACTION_INSTRUCTION, applyCompaction, type CompactionConfig } from "./context/compaction.js";
import { SnapshotManager } from "./workspace/snapshot.js";
import { contextWindowFor } from "./llm/model-catalog.js";
import { probeContextWindow, type ProbedWindow } from "./llm/context-probe.js";
import { promptMetrics, type PromptMetrics } from "./llm/prompt-metrics.js";
import { JsonlLogger } from "./session/logger.js";
import { createRuntime, parseCustomProviders, resolveProvider, splitProviderModel } from "./llm/provider-registry.js";
import { loadRcFile } from "./config/config.js";
import {McpManager} from "./mcp/manager.js";
import { watchWorkdir, type ReloadWatcher } from "./workspace/watch.js";
import type { Skill } from "./context/skills.js";
import { discoverAgents, findAgent, type AgentDef } from "./context/agents.js";
import {
  emptyWorkingMemory,
  noteFileRead,
  noteFileChanged,
  noteFailure,
  notePlan,
  type WorkingMemory,
} from "./context/memory.js";

import { SteeringInbox } from "./session/steering.js";
import { randomUUID } from "node:crypto";
import { consoleReporter } from "./io/console-reporter.js";
import type { Reporter } from "./io/reporter.js";
import {
  resolveVerify as resolveVerificationCommands,
  verifyAll as runVerification,
  failureSignature as getFailureSignature,
  collectRunDiff as collectVerificationDiff,
  selfReviewGate as runSelfReviewGate,
  type VerificationRuntime,
  type SelfReviewRuntime,
} from "./agent/verification.js";
import {
  callMcpTool as callMcpToolBridge,
  confirmMcpTool as confirmMcpToolBridge,
  connectMcp as connectMcpBridge,
  governedMcpSpecs,
  invokeMcpTool as invokeMcpToolBridge,
  mcpStatus as mcpStatusBridge,
  rebuildToolList as rebuildMcpToolList,
  shutdownMcp as shutdownMcpBridge,
  type McpBridgeRuntime,
} from "./agent/mcp-bridge.js";
import { InteractionBroker, type InteractionRuntime } from "./agent/interaction.js";
import { ToolExecutor, type ToolExecutorRuntime } from "./agent/tool-executor.js";
import { PromptContext, buildRunMessages, memoryBlock } from "./agent/prompt-context.js";
import { persistSession, restoreSessionState } from "./agent/session-persistence.js";
import { runAgentLoop, type RunLoopRuntime } from "./agent/run-loop.js";

// CHAT_DONE_MARKER import từ guardrails.js (marker chat thuần, rule 9).

import {
  EVENT_SCHEMA_VERSION,
  type AgentEvent,
  type AgentRunResult,
  type UsageTotals,
  type VerificationInfo,
  applyToolFilter,
  resolvePrimaryConfig,
} from "./agent/types.js";

export { EVENT_SCHEMA_VERSION, resolvePrimaryConfig } from "./agent/types.js";
export type { AgentEvent, AgentRunResult, ResolvedPrimary, UsageTotals, VerificationInfo } from "./agent/types.js";

export class Agent {
  /** v2 event schema: stable id for the run — links agent_start/agent_end. */
  readonly id = randomUUID();
  private client: import("./llm/provider-registry.js").ProviderRuntimeContract;
  private config: AgentConfig;
  /** v2: the def resolved at construction (primary agent) — prompt override, skills. */
  private primaryDef: AgentDef | null = null;
  private messages: ChatMessage[] = [];
  private tools: ToolSpec[] = allToolSpecs();
  private ctx: ToolContext;
  private permissions: PermissionChecker;
  /** T-03: frontend interaction broker — permission and ask_user flows. */
  private interaction = new InteractionBroker();
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
  /** P1-2 (RC-5): kết quả verify thành công gần nhất theo (lệnh, fingerprint). */
  private verifyCacheStore = new Map<string, { fingerprint: string; result: BuildResult }>();
  /** Accumulated token usage across the current run (session state). */
  private usageTotals: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  private mcp: McpManager | null = null;
  /** Aborted when abort() is called — cancels in-flight LLM requests (SIGINT). */
  /** Steering inbox — user input delivered at safe step boundaries (H-08, I5 module). */
  private steerInbox = new SteeringInbox();
  private runSignal = new AbortController();
  /** Optional structured-event sink (used by the HTTP/SSE server frontend). */
  onEvent: ((ev: AgentEvent) => void) | null = null;
  /** Set while a tool call is executing, for tool_output event correlation. */
  private currentToolCall: { step: number; id: string; name: string } | null = null;
  /** True once any file-writing tool succeeded during the current run. */
  private filesModified = false;
  /** Project/global skills and one-shot `/skill` context. */
  private promptContext: PromptContext;
  /** M4: hot-reload watcher (rc + skills dir). */
  private watcher: ReloadWatcher | null = null;
  /** Session plan (write_todos tool). */
  private plan: TodoItem[] = [];
  /** v2: working memory ledger (see src/memory.ts) — kept across compaction. */
  private memory: WorkingMemory = emptyWorkingMemory();
  /** v2: one-shot guardrail nudge for editing without a plan. */
  private planNudged = false;
  /** v2: diffs accumulated during the run (for the self-review pass). */
  private runDiffs: string[] = [];
  /** v2: self-review consumed once per run. */
  private selfReviewDone = false;
  /** v2: build no-progress tracking — same failure signature twice → escalate. */
  private lastVerifySignature = "";
  private verifyStrikes = 0;
  /** v2: ask_user plumbing (frontends register handlers; serve → not-interactive). */
  /** Guardrail Engine — khởi tạo trong constructor (cần this.config). */
  private guardrails: ReturnType<typeof createGuardrailEngine>;
  private reporter: Reporter;

  /** Log một quyết định guardrail ra JSONL + event (quan sát được, không ồn ào UI). */
  /** v2: single plan-update path — ledger + UI + event + log. */
  private setPlan(items: TodoItem[]): void {
    this.plan = items;
    notePlan(this.memory, items);
    const done = items.filter((t) => t.status === "completed").length;
    this.reporter.info(`plan: ${done}/${items.length} completed`);
    this.emit({ type: "todo", items: [...items] });
    this.logger.log({ type: "todo", items });
  }

  /** Frontend-facing: current plan snapshot. */
  getPlan(): TodoItem[] {
    return [...this.plan];
  }

  /** Frontend-facing: mark a plan step by id/index/text. */
  markPlanStep(status: "completed" | "in_progress", ref: string): { ok: boolean; message: string } {
    if (this.plan.length === 0) {
      return { ok: false, message: "no plan yet — the agent has not called write_todos" };
    }
    const r = ref.trim();
    let idx = /^\d+$/.test(r) ? Number(r) - 1 : this.plan.findIndex((t) => t.id === r);
    if (idx < 0) {
      const sub = r.toLowerCase();
      idx = this.plan.findIndex((t) => t.content.toLowerCase().includes(sub));
    }
    if (idx < 0 || idx >= this.plan.length) {
      return { ok: false, message: `step not found: "${ref}" — ids: ${this.plan.map((t) => t.id).join(", ")}` };
    }
    const next = this.plan.map((t, i) => {
      if (i === idx) return { ...t, status };
      if (status === "in_progress" && t.status === "in_progress") return { ...t, status: "pending" as const };
      return t;
    });
    this.setPlan(next);
    return { ok: true, message: `step ${idx + 1} (${next[idx].id}) → ${status}: ${next[idx].content}` };
  }

  /**
   * Compaction helper (v2): fold the working-memory ledger into the summary
   * instruction and into the kept summary text, then snapshot it to the log.
   */
  private memoryBlock(taskNote?: string): { instruction: string; suffix: string } {
    return memoryBlock(this.memory, taskNote);
  }

  /** Log the ledger into the event log (observability; resume rebuilds it). */
  private snapshotMemory(trigger: string): void {
    try {
      this.events.append({ type: "memory.snapshot", trigger, memory: { ...this.memory } });
    } catch {
      // observability must never break the run
    }
  }

  // ── v2: ask_user (frontend-wired question flow) ───────────────────────────

  /** Frontends register a question handler (TUI modal / REPL readline). */
  setQuestionHandler(fn: ((req: AskUserRequest & { id: string }) => Promise<string | null>) | null): void {
    this.interaction.setQuestionHandler(fn);
  }

  private async programmaticAsk(req: AskUserRequest): Promise<{ ok: boolean; output: string }> {
    return this.interaction.ask(this.interactionRuntime(), req);
  }

  private interactionRuntime(): InteractionRuntime {
    return {
      logger: this.logger,
      emit: (event) => this.emit(event),
      hasEventSink: () => this.onEvent !== null,
    };
  }

  // ── v2: verification pipeline (build → test → typecheck → lint) ───────────

  /** Resolved verify commands: rc overrides → manifest detection → buildCmd. */
  private resolveVerify(buildCmd: string): VerifyCommands {
    return resolveVerificationCommands(this.config, buildCmd);
  }

  /** Run the full gate: build → test → typecheck → lint, fail fast, one build event per cmd. */
  private async verifyAll(buildCmd: string): Promise<BuildResult> {
    const runtime: VerificationRuntime = {
      config: this.config,
      reporter: this.reporter,
      logger: this.logger,
      events: this.events,
      emit: (event) => this.emit(event),
      onToolOutput: (stream, delta) => this.handleToolOutput("build", stream, delta),
      endToolStream: () => this.endToolStream(),
      setLastBuildResult: (result) => { this.lastBuildResult = result; },
      // P1-2: verify cache sống trong run (key = chuỗi lệnh verify).
      verifyCache: {
        read: (key) => this.verifyCacheStore.get(key),
        write: (key, entry) => {
          this.verifyCacheStore.set(key, entry);
        },
      },
    };
    return runVerification(runtime, buildCmd);
  }

  /** Signature of a verification failure — stable across cosmetic differences. */
  private failureSignature(output: string): string {
    return getFailureSignature(output);
  }

  /** Collect the run's diff texts (capped) for the self-review pass. */
  private collectRunDiff(): string {
    return collectVerificationDiff(this.runDiffs);
  }

  /**
   * v2: self-review pass — ask the model to review the accumulated diff for
   * blocking issues before we call the run done. [blocking] lines or LGTM;
   * infrastructure problems never block completion.
   */
  private async selfReviewGate(): Promise<string | null> {
    const runtime: SelfReviewRuntime = {
      config: this.config,
      currentTask: () => this.currentTask,
      runDiffs: () => this.runDiffs,
      filesModified: () => this.filesModified,
      selfReviewDone: () => this.selfReviewDone,
      setSelfReviewDone: (value) => { this.selfReviewDone = value; },
      client: this.client,
      signal: this.runSignal.signal,
      recordLlmUsage: (usage) => this.recordLlmUsage(usage),
      logger: this.logger,
    };
    return runSelfReviewGate(runtime);
  }

  private logGuardrailDecision(d: GuardrailDecision): void {
    const kind = d.action.kind;
    this.logger.log({ type: "guardrail", rule: d.rule, action: kind, reason: d.reason });
    this.emit({ type: "guardrail", rule: d.rule, action: kind, reason: d.reason });
  }

  constructor(config: AgentConfig) {
    // v2 (3.1): resolve the primary agent FIRST — model routing, tool filter,
    // permission mode and prompt override all derive from it. The local
    // `config` alias below keeps the rest of the body readable.
    const reporter = config.reporter ?? consoleReporter;
    const resolved = resolvePrimaryConfig(config, reporter);
    this.config = resolved.config;
    this.primaryDef = resolved.def;
    config = this.config;
    this.reporter = reporter;
    this.tools = applyToolFilter(allToolSpecs(), resolved.def, reporter);
    this.guardrails = createGuardrailEngine(config.guardrails ?? {}, (d) => this.logGuardrailDecision(d));
    const commonOpts = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      requestTimeoutMs: config.limits?.requestTimeoutMs, // G7
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
    // T-03: route permission prompts through the event stream when an event
    // sink is attached (TUI/serve) — readline on stdin corrupts alt-screen.
    this.permissions.promptHandler = (req) => this.programmaticPermissionPrompt(req);
    this.ctx = {
      workdir: config.workdir,
      permissions: this.permissions,
      permissionMode: config.permissionMode,
      onToolOutput: this.handleToolOutput,
      plan: {
        get: () => this.plan,
        set: (items) => this.setPlan(items),
      },
      formatter: config.formatter,
      sandbox: config.sandbox,
      allowSubagents: config.allowSubagents,
      askUser: (req) => this.programmaticAsk(req),
      reporter: this.reporter,
    };
    // G7: thresholds từ rc limits.
    if (config.limits?.maxOutputChars) setMaxOutputChars(config.limits.maxOutputChars);
    // P0-2: ngân sách ký tự của một tool result trong history (read_file cắt
    // theo dòng theo giá trị này).
    if (config.limits?.toolOutputChars) setMaxToolOutputChars(config.limits.toolOutputChars);
    this.session = new SessionStore(config.workdir, config.noSave !== true);
    this.events = new EventSessionStore(config.workdir, config.noSave !== true, this.session.id);
    this.snapshots = new SnapshotManager(config.workdir, config.snapshots !== false);
    // I-06: task tool → child Agent run (same process, own session, event
    // relay, abort cascade via parent's runSignal). Depth-1 only: the runner
    // refuses when the calling agent was constructed with allowSubagents:false
    // (children set this; the runner checks ctx, not a global flag — global
    // registration alone allowed grandchildren through). Runner lives on the
    // per-instance ctx — concurrent Agents (server multi-run) stay isolated.
    if (config.allowSubagents !== false) {
      const availableNames = () => discoverAgents(config.workdir)
        .filter((a) => a.mode !== "subagent" || a.name === "explore")
        .map((a) => a.name)
        .join(", ");

      /** Run one subtask in its own child Agent. */
      const runOne = async (args: { description?: string; prompt?: string; agent?: string }): Promise<ToolResult> => {
        const def = args.agent ? findAgent(config.workdir, args.agent) : findAgent(config.workdir, "explore");
        if (args.agent && !def) {
          return { ok: false, output: `ERROR: agent "${args.agent}" not found — available: ${availableNames()}` };
        }
        const child = new Agent({
          ...config,
          allowSubagents: false,
          // v2: the child resolves this def itself (tools filter, permission,
          // model via routing + def.model, prompt) — no manual overrides here.
          agent: def?.name ?? "build",
          maxSteps: def?.steps ?? Math.min(config.maxSteps, 20),
          noSave: true, // subagent runs are ephemeral — no session pollution
        });
        // Abort cascade: parent abort kills child's in-flight LLM calls.
        this.runSignal.signal.addEventListener("abort", () => child.abort(), { once: true });
        const childId = child.id;
        const description = typeof args.description === "string" && args.description.trim()
          ? args.description.trim()
          : `subagent ${def?.name ?? "task"}`;
        this.emit({
          type: "agent_start",
          id: childId,
          parentId: this.id,
          name: def?.name ?? "task",
          description,
          model: def?.model ?? this.config.model,
        });
        // Event relay: child activity appears as subagent-tagged tool output.
        const tag = `subagent:${def?.name ?? "task"}`;
        child.onEvent = (ev) => {
          if (ev.type === "tool_call") this.emit({ type: "tool_output", name: tag, stream: "stdout", delta: `→ ${ev.name}\n` });
          else if (ev.type === "llm_delta") this.emit({ type: "tool_output", name: tag, stream: "stdout", delta: ev.delta });
        };
        try {
          const res = await child.run(args.prompt ?? "");
          this.emit({ type: "agent_end", id: childId, ok: res.success, steps: res.steps, summary: res.summary.slice(0, 500) });
          return {
            ok: res.success,
            output: res.success
              ? `[subagent ${def?.name ?? "task"} done — ${res.steps} steps]\n${res.summary}`
              : `[subagent ${def?.name ?? "task"} FAILED — ${res.steps} steps]\n${res.summary}`,
          };
        } catch (err) {
          const msg = (err as Error).message;
          this.emit({ type: "agent_end", id: childId, ok: false, steps: 0, summary: msg.slice(0, 500) });
          return { ok: false, output: `ERROR: subagent failed: ${msg}` };
        } finally {
          // Child agents are ephemeral: close their MCP connections (if any).
          child.dispose();
        }
      };

      const runner: TaskRunner = async (ctx, args) => {
        if (ctx.allowSubagents === false) {
          return { ok: false, output: "ERROR: task tool not available — subagents cannot spawn further subagents (depth limit)." };
        }
        // Batch mode: bounded concurrency (max 4 in flight), stable result order.
        if (Array.isArray(args.tasks) && args.tasks.length > 0) {
          const tasks = args.tasks;
          const results: ToolResult[] = new Array(tasks.length);
          const concurrency = Math.min(4, tasks.length);
          let cursor = 0;
          const worker = async () => {
            for (;;) {
              const i = cursor++;
              if (i >= tasks.length) return;
              results[i] = await runOne(tasks[i]);
            }
          };
          await Promise.all(Array.from({ length: concurrency }, () => worker()));
          const okCount = results.filter((r) => r.ok).length;
          const body = results
            .map((r, i) => `## Task ${i + 1}: ${tasks[i].description}\n${r.output}`)
            .join("\n\n");
          return {
            ok: okCount === tasks.length,
            output: `[batch ${tasks.length} task${tasks.length === 1 ? "" : "s"} — ${okCount}/${tasks.length} ok]\n\n${body}`,
          };
        }
        if (typeof args.prompt !== "string" || !args.prompt.trim()) {
          return { ok: false, output: "ERROR: task requires a non-empty `prompt`." };
        }
        return runOne(args);
      };
      this.ctx.taskRunner = runner;
    }
    this.logger = JsonlLogger.forSession(config.workdir, this.session.id, config.logFile);
    this.promptContext = new PromptContext(config.workdir);
    // v2: a def may declare skills to pre-stage for every task of this agent.
    for (const s of this.primaryDef?.skills ?? []) {
      const r = this.stageSkill(s);
      this.logger.log({ type: "stage_skill", name: s, ok: r.ok });
    }
    // M4: hot-reload — .scoderrc (MCP servers) + .scoder/skills/ đổi giữa
    // session → reload ở turn sau (debounced, không watcher trong test).
    if (config.noSave !== true && process.env.SCODER_NO_WATCH !== "1") {
      this.watcher = watchWorkdir(config.workdir, (kind) => {
        if (kind === "skills") {
          this.promptContext.reloadSkills();
          this.logger.log({ type: "hot_reload", kind, skills: this.promptContext.skillCount() });
        } else if (kind === "config") {
          // MCP servers mới: merge vào manager hiện tại (turn sau advertise).
          const rc = loadRcFile(config.workdir);
          const servers = rc.mcpServers ?? {};
          this.config.mcpServers = servers;
          if (this.mcp) {
            void this.mcp.applyConfig(servers);
          }
        }
      });
    }
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
    this.steerInbox.steer(text);
    const t = text.trim();
    if (!t) return;
    this.events.append({ type: "steer.enqueued", mode: "steer", text: t });
    this.emit({ type: "steer_queued", mode: "steer", text: t });
    this.emit({ type: "queue", ...this.steerInbox.counts() });
  }

  /** Queue: same inbox, but only relevant when the agent is idle (queued run). */
  queue(text: string): void {
    this.steerInbox.queue(text);
    const t = text.trim();
    if (!t) return;
    this.events.append({ type: "steer.enqueued", mode: "queue", text: t });
    this.emit({ type: "steer_queued", mode: "queue", text: t });
    this.emit({ type: "queue", ...this.steerInbox.counts() });
  }

  /** Drain the steering inbox; delivered at the top of the next step. */
  private drainSteerInbox(): string[] {
    return this.steerInbox.drain().map((x) => x.text);
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
   * T-03: permission ask via the event stream. Emits permission_request and
   * waits for resolvePermission(); when no sink is attached, falls back to
   * deny (the TUI always attaches one; programmatic callers answer directly).
   * Timeout ⇒ deny + auto-resolve (no leaked promise).
   */
  private programmaticPermissionPrompt(req: PermissionRequest): Promise<PermissionAnswer> {
    return this.interaction.permissionPrompt(this.interactionRuntime(), req);
  }

  /**
   * T-03: answer a pending permission_request (called from the TUI modal /
   * HTTP API). Unknown id → silently ignored (already timed out).
   */
  resolvePermission(id: string, answer: PermissionAnswer): void {
    this.interaction.resolvePermission(id, answer);
  }

  /** Aborted when abort() is called — cancels in-flight LLM requests (SIGINT). */

  /**
   * Live tool-output handler: renders chunks in the terminal (dimmed block) and
   * forwards them as `tool_output` events. Opens the stream block lazily on the
   * first chunk; `endToolStream()` closes it after the tool completes.
   */
  private handleToolOutput = (name: string, stream: "stdout" | "stderr", delta: string): void => {
    if (!this.reporter.isToolStreamOpen()) {
      this.reporter.toolStreamStart();
    }
    this.reporter.toolStreamChunk(delta);
    this.emit({ type: "tool_output", name, stream, delta });
  };

  /** Close the live tool-output block (if open) before printing the next UI element. */
  private endToolStream(): void {
    if (this.reporter.isToolStreamOpen()) this.reporter.toolStreamEnd();
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
    // v2: working memory — file usage + failures (cheap, best-effort).
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
      if (tc.name === "read_file" && typeof args.path === "string") noteFileRead(this.memory, args.path);
      else if ((tc.name === "write_file" || tc.name === "edit_file" || tc.name === "apply_patch") && typeof args.path === "string") {
        noteFileChanged(this.memory, args.path);
      }
      if (/\b(error|fail(ed|ure)|fatal)\b/i.test(content.slice(0, 120))) {
        const first = content.split("\n").find((l) => l.trim().length > 0) ?? content;
        noteFailure(this.memory, `${tc.name}: ${first.trim().slice(0, 160)}`);
      }
    } catch {
      // memory must never break a run
    }
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
    this.reporter.toolResult(tc.name, false, output);
    this.emit({ type: "tool_result", step, id: tc.id, name: tc.name, ok: false, output });
    this.logger.log({ type: "tool", step, tool: tc.name, ok: false, ...logExtra });
    this.pushToolResult(tc, output);
  }

  private toolExecutor(): ToolExecutor {
    const runtime: ToolExecutorRuntime = {
      config: this.config,
      ctx: this.ctx,
      permissions: this.permissions,
      reporter: this.reporter,
      logger: this.logger,
      getMcp: () => this.mcp,
      getTools: () => this.tools,
      invokeMcpTool: (name, args) => this.invokeMcpTool(name, args),
      confirmMcpTool: (name) => this.confirmMcpTool(name),
      emit: (event) => this.emit(event),
      pushToolResult: (tc, content) => this.pushToolResult(tc, content),
      endToolStream: () => this.endToolStream(),
      setCurrentToolCall: (call) => { this.currentToolCall = call; },
      setAborted: (value) => { this.aborted = value; },
      markFilesModified: () => { this.filesModified = true; },
      addRunDiff: (diff) => {
        this.runDiffs.push(diff);
        if (this.runDiffs.length > 40) this.runDiffs.shift();
      },
    };
    return new ToolExecutor(runtime);
  }

  /** MCP tool call with output clamp (extracted for I-09 readability). */
  private async invokeMcpTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return invokeMcpToolBridge(this.mcpBridgeRuntime(), name, args);
  }

  /**
   * Record usage of one LLM call: render token counts, log an `llm_usage`
   * event, and accumulate totals into session state.
   */
  /** Token usage totals accumulated in this session (for REPL `/cost`). */
  getUsage(): UsageTotals {
    return { ...this.usageTotals };
  }

  /** v2: emit context-window pressure (tokens/window/pct) after an LLM turn. */
  private emitContextEvent(compacted = false): void {
    try {
      const window = this.compactionSettings().contextWindow;
      // P1-1: token áp lực context phải tính cả tool schema (chi phí cố định
      // mỗi lượt) — UI/`/compact` mới hiện đúng mức "còn thở" thật.
      const tokens = estimateTokens(this.messages, estimateSchemaTokens(this.tools));
      const pct = window > 0 ? Math.min(100, Math.round((tokens / window) * 100)) : 0;
      this.emit({ type: "context", tokens, window, pct, ...(compacted ? { compacted: true } : {}) });
    } catch {
      // best-effort metric — never break the loop on it
    }
  }

  private recordLlmUsage(usage: ChatResult["usage"]): void {    if (!usage) return;
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const cached = usage.cached_tokens ?? 0;
    // P1-3: metrics của lượt vừa rồi (consumed one-shot — lượt summarizer
    // của compaction đi đường khác nên không có perf).
    const perf = this.lastPerf;
    this.lastPerf = null;
    this.usageTotals.calls += 1;
    this.usageTotals.inputTokens += input;
    this.usageTotals.outputTokens += output;
    this.usageTotals.cachedTokens += cached;
    this.reporter.info(`tokens: in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"}`);
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
      ...(perf
        ? {
            perf: {
              ttftMs: perf.ttftMs,
              callMs: perf.callMs,
              /** token/s vùng prefill — TTFT ≈ prefill trên máy local. */
              prefillTokPerSec: perf.ttftMs > 0 && input > 0 ? Math.round((input / perf.ttftMs) * 1000) : undefined,
              ...(perf.prompt
                ? {
                    promptChars: perf.prompt.promptChars,
                    promptMessages: perf.prompt.messages,
                    promptTools: perf.prompt.tools,
                    promptHash: perf.prompt.promptHash,
                    historyHash: perf.prompt.historyHash,
                    /** RC-1: history lượt trước có còn là tiền tố của lượt này? */
                    prefixReused: perf.prompt.prefixReused,
                    commonPrefixMessages: perf.prompt.commonPrefixMessages,
                  }
                : {}),
            },
          }
        : {}),
    });
  }

  /** prefixHash của lượt trước — phát hiện invalidation KV-cache (P1-3). */
  private lastPromptRef: { messageHashes: string[] } | null = null;

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
  /**
   * P1-3: một lượt gọi LLM được đo: thời gian tới token đầu (TTFT ≈ prefill
   * trên máy local), tổng thời gian, và hash prompt/prefix. `prefixHash` đổi
   * giữa hai lượt = có gì đó sửa history ⇒ mất KV-cache (RC-1).
   * Consumed one-shot bởi recordLlmUsage (lượt summarizer không có perf).
   */
  private pendingPerf: { t0: number; ttftMs: number; prompt: PromptMetrics | null } | null = null;
  private lastPerf: { ttftMs: number; callMs: number; prompt: PromptMetrics | null } | null = null;

  /** One LLM turn (wrapper) — see chatWithStreamInner for the streaming logic. */
  private async chatWithStream(): Promise<ChatResult & { incomplete?: boolean }> {
    const t0 = Date.now();
    let prompt: PromptMetrics | null = null;
    try {
      prompt = promptMetrics(this.messages, this.tools);
    } catch {
      // metrics không được phép làm hỏng lượt gọi
    }
    this.pendingPerf = { t0, ttftMs: 0, prompt };
    // Keep the per-message hashes for the NEXT call: `prefixReused` in the log
    // is the direct answer to "KV-cache còn dùng được không?" (RC-1).
    this.lastPromptRef = prompt ? { messageHashes: prompt.messageHashes } : null;
    try {
      return await this.chatWithStreamInner();
    } finally {
      const p = this.pendingPerf;
      this.pendingPerf = null;
      if (p) this.lastPerf = { ttftMs: p.ttftMs, callMs: Date.now() - t0, prompt: p.prompt };
    }
  }

  /** Đánh dấu token đầu tiên tới (best-effort, cho TTFT). */
  private markFirstToken(): void {
    const p = this.pendingPerf;
    if (p && p.ttftMs === 0) p.ttftMs = Date.now() - p.t0;
  }

  private async chatWithStreamInner(): Promise<ChatResult & { incomplete?: boolean }> {
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
        // P1-3: TTFT tính từ lúc request bắt đầu tới delta đầu tiên (bất kể
        // loại — content/reasoning/tool_call đều nghĩa là prefill đã xong).
        if (chunk.contentDelta || chunk.reasoningDelta || chunk.toolCallDelta) this.markFirstToken();
        if (chunk.reasoningDelta) {
          // I-05: reasoning hiển thị dim qua UI stream; không vào llm_delta.
          this.emit({ type: "llm_reasoning", delta: chunk.reasoningDelta });
        }
        if (chunk.contentDelta) {
          if (!started) {
            this.reporter.llmStreamStart("assistant");
            started = true;
          }
          this.reporter.llmStreamChunk(chunk.contentDelta);
          this.emit({ type: "llm_delta", delta: chunk.contentDelta });
          streamedText += chunk.contentDelta;
        }
        if (chunk.toolCallDelta) sawToolCallDelta = true;
        if (chunk.final) final = chunk.final;
      }

      if (started) this.reporter.llmStreamEnd();

      if (final) {
        if ((final.message.content == null || final.message.content === "") && streamedText) {
          final.message.content = streamedText;
        }
        return final;
      }
      // No finish_reason seen — fall through to non-streaming
      return this.client.chat(this.messages, this.tools);
    } catch (caught) {
      if (started) this.reporter.llmStreamEnd();
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
        const partial = this.client.lastPartialToolCalls ?? [];
        if (partial.length > 0) {
          this.reporter.warn("stream interrupted after complete tool-call(s) — continuing with what was received");
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
        this.reporter.warn(`streaming unavailable (${(err as Error).message.slice(0, 120)}) — falling back to non-streaming`);
      }
      return this.client.chat(this.messages, this.tools);
    }
  }

  private get buildCmd(): string {
    return this.config.buildCmd ?? detectBuildCommand(this.config.workdir) ?? "echo BUILD";
  }

  private mcpBridgeRuntime(): McpBridgeRuntime {
    return {
      config: this.config,
      reporter: this.reporter,
      logger: this.logger,
      permissions: this.permissions,
      primaryDef: this.primaryDef,
      pendingAllowedTools: this.promptContext.pendingTools(),
      getMcp: () => this.mcp,
      setMcp: (manager) => { this.mcp = manager; },
      setTools: (tools) => { this.tools = tools; },
      emit: (event) => this.emit(event),
      confirmMcpTool: (name) => this.confirmMcpTool(name),
    };
  }

  /** Connect configured MCP stdio servers (if any) and merge their tools. */
  private async connectMcp(): Promise<void> {
    await connectMcpBridge(this.mcpBridgeRuntime());
  }

  /**
   * P1-1 (RC-4): hỏi server lấy context window THẬT khi user chưa đặt tường
   * minh (rc `contextWindow` / provider def). Fallback 128k của catalog khiến
   * compaction và trim kích hoạt muộn hơn server thật hàng chục nghìn token —
   * server tự cắt history, và mỗi lần nó cắt là một lần mất KV-cache.
   */
  private async applyContextProbe(): Promise<void> {
    if (this.config.contextWindow) return;
    let probe: ProbedWindow | null = null;
    try {
      probe = await probeContextWindow(this.config.baseUrl, this.client.model);
    } catch {
      // probe là best-effort — không được làm hỏng run
    }
    if (!probe) return;
    this.config.contextWindow = probe.tokens;
    this.logger.log({ type: "context_window", tokens: probe.tokens, source: probe.source, detail: probe.detail, model: this.client.model });
    const catalog = contextWindowFor(this.config.provider, this.config.model);
    if (probe.tokens !== catalog) {
      this.reporter.info(
        `context window: ${probe.tokens} token (${probe.detail}) — thay fallback ${catalog} token, compaction/trim tính theo số này`,
      );
    }
  }

  /** Rebuild built-in and connected MCP tool specs for the current skill scope. */
  private rebuildToolList(): void {
    rebuildMcpToolList(this.mcpBridgeRuntime());
  }

  /**
   * Disconnect MCP servers when the agent is disposed — connections are kept
   * alive for the whole agent/session lifetime (one "connected" line, no
   * re-spawn per message). Ephemeral owners (server runs, one-shot CLI) call
   * dispose() when their agent is done.
   */
  private shutdownMcp(): void {
    shutdownMcpBridge(this.mcpBridgeRuntime());
  }

  /** M4: đóng hot-reload watcher (khi agent bị hủy vĩnh viễn). */
  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    this.shutdownMcp();
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
    this.reporter.banner("scoder", [
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
    this.planNudged = false;
    this.memory = emptyWorkingMemory(task);
    this.runDiffs = [];
    this.selfReviewDone = false;
    this.verifyStrikes = 0;
    this.lastVerifySignature = "";
    // Skills 2.0: rebuild tool list honouring a staged skill's allowed-tools.
    const pendingAllowedTools = this.promptContext.pendingTools();
    let baseTools = applyToolFilter(allToolSpecs(), this.primaryDef, this.reporter);
    if (pendingAllowedTools && pendingAllowedTools.length > 0) {
      const allow = new Set(pendingAllowedTools.map((t) => t.toLowerCase()));
      baseTools = baseTools.filter((s) => allow.has(s.function.name.toLowerCase()));
    }
    // P0-3: MCP specs đi qua đúng một cửa (allowlist "mcpTools" + trần
    // schema). Trước đây chỗ này tự ghép raw specs → run nối tiếp trên cùng
    // Agent (MCP đã connect, connectMcp return sớm) gửi lại đủ 53 tool.
    const mcpSpecs = governedMcpSpecs(this.mcpBridgeRuntime());
    if (pendingAllowedTools?.length) {
      const allow = new Set(pendingAllowedTools.map((t) => t.toLowerCase()));
      this.tools = [...baseTools, ...mcpSpecs.filter((s) => allow.has(s.function.name.toLowerCase()))];
    } else {
      this.tools = [...baseTools, ...mcpSpecs];
    }
    this.messages = buildRunMessages({
      config: this.config,
      primaryDef: this.primaryDef,
      skills: this.promptContext.getSkills(),
      buildCmd,
      task,
      pendingContext: this.promptContext.takePendingContext(),
    });
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
      schemaVersion: EVENT_SCHEMA_VERSION,
      agent: this.config.agent ?? "build",
    });

    await this.applyContextProbe();
    await this.connectMcp();
    this.promptContext.clearPendingTools();
    return this.runLoop(0, buildCmd, null);
  }

  /**
   * One conversational turn in an ongoing session (used by the REPL):
   * appends the task to the existing message history instead of resetting it,
   * then runs the autonomous loop. First call behaves like run().
   */
  /**
   * T-07: trim the conversation back one exchange (last user message +
   * everything after) — fork/edit-resend. The caller re-sends an edited
   * task via runTurn().
   */
  trimLastTurn(): void {
    // Cut = last REAL user message (skip guardrail reminder tails injected at
    // finish); drop it and everything after. Reminder tails BEFORE the cut
    // point belong to earlier turns and stay (history intact).
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "user") continue;
      if (this.isReminderTail(String(m.content ?? ""))) continue;
      this.messages = this.messages.slice(0, i);
      return;
    }
    this.messages = [];
  }
  /** True for guardrail-injected user messages (not real user tasks). */
  private isReminderTail(content: string): boolean {
    return (
      content.includes("<system-reminder>") ||
      /^Continue working on (the task|the original task)\. Build must pass before you finish\.$/.test(content.trim())
    );
  }

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
    for (const content of this.promptContext.takePendingContext()) this.messages.push({ role: "user", content });
    this.messages.push({ role: "user", content: task });
    this.rebuildToolList();
    await this.applyContextProbe();
    await this.connectMcp();
    this.promptContext.clearPendingTools();
    return this.runLoop(0, buildCmd, null);
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
    this.promptContext.reloadSkills();
    const restored = restoreSessionState(session);
    this.messages = restored.messages;
    // v2: rebuild the working memory from history (files/decisions/failures/plan)
    // and restore the last write_todos plan so resumed runs keep their ledger.
    this.memory = restored.memory;
    this.planNudged = false;
    this.runDiffs = [];
    this.selfReviewDone = false;
    this.verifyStrikes = 0;
    this.lastVerifySignature = "";
    if (restored.plan) {
      this.plan = restored.plan;
      this.emit({ type: "todo", items: [...this.plan] });
      this.reporter.info(`restored plan: ${this.plan.length} step(s)`);
    }

    this.reporter.header(`RESUME ${session.id}`);
    this.reporter.info(`previous task: ${session.task} (${session.steps} step(s) done)`);

    if (followUp) {
      for (const content of this.promptContext.takePendingContext()) this.messages.push({ role: "user", content });
      this.messages.push({ role: "user", content: expandMentions(followUp, this.config.workdir) });
    } else {
      this.messages.push({
        role: "user",
        content: "Continue working on the original task. Build must pass before you finish.",
      });
    }

    const lastBuild = restored.lastBuild;
    // v2: opening a resumed run stamps a fresh run.started (event log continuity).
    this.events.append({ type: "run.started", task: this.currentTask });

    await this.applyContextProbe();
    await this.connectMcp();
    return this.runLoop(session.steps ?? 0, buildCmd, lastBuild);
  }

  /**
   * Resolve compaction settings from config + model catalog (H-10/I-02).
   * Also used by `/compact`: manual compaction is an explicit user action and
   * stays available even when auto-compaction is disabled.
   */
  private compactionSettings(): CompactionConfig {
    const catalogWindow = contextWindowFor(this.config.provider, this.config.model);
    const overrides = this.config.compaction;
    return {
      ...DEFAULT_COMPACTION,
      contextWindow: this.config.contextWindow ?? catalogWindow,
      ...(overrides && typeof overrides === "object" ? overrides : {}),
    };
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
    return runAgentLoop(this.runLoopRuntime(), startSteps, buildCmd, initialBuild);
  }

  private runLoopRuntime(): RunLoopRuntime {
    // Getters keep the runtime view live while the loop mutates Agent state.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const agent = this;
    return {
      config: this.config,
      client: this.client,
      get messages() { return agent.messages; },
      set messages(value) { agent.messages = value; },
      get aborted() { return agent.aborted; },
      get currentTask() { return agent.currentTask; },
      get filesModified() { return agent.filesModified; },
      get plan() { return agent.plan; },
      get planNudged() { return agent.planNudged; },
      set planNudged(value) { agent.planNudged = value; },
      get memory() { return agent.memory; },
      get usageTotals() { return agent.usageTotals; },
      get verifyStrikes() { return agent.verifyStrikes; },
      set verifyStrikes(value) { agent.verifyStrikes = value; },
      get lastVerifySignature() { return agent.lastVerifySignature; },
      set lastVerifySignature(value) { agent.lastVerifySignature = value; },
      get selfReviewDone() { return agent.selfReviewDone; },
      get runSignal() { return agent.runSignal; },
      guardrails: this.guardrails,
      permissions: this.permissions,
      snapshots: this.snapshots,
      events: this.events,
      logger: this.logger,
      reporter: this.reporter,
      drainSteerInbox: () => this.drainSteerInbox(),
      steerCounts: () => this.steerInbox.counts(),
      chatWithStream: () => this.chatWithStream(),
      recordLlmUsage: (usage) => this.recordLlmUsage(usage),
      tools: () => this.tools,
      emit: (event) => this.emit(event),
      emitContextEvent: (force) => this.emitContextEvent(force),
      toolExecutor: () => this.toolExecutor(),
      verifyAll: (command) => this.verifyAll(command),
      selfReviewGate: () => this.selfReviewGate(),
      failureSignature: (output) => this.failureSignature(output),
      compactionSettings: () => this.compactionSettings(),
      memoryBlock: () => this.memoryBlock(),
      snapshotMemory: (trigger) => this.snapshotMemory(trigger),
      saveSession: (steps, command, lastBuild) => this.saveSession(steps, command, lastBuild),
      finish: (success, steps, command, summary, chatOnly) => this.finish(success, steps, command, summary, chatOnly),
    };
  }


  /** Persist current agent state (v2 event log + manifest; crash-resumable). */
  private saveSession(steps: number, buildCmd: string, lastBuild: BuildResult | null): void {
    this.lastBuildResult = lastBuild;
    persistSession({
      config: this.config,
      events: this.events,
      session: this.session,
      currentTask: this.currentTask,
      client: this.client,
      messages: this.messages,
      usageTotals: this.usageTotals,
      sessionCreatedAt: this.sessionCreatedAt,
    }, steps, buildCmd, lastBuild);
  }

  // ── Frontend-facing APIs (REPL/TUI slash commands) ─────────────────────────

  /**
   * Manual compaction (`/compact`): summarize older history now, keeping the
   * system prompt + the most recent turns. Explicit user action — available
   * even when auto-compaction is disabled via `"compaction": false`.
   */
  async compactHistory(): Promise<{ ok: boolean; message: string }> {
    if (this.messages.length === 0) {
      return { ok: false, message: "nothing to compact — no conversation yet" };
    }
    const cfg = this.compactionSettings();
    const firstContent = this.messages[0]?.role === "system" ? 1 : 0;
    if (findCutIndex(this.messages, cfg) <= firstContent) {
      return { ok: false, message: "nothing to compact — conversation is already short" };
    }
    const tokensBefore = estimateTokens(this.messages);
    const messagesBefore = this.messages.length;
    const summaryInput = extractSummaryInput(this.currentTask, this.messages);
    const mem = this.memoryBlock();
    this.reporter.info("compaction: summarizing older history…");
    try {
      // A previous run interrupted with Esc leaves the shared signal aborted.
      if (this.runSignal.signal.aborted) this.resetRunSignal();
      const summaryRes = await this.client.chat(
        [
          ...this.messages,
          { role: "user", content: `${summaryInput}\n\n${COMPACTION_INSTRUCTION}${mem.instruction}` },
        ],
        [], // no tools for the summarizer call
        { signal: this.runSignal.signal },
      );
      this.recordLlmUsage(summaryRes.usage);
      const summary = redactSecrets(summaryRes.message.content ?? "History summarized.") + mem.suffix;
      this.messages = applyCompaction(this.messages, summary, cfg);
      const tokensAfter = estimateTokens(this.messages);
      this.events.append({
        type: "compaction.ran",
        tokensBefore,
        tokensAfter,
        manual: true,
        summary: summary.slice(0, 2000),
      });
      this.reporter.info(`compaction: done (${tokensBefore} → ${tokensAfter} tokens)`);
      this.emit({ type: "compaction", tokensBefore, tokensAfter, manual: true });
      this.emitContextEvent(true);
      this.snapshotMemory("compaction-manual");
      return {
        ok: true,
        message: `compaction done: ${messagesBefore} → ${this.messages.length} messages · ~${tokensBefore} → ~${tokensAfter} tokens`,
      };
    } catch (err) {
      const msg = (err as Error).message.slice(0, 200);
      this.reporter.warn(`compaction failed (${msg})`);
      return { ok: false, message: `compaction failed: ${msg}` };
    }
  }

  /** Skills visible to this project (for /skill). */
  getSkills(): Skill[] {
    return this.promptContext.getSkills();
  }
  /** Skills 2.0: hot-reload skills. */
  reloadSkills(): void {
    this.promptContext.reloadSkills();
  }

  /**
   * Stage a skill's content for injection before the next run/turn (/skill).
   * Non-destructive: nothing is sent to the LLM until the user submits a task.
   */
  stageSkill(name: string): { ok: boolean; message: string } {
    return this.promptContext.stageSkill(name);
  }

  /** MCP server overview (for /mcp): config always; tools once connected. */
  async mcpStatus(): Promise<Array<{ name: string; command: string; connected: boolean; tools: Array<{ name: string; description?: string }>; serverInfo: { name?: string; version?: string }; capabilities: Record<string, unknown>; resourceCount: number; promptCount: number }>> {
    return mcpStatusBridge(this.mcpBridgeRuntime());
  }

  /** Call one MCP tool directly by its full name (mcp__server__tool) (/mcp exec). */
  async callMcpTool(fullName: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string; structured?: Record<string, unknown> }> {
    return callMcpToolBridge(this.mcpBridgeRuntime(), fullName, args);
  }

  /** Ask user to approve an MCP tool call; "always" persists a project-scoped rule. */
  async confirmMcpTool(fullName: string): Promise<boolean> {
    return confirmMcpToolBridge(this.mcpBridgeRuntime(), fullName);
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
    this.reporter.info(`permission mode → ${mode}`);
  }

  /**
   * T-04: runtime model hot-swap. Same provider → setModel on the live
   * client (zero rebuild, mid-session). Different provider (provider/model
   * syntax) → rebuild the runtime from the registry. Returns a notice line.
   */
  setModel(model: string): string {
    const [prov, id] = splitProviderModel(model);
    if (!prov || prov === this.config.provider) {
      const m = id ?? model;
      this.client.setModel(m);
      this.config = { ...this.config, model: m };
      return `model → ${m} (${this.config.provider})`;
    }
    // Cross-provider: rebuild the client runtime.
    const resolved = resolveProvider(prov, parseCustomProviders(loadRcFile(this.config.workdir).providers));
    if ("error" in resolved) return `ERROR: ${resolved.error}`;
    this.client = createRuntime(resolved.def, {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: id,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      enableCache: resolved.def.supportCache,
    });
    this.config = { ...this.config, provider: prov as "openai" | "anthropic", model: id, providerDef: resolved.def };
    return `model → ${id} (provider ${prov})`;
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
        this.reporter.success(`Done in ${steps} step(s).`);
      } else {
        this.reporter.success(`Task complete in ${steps} step(s). Build passed: ${buildCmd}`);
      }
    } else {
      this.reporter.error(`Task NOT complete. ${summary}`);
    }
    const lb = this.lastBuildResult;
    const verification: VerificationInfo = chatOnly
      ? { ok: null, detail: "chat-only turn — nothing to verify" }
      : lb
        ? { ok: lb.success, detail: `${lb.success ? "build passed" : "build FAILED"}: ${lb.command}` }
        : { ok: null, detail: "no verification command ran" };
    this.emit({ type: "finish", success, steps, summary: summary.slice(0, 2000), usage: this.getUsage(), verification });
    this.logger.log({ type: "finish", success, steps });
    return { success, steps, buildCmd, summary: summary.slice(0, 2000) };
  }
}
