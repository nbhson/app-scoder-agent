import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import type { PermissionMode, PermissionRule, PermissionEffect } from "../security/permissions.js";
import {
  parseCustomProviders,
  parseProviderConfig,
  findModelOwners,
  resolveProvider,
  splitProviderModel,
  type ProviderDef,
} from "../llm/provider-registry.js";
import { registerConfigModels, type ModelInfo } from "../llm/model-catalog.js";
import { resolveRouterTiers } from "../router/tiers.js";
import type { RouteDecisionListener, RouterConfig, RouterJudgeConfig, RouterRule, TurnContext } from "../router/types.js";
import { applyProjectTrust, guardSavedApprovals } from "./trust.js";
import type { Reporter } from "../io/reporter.js";

export interface AgentConfig {
  /** Optional output port; omitted uses the classic console reporter. */
  reporter?: Reporter;
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /**
   * P0-5: where `apiKey` came from. A provider hot-swap (`/model
   * anthropic/…`) must not keep the key of the provider being left, unless the
   * user pinned it — `flag` (--api-key / programmatic override), or `rc`
   * (apiKey in the rc file, which is provider-agnostic). Env-derived keys are
   * re-resolved against the NEW provider's `apiKeyEnv`. P2.1: `provider-rc` =
   * the inline `provider.<id>.options.apiKey` — provider-SPECIFIC, never kept
   * across a hot-swap.
   */
  apiKeySource?: "flag" | "env" | "rc" | "provider-rc" | "none";
  model: string;
  /** Provider backend: "openai" (compatible) or "anthropic" (native Messages API) */
  provider: "openai" | "anthropic";
  /** Working directory the agent operates on */
  workdir: string;
  /** Build/compile command used as the stop condition */
  buildCmd: string | null;
  /** Max autonomous loop iterations before giving up */
  maxSteps: number;
  /** Guardrail thresholds (doom-loop, text-only streak, wrap-up timing, G6 token budget) */
  guardrails?: { textOnlyStreakLimit?: number; doomLoopRepeats?: number; wrapUpStepsBeforeEnd?: number; tokenBudget?: number };
  /**
   * v2 event schema: name of the primary agent driving this session
   * (e.g. "build" | "plan" | "review"). Logged into run_start.agent so the
   * TUI/server can show which profile is active. Defaults to "build".
   */
  agent?: string;
  /** v2: model routing per primary agent — { plan, build, review } (rc "routing"). */
  routing?: { plan?: string; build?: string; review?: string };
  /**
   * P2.2: rc `router` block (validated). The runtime is only built when
   * `enabled` — otherwise behavior is byte-identical to a router-less build.
   */
  router?: RouterConfig;
  /**
   * P2.2 §4c: startup mode. "auto" only when `"model": "auto"` resolved to
   * valid tiers; "pinned" = the human picked a model and the router idles.
   */
  routerMode?: "auto" | "pinned";
  /**
   * Internal seam (like `clientFactory`): the Agent injects its event sink so
   * the RouterRuntime can emit `route_decision` without importing agent code.
   */
  onRoute?: RouteDecisionListener;
  /**
   * Internal seam: live turn signals (step/phase/build streaks) pulled by
   * the RouterRuntime right before each routed call.
   */
  routerSensors?: () => TurnContext;
  /** v2: false disables the repo-map injection into the system prompt (default on). */
  repoMap?: boolean;
  /**
   * WARMUP (plan/WARMUP-PLAN.md): false disables the background prefix-prefill
   * request sent when an interactive session starts (default on). Only REPL/TUI
   * call it — run-once/serve skip the warm-up entirely.
   */
  warmup?: boolean;
  /** v2: prompt version — 4/5 = rollback to V4/V5 prompt; 6/undefined = V6 (default). */
  promptVersion?: number;
  /** v2: verify commands for the completion gate (rc "verifyCmds"). Empty string disables one. */
  verifyCmds?: { build?: string; test?: string; lint?: string; typecheck?: string };
  /** v2: run a self-review pass over the run's diff before finishing (default true). */
  selfReview?: boolean;
  /**
   * P1-2: cache kết quả verify theo trạng thái workspace. true (mặc định): lần
   * verify tiếp mà fingerprint các file không đổi và lần trước PASS thì dùng lại
   * kết quả, không chạy lại build/test/typecheck/lint.
   */
  verifyCache?: boolean;
  /**
   * P0-3: allowlist/filter tool MCP toàn cục (glob trên tên đầy đủ
   * `mcp__<server>__<tool>`). include rỗng = tất cả; exclude luôn thắng.
   */
  mcpTools?: { include?: string[]; exclude?: string[] };
  /** P2: tắt profile tự động cho model cục bộ (default true). */
  localProfile?: boolean;
  /** Max tokens for chat completions */
  maxTokens: number;
  temperature: number;
  /** Non-interactive: fail instead of prompting */
  yes: boolean;
  /** Git shadow snapshots (H-11): false disables checkpoint capture. */
  snapshots?: boolean;
  /** I-05: reasoning/thinking — "off" (default) | "on". */
  reasoning?: "off" | "on";
  /** I-06: false = this agent cannot spawn subagents (depth guard for children). */
  allowSubagents?: boolean;
  /** I-06: task-runner spawn marker — a subagent def used programmatically
   *  must not trigger the "used as primary anyway" warning. */
  programmaticSubagent?: boolean;
  /**
   * Internal (task runner): the spawning agent's run signal. A child checks it
   * in `resetRunSignal()` so an abort delivered BEFORE the child's loop starts
   * cannot be erased by that reset — previously the subagent then ran a full,
   * uncapped run after the user pressed Esc (see test/subagent-abort.test.mjs).
   */
  parentSignal?: AbortSignal;
  /** I-11: post-edit formatter (rc `formatter`). */
  formatter?: boolean | string;
  /** G4: sandbox profile for run_command (rc `sandbox`). */
  sandbox?: { mode?: "readonly" | "workspace-write" | "off"; wrapper?: "sandbox-exec" | "bwrap" | "docker"; strict?: boolean };
  /** G7: runtime thresholds — thay magic number rải trong code. */
  limits?: {
    /** LLM request timeout ms (default 120_000). */
    requestTimeoutMs?: number;
    /** Max chars tool output vào conversation (default 20_000). */
    maxOutputChars?: number;
    /** Parallel tool-call concurrency (default 4). */
    toolConcurrency?: number;
    /** TUI render cap — số item cuối được render (default 200). */
    renderCap?: number;
    /** P0-2: ngân sách ký tự cho MỘT tool result trong history (default 8_000). */
    toolOutputChars?: number;
    /**
     * P0-3: trần token cho TOÀN BỘ MCP tool schema gửi mỗi lượt.
     * 0 = không giới hạn (mặc định cũ). Vượt trần → giữ tool theo thứ tự khai
     * báo đến khi hết ngân sách, số còn lại bị bỏ quảng cáo (kèm cảnh báo).
     */
    mcpSchemaTokens?: number;
    /** P1-2: timeout của một lệnh verify (build/test/typecheck/lint), giây. */
    buildTimeoutSecs?: number;
  };
  /**
   * I-12: LLM client factory override (eval harness). Called once per Agent
   * construction — a factory (not an instance) so subagents get their own
   * scripted client instead of consuming the parent's transcript.
   * @internal
   */
  clientFactory?: () => import("../llm/provider-registry.js").ProviderRuntimeContract;
  /** Disable session auto-save */
  noSave?: boolean;
  /** JSONL session log: true = .scoder/logs/<session>.jsonl, string = custom path */
  logFile?: boolean | string;
  /** MCP stdio servers: name -> launch config */
  mcpServers?: Record<string, import("../mcp/types.js").McpServerConfig>;
  /** Permission mode: auto | ask | readonly */
  permissionMode: PermissionMode;
  /** Rule engine v2 (from rc permissions.rules). */
  permissionRules?: PermissionRule[];
  /** Resolved provider definition (I-01 registry — built-in or custom). */
  providerDef?: import("../llm/provider-registry.js").ProviderDef;
  /** Model context window in tokens (from catalog I-02 or provider default). */
  contextWindow?: number;
  /** Streaming LLM responses */
  stream: boolean;
  /** Compaction: false disables; object overrides trigger/keep/buffer/contextWindow (H-10). */
  compaction?: { trigger?: number; keep?: number; buffer?: number; contextWindow?: number } | false;
  /** Per-model price overrides (USD per 1M tokens) for `scoder cost` estimation */
  modelPricing?: Record<string, import("../shared/constants.js").ModelPricing>;
  /**
   * TUI palette name (mission | paper | mono | light | high-contrast |
   * solarized). Priority: --theme flag > SCODER_THEME env > rc "theme".
   */
  theme?: string;
  /**
   * P6: desktop notification when a run finishes while the terminal is not
   * focused (or after a long run). Priority: SCODER_NOTIFY env > rc "notify"
   * > default true. `undefined` also means ON (TUI checks `!== false`).
   */
  notify?: boolean;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5";

export type ProviderName = "openai" | "anthropic";

/** Per-project config file, lowest priority (env vars and CLI flags override). */
interface RcFile {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  buildCmd?: string;
  maxSteps?: number;
  stream?: boolean;
  permission?: string;
  /**
   * P2.1: SHAPE-discriminated. String = legacy active-provider selector
   * ("openai" | "anthropic" | a custom id). Object = opencode-style provider
   * block: id -> {npm, name, options:{baseURL, apiKey}, models}.
   */
  provider?: string | Record<string, unknown>;
  /** Per-model price overrides (USD per 1M tokens) for `scoder cost`. */
  modelPricing?: Record<string, { input: number; output: number }>;
  /** v2: named primary agent to use (e.g. "build" | "plan" | "review"). */
  agent?: string;
  /** v2: model routing per agent name — { "plan": "provider/model", "build": …, "review": … }. */
  routing?: { plan?: string; build?: string; review?: string };
  /** P2.2: opencode-flavoured router block (validated by `parseRouter`). */
  router?: unknown;
  /** v2: false disables repo-map injection into the system prompt (default on). */
  repoMap?: boolean;
  /** WARMUP (plan/WARMUP-PLAN.md): false = không gửi request prefill nền khi mở REPL/TUI. */
  warmup?: boolean;
  /** v2: prompt version override — 4/5 = rollback to V4/V5, 6/undefined = V6 (default). */
  promptVersion?: number;
  /** v2: verify commands for the completion gate (empty string disables one). */
  verifyCmds?: { build?: string; test?: string; lint?: string; typecheck?: string };
  /** v2: self-review pass over the run's diff before finishing (default true). */
  selfReview?: boolean;
  /** P1-2: reuse a passing verification when workspace files did not change. */
  verifyCache?: boolean;
  /** P0-3: global MCP tool allow/deny (glob on `mcp__<server>__<tool>`). */
  mcpTools?: { include?: string[]; exclude?: string[] };
  /** P2: false = không áp dụng profile mặc định cho model cục bộ. */
  localProfile?: boolean;
  /** P1-1: ghi đè context window (token) thay vì probe/fallback catalog. */
  contextWindow?: number;
  /** Custom providers (I-01): id -> {baseUrl, apiKeyEnv, kind}. */
  providers?: unknown;
  /** Max steps before wrap-up reminder injection. */
  wrapUpStepsBeforeEnd?: number;
  /** Guardrail thresholds override (rc: "guardrails": {...}). */
  guardrails?: { textOnlyStreakLimit?: number; doomLoopRepeats?: number; wrapUpStepsBeforeEnd?: number; tokenBudget?: number };
  mcpServers?: Record<string, import("../mcp/types.js").McpServerConfig>;
  permissions?: {
    mode?: string;
    allowCommands?: string[];
    denyCommands?: string[];
    /** Rule engine v2 (see NOTICE — pattern from opencode): {action, resource, effect}. */
    rules?: unknown;
  };
  /** G3: extra env vars passed through to run_command children (names only; values from process.env). */
  shellEnvAllow?: string[];
  /** G4: sandbox profile for run_command — "off" (default) | "readonly" | "workspace-write"; optional wrapper override. */
  sandbox?: { mode?: "readonly" | "workspace-write" | "off"; wrapper?: "sandbox-exec" | "bwrap" | "docker"; strict?: boolean };
  /** G7: runtime thresholds (rc "limits"). */
  limits?: AgentConfig["limits"];
  /** Auto-compaction (H-10): false = off, object = overrides. */
  compaction?: { trigger?: number; keep?: number; buffer?: number; contextWindow?: number } | false;  /** I-11: post-edit formatter — true = auto-detect, string = binary or "npm:<script>". */
  formatter?: boolean | string;
  /** Git shadow snapshots (H-11): false disables checkpoint capture. */
  snapshots?: boolean;
  /** I-05: reasoning/thinking — "off" (default) | "on". */
  reasoning?: "off" | "on";
  /** TUI palette name — mission | paper | mono | light | high-contrast | solarized. */
  theme?: string;
  /** P6: notify when a run finishes unfocused (default true; SCODER_NOTIFY env wins). */
  notify?: boolean;
}

/**
 * G7: parse + validate rc "limits" — số nguyên dương; giá trị sai bỏ qua
 * (dùng default). Defaults là nguồn sự thật duy nhất (resolveLimits).
 */
export const LIMIT_DEFAULTS = {
  requestTimeoutMs: 120_000,
  maxOutputChars: 20_000,
  toolConcurrency: 4,
  renderCap: 200,
  toolOutputChars: 8_000,
  mcpSchemaTokens: 0,
  buildTimeoutSecs: 600,
} as const;

function parseLimits(raw: unknown): AgentConfig["limits"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  const out: NonNullable<AgentConfig["limits"]> = {};
  for (const k of [
    "requestTimeoutMs",
    "maxOutputChars",
    "toolConcurrency",
    "renderCap",
    "toolOutputChars",
    "buildTimeoutSecs",
  ] as const) {
    const v = num(r[k]);
    if (v !== undefined) out[k] = v;
  }
  // mcpSchemaTokens: 0 có nghĩa "tắt" — nhận cả 0, chỉ bỏ số âm/NaN.
  const mcpCap = r.mcpSchemaTokens;
  if (typeof mcpCap === "number" && Number.isFinite(mcpCap) && mcpCap >= 0) out.mcpSchemaTokens = Math.floor(mcpCap);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** G7: limits đã resolve (defaults + rc override) — các module đọc từ đây. */
export type ResolvedLimits = { [K in keyof typeof LIMIT_DEFAULTS]: number };

export function resolveLimits(limits: AgentConfig["limits"]): ResolvedLimits {
  return { ...LIMIT_DEFAULTS, ...limits };
}

// ── P2 (plan/performance-issue.md): profile cho model chạy cục bộ ───────────

/**
 * Model chạy trên máy của user (Ollama / LM Studio / vLLM / llama.cpp server)?
 * Nhận diện theo host của baseUrl — loopback là tín hiệu đáng tin duy nhất mà
 * không cần gọi network.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0" || h.endsWith(".local");
  } catch {
    return false;
  }
}

/** Mặc định của profile local — chỉ áp dụng khi user KHÔNG set tường minh. */
export const LOCAL_PROFILE_DEFAULTS = {
  /** P2-1: local model chậm, 40 bước là nhiều giờ; bao việc hơn trong 24 bước. */
  maxSteps: 24,
  /** P2-3: prefill 20–60k token trên máy cá nhân có thể vượt 120s → timeout + retry. */
  requestTimeoutMs: 600_000,
  /**
   * FILE-READ-PERF P1: profile KHÔNG pin toolOutputChars nữa (trước là 6000) —
   * ngân sách đọc giờ suy từ context window THẬT qua adaptiveToolOutputChars,
   * apply ở cuối applyContextProbe (agent.ts). Window nhỏ vẫn ra 6000 như cũ.
   */
  /** P0-3: trần token cho MCP schema; 46 tool GitHub MCP ≈ 12k token mỗi lượt. */
  mcpSchemaTokens: 6_000,
} as const;

/**
 * FILE-READ-PERF (plan/FILE-READ-PERF-PLAN.md) N1: một lần đọc file bị cắt
 * thành 5–6 MẢNH vì budget 6000 ký tự, mà mỗi mảnh = một lượt LLM tròn
 * (đo: 8–11s/mảnh với README 28KB). Nới budget theo window đã probe:
 * 0.17 ký tự mỗi token window ≈ 4% history cho một tool result
 * (4 chars ≈ 1 token) — window 16k giữ nguyên 6000, 96k lên trần 16000.
 */
export const TOOL_OUTPUT_WINDOW_SHARE = 0.17;
export const TOOL_OUTPUT_CHARS_FLOOR = 6_000;
export const TOOL_OUTPUT_CHARS_CEIL = 16_000;

export function adaptiveToolOutputChars(windowTokens: number): number {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return TOOL_OUTPUT_CHARS_FLOOR;
  return Math.min(
    TOOL_OUTPUT_CHARS_CEIL,
    Math.max(TOOL_OUTPUT_CHARS_FLOOR, Math.round(windowTokens * TOOL_OUTPUT_WINDOW_SHARE)),
  );
}

/**
 * Áp mặc định phù hợp cho local engine. Trả về danh sách thay đổi đã áp (để
 * log/kiểm thử); rỗng khi không áp dụng (cloud, hoặc localProfile:false).
 *
 * Lý do KHÔNG tắt repoMap/snapshots trong profile:
 *  - repoMap: nằm trong system prompt → prefix ổn định, không phá KV-cache, và
 *    giảm số bước khám phá (mỗi bước mới = một lượt prefill).
 *  - snapshots: git ops cục bộ, không tốn token.
 *  - selfReview: thêm MỘT lượt LLM với prompt gần đầy → tắt thật.
 */
export function applyLocalProfile(
  cfg: AgentConfig,
  explicit: { maxSteps?: boolean } = {},
): string[] {
  if (cfg.localProfile === false) return [];
  if (!isLocalBaseUrl(cfg.baseUrl)) return [];
  const applied: string[] = [];
  const limits = { ...cfg.limits };
  if (!explicit.maxSteps && cfg.maxSteps > LOCAL_PROFILE_DEFAULTS.maxSteps) {
    cfg.maxSteps = LOCAL_PROFILE_DEFAULTS.maxSteps;
    applied.push(`maxSteps=${cfg.maxSteps}`);
  }
  if (limits.requestTimeoutMs === undefined) {
    limits.requestTimeoutMs = LOCAL_PROFILE_DEFAULTS.requestTimeoutMs;
    applied.push(`requestTimeoutMs=${LOCAL_PROFILE_DEFAULTS.requestTimeoutMs}`);
  }
  // FILE-READ-PERF P1: toolOutputChars KHÔNG pin ở đây nữa — để undefined để
  // applyAdaptiveReadBudget nhận diện "user không đặt" và suy từ window.
  if (limits.mcpSchemaTokens === undefined) {
    limits.mcpSchemaTokens = LOCAL_PROFILE_DEFAULTS.mcpSchemaTokens;
    applied.push(`mcpSchemaTokens=${LOCAL_PROFILE_DEFAULTS.mcpSchemaTokens}`);
  }
  cfg.limits = limits;
  if (cfg.selfReview === undefined) {
    cfg.selfReview = false;
    applied.push("selfReview=false");
  }
  return applied;
}

/**
 * P-perf: rc-file TEXT memo keyed by (mtimeMs, size). `loadRcFile` runs on
 * every `run_command` (buildChildEnv), setModel, provider resolution… and each
 * pass re-read both files synchronously. We cache the raw text only (parse
 * per call keeps the returned object unshared, so no caller can mutate a
 * cached RcFile). Same content ⇒ same config decisions.
 */
const rcTextMemo = new Map<string, { mtimeMs: number; size: number; text: string }>();

function readRcFileCachedText(path: string): string | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null; // missing — treated as {} by caller
  }
  const hit = rcTextMemo.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
  try {
    const text = readFileSync(path, "utf8");
    rcTextMemo.set(path, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    return null;
  }
}

function readRcFile(path: string, label: string): RcFile {
  const text = readRcFileCachedText(path);
  if (text === null) return {};
  try {
    return JSON.parse(text) as RcFile;
  } catch (err) {
    // malformed rc file -> ignore it, but tell the user why their config is not applied
    console.error(`⚠  ignoring malformed config file ${label}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Global (machine-wide) config file. Overridable via SCODER_CONFIG for tests.
 * Lowest precedence of all file sources — the project rc wins field-by-field.
 */
function globalRcPath(): string {
  return process.env.SCODER_CONFIG || join(homedir(), ".scoder", "config.json");
}

/** Merge two rc views: global first, project fields win, maps merge per key. */
function mergeRc(global: RcFile, project: RcFile): RcFile {
  const merged: RcFile = { ...global, ...project };
  if (global.mcpServers || project.mcpServers) {
    merged.mcpServers = { ...global.mcpServers, ...project.mcpServers };
  }
  if (global.routing || project.routing) {
    merged.routing = { ...global.routing, ...project.routing };
  }
  if (global.modelPricing || project.modelPricing) {
    merged.modelPricing = { ...global.modelPricing, ...project.modelPricing };
  }
  if (global.permissions || project.permissions) {
    const concat = (a: unknown, b: unknown): unknown => {
      if (!Array.isArray(a) && !Array.isArray(b)) return b ?? a; // non-arrays pass through (parseList filters)
      return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
    };
    merged.permissions = {
      mode: project.permissions?.mode ?? global.permissions?.mode,
      allowCommands: concat(global.permissions?.allowCommands, project.permissions?.allowCommands) as string[] | undefined,
      denyCommands: concat(global.permissions?.denyCommands, project.permissions?.denyCommands) as string[] | undefined,
      rules: concat(global.permissions?.rules, project.permissions?.rules) as PermissionRule[] | undefined,
    };
  }
  return merged;
}

/** T-04: exported for Agent.setModel custom-provider resolution. */
export function loadRcFile(workdir: string): RcFile {
  const global = readRcFile(globalRcPath(), globalRcPath());
  for (const name of [".scoderrc.json", ".scoderrc"]) {
    const p = resolve(workdir, name);
    if (existsSync(p)) {
      // P1-config-trust: a project rc is attacker-controlled until the
      // directory is trusted — sensitive fields (baseUrl, formatter,
      // mcpServers, permissions, …) are dropped for untrusted workdirs.
      return mergeRc(global, applyProjectTrust(readRcFile(p, name), workdir));
    }
  }
  return global;
}

function parsePermissionMode(raw: string | undefined): PermissionMode {
  if (raw === "auto" || raw === "ask" || raw === "readonly") return raw;
  return "auto";
}

function parseList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/** Validate the user-supplied pricing table; drop malformed entries with a warning. */
function parsePricing(raw: unknown): Record<string, { input: number; output: number }> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    console.error("⚠  ignoring invalid modelPricing in config (expected an object)");
    return undefined;
  }
  const out: Record<string, { input: number; output: number }> = {};
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    const p = (raw as Record<string, { input?: unknown; output?: unknown }>)[key];
    if (
      typeof p === "object" && p !== null &&
      typeof p.input === "number" && Number.isFinite(p.input) &&
      typeof p.output === "number" && Number.isFinite(p.output)
    ) {
      out[key] = { input: p.input, output: p.output };
    } else {
      console.error(`⚠  ignoring invalid modelPricing entry "${key}" (expected { input: number, output: number })`);
    }
  }
  return out;
}

/** rc `provider.<id>.models.<id>.cost` overrides (P2.1) < explicit rc `modelPricing`. */
function mergePricing(
  fromProvider: Record<string, { input: number; output: number }>,
  fromRc: Record<string, { input: number; output: number }> | undefined,
): Record<string, { input: number; output: number }> | undefined {
  if (Object.keys(fromProvider).length === 0) return fromRc;
  return { ...fromProvider, ...(fromRc ?? {}) };
}

const VALID_EFFECTS = new Set(["allow", "deny", "ask"]);

/** Validate permission rules v2; drop malformed entries with a warning. */
export function parsePermissionRules(raw: unknown, label = "permissions.rules"): import("../security/permissions.js").PermissionRule[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.error(`⚠  ignoring invalid ${label} (expected an array of {action, resource, effect})`);
    return undefined;
  }
  const out: PermissionRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as { action?: unknown; resource?: unknown; effect?: unknown };
    if (
      typeof r.action === "string" && r.action.trim() &&
      typeof r.resource === "string" && r.resource &&
      typeof r.effect === "string" && VALID_EFFECTS.has(r.effect)
    ) {
      out.push({ action: r.action.trim(), resource: r.resource, effect: r.effect as PermissionEffect });
    } else {
      console.error(`⚠  ignoring invalid ${label}[${i}] (expected {action, resource, effect: allow|deny|ask})`);
    }
  }
  return out;
}

/**
 * P2.1: the custom provider map for a workdir — `builtin < rc.providers
 * (legacy format) < rc.provider (opencode block)`. The ONE source used by
 * startup, `scoder -m`, `/model` hot-swap, agent routing and the P2.2 router
 * so no path can drift from another.
 */
export function loadMergedProviders(workdir: string): Record<string, ProviderDef> {
  const rc = loadRcFile(workdir);
  return { ...parseCustomProviders(rc.providers), ...parseProviderConfig(rc.provider) };
}

// ── P2.2 (plan/P2-02 §5): rc `router` — validate like parseLimits ──────────

const asObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** `signals` / `escalate`: whitelisted non-negative ints; junk values dropped. */
function parseRouterNumbers(
  raw: unknown,
  keys: readonly string[],
  label: string,
): Record<string, number> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.error(`⚠  router.${label} must be an object — ignored`);
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseRouterTiers(raw: unknown): { small?: string[]; large?: string[] } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.error("⚠  router.tiers must be an object of arrays — ignored");
    return undefined;
  }
  const t: { small?: string[]; large?: string[] } = {};
  for (const k of ["small", "large"] as const) {
    const arr = (raw as Record<string, unknown>)[k];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      console.error(`⚠  router.tiers.${k} must be an array of "provider/model" — ignored`);
      continue;
    }
    const kept = arr.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (kept.length !== arr.length) console.error(`⚠  router.tiers.${k}: non-string entries dropped`);
    if (kept.length > 0) t[k] = kept.map((x) => x.trim());
  }
  return Object.keys(t).length > 0 ? t : undefined;
}

function parseRouterRules(raw: unknown): RouterRule[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.error("⚠  router.rules must be an array — ignored");
    return undefined;
  }
  const out: RouterRule[] = [];
  for (const item of raw) {
    const o = asObj(item);
    if (typeof o.when === "string" && o.when.trim() && (o.use === "small" || o.use === "large")) {
      out.push({ when: o.when.trim(), use: o.use });
    } else {
      console.error("⚠  ignoring router rule — need { when: \"phase == edit\", use: \"small\"|\"large\" }");
    }
  }
  return out.length > 0 ? out : undefined;
}

/** `judge: null` → 3-layer pipeline (default); object → 4-layer; missing `model`
 *  = cheapest small (resolved by the runtime in Phase E). */
function parseRouterJudge(raw: unknown, parent: Record<string, unknown>): RouterJudgeConfig | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) {
    if (parent.classifier === true) {
      // Migration (plan §3): the legacy boolean means "gray judge on the cheap small".
      console.error('⚠  router.classifier is deprecated — use "judge": { "scope": "gray" } (mapped automatically)');
      return { model: "", scope: "gray" };
    }
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    console.error("⚠  router.judge must be null or an object — ignored");
    return undefined;
  }
  const j = raw as Record<string, unknown>;
  const out: RouterJudgeConfig = { model: typeof j.model === "string" ? j.model.trim() : "" };
  if (j.scope === "gray" || j.scope === "first" || j.scope === "always") out.scope = j.scope;
  const ms = j.timeoutMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) out.timeoutMs = Math.floor(ms);
  const c = j.minConfidence;
  if (typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1) out.minConfidence = c;
  return out;
}

export function parseRouter(raw: unknown): RouterConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.error('⚠  rc "router" must be an object — ignored');
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const cfg: RouterConfig = {};
  if (typeof r.enabled === "boolean") cfg.enabled = r.enabled;
  if (typeof r.fallback === "string" && r.fallback.trim()) cfg.fallback = r.fallback.trim();
  const tiers = parseRouterTiers(r.tiers);
  if (tiers) cfg.tiers = tiers;
  const rules = parseRouterRules(r.rules);
  if (rules) cfg.rules = rules;
  const signals = parseRouterNumbers(r.signals, ["smallMaxCtxTokens", "largeToolSchemaChars"], "signals");
  if (signals) cfg.signals = signals as RouterConfig["signals"];
  const escalate = parseRouterNumbers(r.escalate, ["buildFails", "stickyMinSteps"], "escalate");
  if (escalate) cfg.escalate = escalate as RouterConfig["escalate"];
  const judge = parseRouterJudge(r.judge, r);
  if (judge !== undefined) cfg.judge = judge;
  return cfg;
}

/** Turn `"model": "auto"` into the fallback ref — or into nothing (warn). */
function resolveAutoStart(
  routerCfg: RouterConfig | undefined,
  custom: Record<string, ProviderDef>,
  activeId: string,
): string | undefined {
  if (!routerCfg?.enabled) {
    console.error('⚠  model "auto" needs "router": { "enabled": true } — routing off, keeping the default model');
    return undefined;
  }
  const t = resolveRouterTiers(routerCfg, custom, activeId);
  for (const w of t.warnings) console.error(`⚠  ${w}`);
  if (!t.fallback) {
    console.error('⚠  router: "model": "auto" needs router.enabled + valid tier models — routing off, keeping the default model');
    return undefined;
  }
  return t.fallback.ref;
}

/** Flatten rc-config model metadata into catalog-shaped entries (P2.1 §5). */
function buildConfigModels(custom: Record<string, ProviderDef>): Record<string, ModelInfo> {
  const out: Record<string, ModelInfo> = {};
  for (const def of Object.values(custom)) {
    for (const [mid, mc] of Object.entries(def.models ?? {})) {
      if (mc.contextWindow === undefined && mc.pricing === undefined &&
          mc.supportCache === undefined && mc.supportReasoning === undefined) continue;
      const info: ModelInfo = {
        id: mid,
        provider: def.id,
        contextWindow: mc.contextWindow ?? 0, // 0 → contextWindowFor falls back to 128k
        maxTokens: mc.maxTokens,
        pricing: mc.pricing,
        supportCache: mc.supportCache ?? def.supportCache,
        supportReasoning: mc.supportReasoning ?? def.supportReasoning,
      };
      // Canonical key (provider id) + alias under the runtime kind — Agent
      // code looks up with `config.provider`, which is the kind.
      out[`${def.id}/${mid}`] = info;
      out[`${def.kind}/${mid}`] = { ...info };
    }
  }
  return out;
}

/** Model-level cost overrides (P2.1 §5): providers' `models.<id>.cost`. */
function buildConfigPricing(custom: Record<string, ProviderDef>): Record<string, { input: number; output: number }> {
  const out: Record<string, { input: number; output: number }> = {};
  for (const def of Object.values(custom)) {
    for (const [mid, mc] of Object.entries(def.models ?? {})) {
      if (!mc.pricing) continue;
      out[mid] = mc.pricing;
      out[`${def.id}/${mid}`] = mc.pricing;
    }
  }
  return out;
}

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const workdir = overrides.workdir ?? process.cwd();
  const rc = loadRcFile(workdir);

  // P2.1: `rc.provider` is SHAPE-discriminated — a string is the legacy
  // active-provider selector, an object is the opencode-style provider block.
  const rcProviderSelector = typeof rc.provider === "string" ? rc.provider : undefined;
  const rcProviderBlock = typeof rc.provider === "object" && rc.provider !== null && !Array.isArray(rc.provider)
    ? rc.provider
    : undefined;

  // Provider auto-detection: explicit flag > env > rc > baseUrl/model heuristics
  const providerRaw =
    (overrides as { provider?: ProviderName }).provider ??
    process.env.SCODER_PROVIDER ??
    rcProviderSelector ??
    undefined;
  const isAnthropic =
    providerRaw === "anthropic" ||
    (providerRaw === undefined &&
      /api\.anthropic\.com/.test(
        process.env.SCODER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? rc.baseUrl ?? "",
      )) ||
    (providerRaw === undefined &&
      /^claude-/i.test(overrides.model ?? process.env.SCODER_MODEL ?? rc.model ?? ""));
  let provider: ProviderName = providerRaw === "anthropic" || isAnthropic ? "anthropic" : "openai";

  // I-01 + P2.1: provider registry — "provider/model" refs, bare ids that are
  // declared in a configured `models` map, legacy `providers.<id>` and the
  // new opencode `provider` block all merge into one map.
  const customProviders = { ...parseCustomProviders(rc.providers), ...parseProviderConfig(rcProviderBlock) };
  // P2.2 §4c: `"model": "auto"` + enabled router + valid tiers → AUTO mode.
  // The sentinel is rewritten to the tier fallback ref BEFORE the normal
  // resolution chain so baseUrl/key/context behave exactly as if the user had
  // typed that ref. If auto cannot be honored it becomes "" (provider default)
  // with a visible warning — there is never a model literally named "auto".
  const routerCfg = parseRouter(rc.router);
  const rawModel0 = overrides.model ?? process.env.SCODER_MODEL ?? process.env.OPENAI_MODEL ?? rc.model ?? "";
  let rawModel = rawModel0;
  let routerMode: AgentConfig["routerMode"];
  if (rawModel0 === "auto") {
    const autoRef = resolveAutoStart(routerCfg, customProviders, rcProviderSelector ?? (isAnthropic ? "anthropic" : "openai"));
    rawModel = autoRef ?? "";
    routerMode = autoRef ? "auto" : undefined;
  } else if (routerCfg?.enabled) {
    routerMode = "pinned"; // router armed but the human pinned a model — idle until `/model auto`
  }
  const [providerPrefix, modelFromSlash] = splitProviderModel(rawModel);
  let refExplicit = providerPrefix !== null;
  let providerId =
    providerPrefix ??
    (overrides as { provider?: string }).provider ??
    process.env.SCODER_PROVIDER ??
    rcProviderSelector ??
    (isAnthropic ? "anthropic" : "openai");
  if (!providerPrefix && rawModel) {
    const owners = findModelOwners(rawModel, customProviders);
    if (owners.length === 1) {
      providerId = owners[0].provider.id; // bare id declared by exactly one provider → route to it
      refExplicit = true;
    } else if (owners.length > 1) {
      const active = customProviders[providerId];
      if (!active?.models?.[rawModel]) {
        console.error(
          `⚠  model "${rawModel}" is declared by several providers (${owners.map((o) => o.provider.id).join(", ")}) — write "<provider>/${rawModel}" to choose`,
        );
      }
    }
  }
  const providerResolution = resolveProvider(providerId, customProviders);
  const providerDef = "def" in providerResolution ? providerResolution.def : undefined;
  if ("error" in providerResolution) {
    console.error(`⚠  provider: ${providerResolution.error} — falling back to openai-compatible behavior`);
  }
  // An explicit ref wins the runtime kind over the "claude-" heuristic (e.g.
  // `box-api/…` kind anthropic, `groq/claude-copy` kind openai).
  if (providerDef && refExplicit && providerDef.kind !== provider) provider = providerDef.kind;

  // API key chain (P2.1 §3): flag > SCODER_API_KEY > <apiKeyEnv> env >
  // provider options.apiKey (rc inline) > rc.apiKey > "".
  const providerKeyEnv = providerDef ? process.env[providerDef.apiKeyEnv] : undefined;
  // P0-5: same chain as before, but remember WHICH source won — a provider
  // hot-swap may only re-resolve an env-derived key; a pinned one (flag or rc)
  // is provider-agnostic and must survive the switch. `provider-rc` is
  // provider-SPECIFIC: the inline key travels with its provider only.
  const keyFromEnv =
    process.env.SCODER_API_KEY ??
    providerKeyEnv ??
    (isAnthropic ? process.env.ANTHROPIC_API_KEY : undefined) ??
    process.env.OPENAI_API_KEY;
  const keyFromProviderRc = keyFromEnv ? undefined : providerDef?.apiKeyInline;
  const apiKey = overrides.apiKey ?? keyFromEnv ?? keyFromProviderRc ?? rc.apiKey ?? "";
  const apiKeySource: NonNullable<AgentConfig["apiKeySource"]> = overrides.apiKey
    ? "flag"
    : keyFromEnv
      ? "env"
      : keyFromProviderRc
        ? "provider-rc"
        : rc.apiKey
          ? "rc"
          : "none";

  // Validate maxSteps: NaN/0/negative would silently break the agent loop
  // (steps < NaN is always false → the loop never runs).
  const rawMaxSteps = Number(process.env.SCODER_MAX_STEPS ?? rc.maxSteps ?? 40);
  const validatedMaxSteps = Number.isFinite(rawMaxSteps) && rawMaxSteps >= 1 ? Math.floor(rawMaxSteps) : 40;
  // P2-1: profile local CHỈ hạ maxSteps khi user không đặt tường minh ở
  // flag/env/rc — tôn trọng cấu hình rõ ràng của user.
  const maxStepsExplicit =
    overrides.maxSteps !== undefined || process.env.SCODER_MAX_STEPS !== undefined || rc.maxSteps !== undefined;

  // The final model id (after "provider/model" split) — used for model-level
  // metadata lookups (context window, pricing display) below.
  const resolvedModelId = modelFromSlash || rawModel || (isAnthropic ? ANTHROPIC_DEFAULT_MODEL : DEFAULT_MODEL);

  const cfg: AgentConfig = {
    provider,
    // P2.1: the resolved provider def's own endpoint beats the generic default
    // (an explicit env/flag/rc.baseUrl still wins above it).
    baseUrl: overrides.baseUrl ?? process.env.SCODER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? rc.baseUrl ?? providerDef?.baseUrl ?? (isAnthropic ? ANTHROPIC_BASE_URL : DEFAULT_BASE_URL),
    apiKey,
    apiKeySource,
    model: resolvedModelId,
    providerDef,
    // Model-level ctx (provider block `models.<id>.limit.context`) wins over
    // the provider default; rc.contextWindow still overrides everything.
    contextWindow:
      rc.contextWindow ??
      providerDef?.models?.[resolvedModelId]?.contextWindow ??
      (providerDef as { contextWindow?: number } | undefined)?.contextWindow,
    workdir,
    buildCmd: overrides.buildCmd ?? process.env.SCODER_BUILD_CMD ?? rc.buildCmd ?? null,
    maxSteps: overrides.maxSteps ?? validatedMaxSteps,
    maxTokens: 8192,
    temperature: 0.2,
    yes: overrides.yes ?? false,
    noSave: (overrides as { noSave?: boolean }).noSave ?? process.env.SCODER_NO_SAVE === "1",
    logFile:
      (overrides as { logFile?: boolean | string }).logFile ??
      // "1" means auto-path (.scoder/logs/<session>.jsonl); any other non-empty
      // value is treated as an explicit path. A bare string "1" would otherwise
      // resolve to a file literally named "1".
      (process.env.SCODER_LOG_FILE === "1"
        ? true
        : process.env.SCODER_LOG_FILE || undefined),
    mcpServers: rc.mcpServers,
    mcpTools: rc.mcpTools,
    guardrails: rc.guardrails,
    stream: overrides.stream ?? (process.env.SCODER_STREAM !== "0" ? true : false),
    reasoning:
      overrides.reasoning ??
      (process.env.SCODER_REASONING === "1" ? "on" : undefined) ??
      rc.reasoning ??
      "off",
    permissionMode: overrides.permissionMode ??
      parsePermissionMode(process.env.SCODER_PERMISSION ?? rc.permission ?? rc.permissions?.mode ?? "auto"),
    permissionRules: parsePermissionRules(rc.permissions?.rules),
    compaction: rc.compaction ?? undefined,
    formatter: rc.formatter ?? undefined,
    sandbox: rc.sandbox,
    limits: parseLimits(rc.limits),
    snapshots: rc.snapshots,
    agent: overrides.agent ?? process.env.SCODER_AGENT ?? rc.agent,
    routing: rc.routing,
    router: routerCfg,
    routerMode,
    repoMap: rc.repoMap,
    warmup: rc.warmup,
    promptVersion: rc.promptVersion,
    verifyCmds: rc.verifyCmds,
    selfReview: rc.selfReview,
    verifyCache: rc.verifyCache,
    localProfile: rc.localProfile,
    modelPricing: mergePricing(buildConfigPricing(customProviders), parsePricing(rc.modelPricing)),
    theme: overrides.theme ?? process.env.SCODER_THEME ?? rc.theme,
    notify: process.env.SCODER_NOTIFY != null
      ? /^(1|true)$/.test(process.env.SCODER_NOTIFY)
      : rc.notify ?? true,
  };

  // P2: local engine → mặc định rẻ hơn (maxSteps, timeout, output cap, MCP
  // schema budget, self-review). Danh sách thay đổi được log qua reporter để
  // `scoder cost`/JSONL giải thích được vì sao run này khác cloud.
  const localChanges = applyLocalProfile(cfg, { maxSteps: maxStepsExplicit });
  if (localChanges.length > 0) {
    overrides.reporter?.info(`local model profile (plan/performance-issue.md P2): ${localChanges.join(", ")} — ghi đè bằng rc "localProfile": false hoặc đặt từng key trong "limits"`);
  }

  // P2.1 §5: config-level models become the top layer of the catalog so
  // sidebar ctx %, compaction and contextWindowFor know box-api-style ids.
  registerConfigModels(buildConfigModels(customProviders));

  // Secrets hygiene: warn if apiKey is set in the rc file (risk of accidental commit)
  if (rc.apiKey && !process.env.SCODER_NO_APIKEY_WARNING) {
    console.error(
      `\n⚠  WARNING: API key found in .scoderrc.json — this file may be committed to git.\n` +
      `   Prefer the environment variable SCODER_API_KEY (or OPENAI_API_KEY) instead,\n` +
      `   and add .scoderrc.json to .gitignore. Suppress: SCODER_NO_APIKEY_WARNING=1\n`,
    );
  }
  // P2.1 §3: the same commit risk applies to literal inline keys in the
  // provider block — `{env:VAR}` is the recommended form.
  if (rcProviderBlock && !process.env.SCODER_NO_APIKEY_WARNING) {
    for (const [id, v] of Object.entries(rcProviderBlock)) {
      const k = (v as { options?: { apiKey?: unknown } })?.options?.apiKey;
      if (typeof k === "string" && k && !k.includes("{env:")) {
        console.error(
          `⚠  WARNING: provider "${id}" has a literal API key in the rc file — prefer "apiKey": "{env:VAR_NAME}". Suppress: SCODER_NO_APIKEY_WARNING=1`,
        );
        break;
      }
    }
  }

  return cfg;
}

/** P-perf (item 20): shared (mtimeMs, size) stat-stamp helpers — the same
 *  invalidation contract as rcTextMemo above: a file is re-read/re-parsed
 *  only when its stat changes (hot-reload tests that rewrite files keep
 *  working: writeFileSync bumps mtimeMs). */
interface FileStamp { m: number; s: number }
const NO_FILE: FileStamp = { m: -1, s: -1 };

function stampOf(path: string | null): FileStamp {
  if (!path) return NO_FILE;
  try {
    const st = statSync(path);
    return { m: st.mtimeMs, s: st.size };
  } catch {
    return NO_FILE;
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.m === b.m && a.s === b.s;
}

/** The project rc actually chosen by loadRcFile (first hit wins), or null. */
function projectRcPath(workdir: string): string | null {
  for (const name of [".scoderrc.json", ".scoderrc"]) {
    const p = resolve(workdir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Extract permission lists from the rc file (loaded again here to avoid widening AgentConfig). */
const permListsMemo = new Map<string, { g: FileStamp; p: FileStamp; lists: { allowCommands: string[]; denyCommands: string[] } }>();

export function loadPermissionLists(workdir: string): { allowCommands: string[]; denyCommands: string[] } {
  // P-perf (item 20): derived-list cache — Agent construction + setPermissionMode
  // + every subagent re-ran existsSync/JSON.parse/merge for two rc files to
  // produce the same two small arrays. Callers (PermissionChecker via
  // builtinRulesFromLists) only READ these arrays, so the cached object is
  // shared deliberately.
  const g = stampOf(globalRcPath());
  const p = stampOf(projectRcPath(workdir));
  const hit = permListsMemo.get(workdir);
  if (hit && sameStamp(hit.g, g) && sameStamp(hit.p, p)) return hit.lists;
  const rc = loadRcFile(workdir);
  const lists = {
    allowCommands: parseList(rc.permissions?.allowCommands),
    denyCommands: parseList(rc.permissions?.denyCommands),
  };
  permListsMemo.set(workdir, { g, p, lists });
  return lists;
}

/**
 * Policy layer (enterprise hard floor — pattern from opencode /v2/docs/policies):
 * evaluated AFTER config rules but its deny always wins. Sources, lowest first:
 * ~/.scoder/policies.json (user-global), /etc/scoder/policies.json (machine),
 * SCODER_POLICY=<file> env (highest).
 */
const policyFileMemo = new Map<string, FileStamp & { rules: PermissionRule[] }>();

export function loadPolicyRules(_workdir: string): PermissionRule[] {
  const candidates = [
    join(homedir(), ".scoder", "policies.json"),
    "/etc/scoder/policies.json",
    process.env.SCODER_POLICY ?? "",
  ].filter(Boolean);
  const out: PermissionRule[] = [];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const st = stampOf(p);
    const hit = policyFileMemo.get(p);
    // Malformed files are never cached: every call must keep printing the
    // warning, exactly like the old parse-on-every-call code path below.
    if (hit && sameStamp(hit, st)) {
      out.push(...hit.rules);
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      const rules = parsePermissionRules(raw, p) ?? [];
      policyFileMemo.set(p, { m: st.m, s: st.s, rules });
      out.push(...rules);
    } catch (err) {
      console.error(`⚠  ignoring malformed policy file ${p}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Saved "always allow" approvals (pattern from opencode permission/saved.ts):
 * persisted in <workdir>/.scoder/permissions.local.json, project-scoped.
 * Never overrides a configured deny (enforced in PermissionChecker).
 */
export function savedApprovalsPath(workdir: string): string {
  return resolve(workdir, ".scoder", "permissions.local.json");
}

const approvalsFileMemo = new Map<string, FileStamp & { rules: PermissionRule[] }>();

export function loadSavedApprovals(workdir: string): PermissionRule[] {
  // P-perf (item 20): stat-keyed parse cache (same contract as policy above).
  // Every "always allow" answer goes through saveApproval → writeFileSync →
  // the next read sees a new mtime, so hot reload stays exact. Consumers
  // (PermissionChecker, saveApproval's filter) only read the returned array.
  const p = savedApprovalsPath(workdir);
  if (!existsSync(p)) return [];
  // P1-config-trust: a committed .scoder/permissions.local.json is NOT
  // evidence the user approved anything — honor it only in trusted dirs.
  if (!guardSavedApprovals(workdir)) return [];
  const st = stampOf(p);
  const hit = approvalsFileMemo.get(p);
  if (hit && sameStamp(hit, st)) return hit.rules;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const rules = raw && typeof raw === "object" && !Array.isArray(raw) && "rules" in raw
      ? (raw as { rules?: unknown }).rules
      : raw;
    const parsed = parsePermissionRules(rules, p) ?? [];
    approvalsFileMemo.set(p, { m: st.m, s: st.s, rules: parsed });
    return parsed;
  } catch {
    return [];
  }
}

export function saveApproval(workdir: string, rule: PermissionRule): void {
  const p = savedApprovalsPath(workdir);
  const existing = loadSavedApprovals(workdir);
  const next = [...existing.filter((r) => !(r.action === rule.action && r.resource === rule.resource)), rule];
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ rules: next }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}
