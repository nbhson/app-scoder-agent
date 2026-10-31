import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import type { PermissionMode, PermissionRule, PermissionEffect } from "./permissions.js";
import { parseCustomProviders, resolveProvider, splitProviderModel } from "./provider-registry.js";

export interface AgentConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Provider backend: "openai" (compatible) or "anthropic" (native Messages API) */
  provider: "openai" | "anthropic";
  /** Working directory the agent operates on */
  workdir: string;
  /** Build/compile command used as the stop condition */
  buildCmd: string | null;
  /** Max autonomous loop iterations before giving up */
  maxSteps: number;
  /** Guardrail thresholds (doom-loop, text-only streak, wrap-up timing) */
  guardrails?: { textOnlyStreakLimit?: number; doomLoopRepeats?: number; wrapUpStepsBeforeEnd?: number };
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
  /** I-11: post-edit formatter (rc `formatter`). */
  formatter?: boolean | string;
  /** Disable session auto-save */
  noSave?: boolean;
  /** JSONL session log: true = .scoder/logs/<session>.jsonl, string = custom path */
  logFile?: boolean | string;
  /** MCP stdio servers: name -> launch config */
  mcpServers?: Record<string, import("./mcp.js").McpServerConfig>;
  /** Permission mode: auto | ask | readonly */
  permissionMode: PermissionMode;
  /** Rule engine v2 (from rc permissions.rules). */
  permissionRules?: PermissionRule[];
  /** Resolved provider definition (I-01 registry — built-in or custom). */
  providerDef?: import("./provider-registry.js").ProviderDef;
  /** Model context window in tokens (from catalog I-02 or provider default). */
  contextWindow?: number;
  /** Streaming LLM responses */
  stream: boolean;
  /** Compaction: false disables; object overrides trigger/keep/buffer/contextWindow (H-10). */
  compaction?: { trigger?: number; keep?: number; buffer?: number; contextWindow?: number } | false;
  /** Per-model price overrides (USD per 1M tokens) for `scoder cost` estimation */
  modelPricing?: Record<string, import("./constants.js").ModelPricing>;
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
  provider?: string;
  /** Per-model price overrides (USD per 1M tokens) for `scoder cost`. */
  modelPricing?: Record<string, { input: number; output: number }>;
  /** Custom providers (I-01): id -> {baseUrl, apiKeyEnv, kind}. */
  providers?: unknown;
  /** Max steps before wrap-up reminder injection. */
  wrapUpStepsBeforeEnd?: number;
  /** Guardrail thresholds override (rc: "guardrails": {...}). */
  guardrails?: { textOnlyStreakLimit?: number; doomLoopRepeats?: number; wrapUpStepsBeforeEnd?: number };
  mcpServers?: Record<string, import("./mcp.js").McpServerConfig>;
  permissions?: {
    mode?: string;
    allowCommands?: string[];
    denyCommands?: string[];
    /** Rule engine v2 (see NOTICE — pattern from opencode): {action, resource, effect}. */
    rules?: unknown;
  };
  /** Auto-compaction (H-10): false = off, object = overrides. */
  compaction?: { trigger?: number; keep?: number; buffer?: number; contextWindow?: number } | false;
  /** I-11: post-edit formatter — true = auto-detect, string = binary or "npm:<script>". */
  formatter?: boolean | string;
  /** Git shadow snapshots (H-11): false disables checkpoint capture. */
  snapshots?: boolean;
  /** I-05: reasoning/thinking — "off" (default) | "on". */
  reasoning?: "off" | "on";
}

function readRcFile(path: string, label: string): RcFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RcFile;
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
    };
  }
  return merged;
}

