import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PermissionMode } from "./permissions.js";
import type { McpServerConfig } from "./mcp.js";

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
  /** Max tokens for chat completions */
  maxTokens: number;
  temperature: number;
  /** Non-interactive: fail instead of prompting */
  yes: boolean;
  /** Disable session auto-save */
  noSave?: boolean;
  /** JSONL session log: true = .scoder/logs/<session>.jsonl, string = custom path */
  logFile?: boolean | string;
  /** MCP stdio servers: name -> launch config */
  mcpServers?: Record<string, import("./mcp.js").McpServerConfig>;
  /** Permission mode: auto | ask | readonly */
  permissionMode: PermissionMode;
  /** Streaming LLM responses */
  stream: boolean;
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
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: {
    mode?: string;
    allowCommands?: string[];
    denyCommands?: string[];
  };
}

function loadRcFile(workdir: string): RcFile {
  for (const name of [".scoderrc.json", ".scoderrc"]) {
    const p = resolve(workdir, name);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as RcFile;
      } catch (err) {
        // malformed rc file -> ignore it, but tell the user why their config is not applied
        console.error(`⚠  ignoring malformed config file ${name}: ${(err as Error).message}`);
      }
    }
  }
  return {};
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
      (isAnthropic ? process.env.ANTHROPIC_API_KEY : undefined) ??
      process.env.OPENAI_API_KEY ??
      rc.apiKey ??
      "",
    model: overrides.model ?? process.env.SCODER_MODEL ?? process.env.OPENAI_MODEL ?? rc.model ?? (isAnthropic ? ANTHROPIC_DEFAULT_MODEL : DEFAULT_MODEL),
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
    stream: overrides.stream ?? (process.env.SCODER_STREAM !== "0" ? true : false),
    permissionMode: overrides.permissionMode ??
      parsePermissionMode(process.env.SCODER_PERMISSION ?? rc.permission ?? rc.permissions?.mode ?? "auto"),
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