function loadRcFile(workdir: string): RcFile {
  const global = readRcFile(globalRcPath(), globalRcPath());
  for (const name of [".scoderrc.json", ".scoderrc"]) {
    const p = resolve(workdir, name);
    if (existsSync(p)) {
      return mergeRc(global, readRcFile(p, name));
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

const VALID_EFFECTS = new Set(["allow", "deny", "ask"]);

/** Validate permission rules v2; drop malformed entries with a warning. */
export function parsePermissionRules(raw: unknown, label = "permissions.rules"): import("./permissions.js").PermissionRule[] | undefined {
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

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const workdir = overrides.workdir ?? process.cwd();
  const rc = loadRcFile(workdir);

  // Provider auto-detection: explicit flag > env > rc > baseUrl/model heuristics
  const providerRaw =
    (overrides as { provider?: ProviderName }).provider ??
    process.env.SCODER_PROVIDER ??
    rc.provider ??
    undefined;
  const isAnthropic =
    providerRaw === "anthropic" ||
    (providerRaw === undefined &&
      /api\.anthropic\.com/.test(
        process.env.SCODER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? rc.baseUrl ?? "",
      )) ||
    (providerRaw === undefined &&
      /^claude-/i.test(overrides.model ?? process.env.SCODER_MODEL ?? rc.model ?? ""));
  const provider: ProviderName = providerRaw === "anthropic" || isAnthropic ? "anthropic" : "openai";

  // I-01: provider registry — support "provider/model" syntax + custom providers.
  const customProviders = parseCustomProviders(rc.providers);
  const rawModel = overrides.model ?? process.env.SCODER_MODEL ?? process.env.OPENAI_MODEL ?? rc.model ?? "";
  const [providerPrefix, modelFromSlash] = splitProviderModel(rawModel);
  const providerId = providerPrefix ?? (overrides as { provider?: string }).provider ?? process.env.SCODER_PROVIDER ?? rc.provider ?? (isAnthropic ? "anthropic" : "openai");
  const providerResolution = resolveProvider(providerId, customProviders);
  const providerDef = "def" in providerResolution ? providerResolution.def : undefined;
  if ("error" in providerResolution) {
    console.error(`⚠  provider: ${providerResolution.error} — falling back to openai-compatible behavior`);
  }
  // API key: provider-specific env var wins (registry), then legacy chain.
  const providerKeyEnv = providerDef ? process.env[providerDef.apiKeyEnv] : undefined;

  // Validate maxSteps: NaN/0/negative would silently break the agent loop
  // (steps < NaN is always false → the loop never runs).
  const rawMaxSteps = Number(process.env.SCODER_MAX_STEPS ?? rc.maxSteps ?? 40);
  const validatedMaxSteps = Number.isFinite(rawMaxSteps) && rawMaxSteps >= 1 ? Math.floor(rawMaxSteps) : 40;

  const cfg: AgentConfig = {
    provider,
    baseUrl: overrides.baseUrl ?? process.env.SCODER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? rc.baseUrl ?? (isAnthropic ? ANTHROPIC_BASE_URL : DEFAULT_BASE_URL),
    apiKey:
      overrides.apiKey ??
      process.env.SCODER_API_KEY ??
      providerKeyEnv ??
      (isAnthropic ? process.env.ANTHROPIC_API_KEY : undefined) ??
      process.env.OPENAI_API_KEY ??
      rc.apiKey ??
      "",
    model: overrides.model ?? process.env.SCODER_MODEL ?? process.env.OPENAI_MODEL ?? rc.model ?? (modelFromSlash || (isAnthropic ? ANTHROPIC_DEFAULT_MODEL : DEFAULT_MODEL)),
    providerDef,
    contextWindow: (providerDef as { contextWindow?: number } | undefined)?.contextWindow,
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
    snapshots: rc.snapshots,
    modelPricing: parsePricing(rc.modelPricing),
  };

  // Secrets hygiene: warn if apiKey is set in the rc file (risk of accidental commit)
  if (rc.apiKey && !process.env.SCODER_NO_APIKEY_WARNING) {
    console.error(
      `\n⚠  WARNING: API key found in .scoderrc.json — this file may be committed to git.\n` +
      `   Prefer the environment variable SCODER_API_KEY (or OPENAI_API_KEY) instead,\n` +
      `   and add .scoderrc.json to .gitignore. Suppress: SCODER_NO_APIKEY_WARNING=1\n`,
    );
  }

  return cfg;
}

/** Extract permission lists from the rc file (loaded again here to avoid widening AgentConfig). */
export function loadPermissionLists(workdir: string): { allowCommands: string[]; denyCommands: string[] } {
  const rc = loadRcFile(workdir);
  return {
    allowCommands: parseList(rc.permissions?.allowCommands),
    denyCommands: parseList(rc.permissions?.denyCommands),
  };
}

/**
 * Policy layer (enterprise hard floor — pattern from opencode /v2/docs/policies):
 * evaluated AFTER config rules but its deny always wins. Sources, lowest first:
 * ~/.scoder/policies.json (user-global), /etc/scoder/policies.json (machine),
 * SCODER_POLICY=<file> env (highest).
 */
export function loadPolicyRules(_workdir: string): PermissionRule[] {
  const candidates = [
    join(homedir(), ".scoder", "policies.json"),
    "/etc/scoder/policies.json",
    process.env.SCODER_POLICY ?? "",
  ].filter(Boolean);
  const out: PermissionRule[] = [];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      const rules = parsePermissionRules(raw, p) ?? [];
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

export function loadSavedApprovals(workdir: string): PermissionRule[] {
  const p = savedApprovalsPath(workdir);
  if (!existsSync(p)) return [];
  try {
    return parsePermissionRules(JSON.parse(readFileSync(p, "utf8")), p) ?? [];
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
