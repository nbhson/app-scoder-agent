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
  /** JSONL session log: true = .coder/logs/<session>.jsonl, string = custom path */
  logFile?: boolean | string;
  /** MCP stdio servers: name -> launch config */
  mcpServers?: Record<string, import("./mcp.js").McpServerConfig>;
  /** Permission mode: auto | ask | readonly */
  permissionMode: PermissionMode;
  /** Streaming LLM responses */
  stream: boolean;
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
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: {
    mode?: string;
    allowCommands?: string[];
    denyCommands?: string[];
  };
}

function loadRcFile(workdir: string): RcFile {
  for (const name of [".coderrc.json", ".coderrc"]) {
    const p = resolve(workdir, name);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as RcFile;
      } catch {
        // malformed rc file -> ignore
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

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const workdir = overrides.workdir ?? process.cwd();
  const rc = loadRcFile(workdir);

  // Provider auto-detection: explicit flag > env > rc > baseUrl/model heuristics
  const providerRaw =
    (overrides as { provider?: ProviderName }).provider ??
    process.env.CODER_PROVIDER ??
    rc.provider ??
    undefined;
  const isAnthropic =
    providerRaw === "anthropic" ||
    (providerRaw === undefined &&
      /api\.anthropic\.com/.test(
        process.env.CODER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? rc.baseUrl ?? "",
      )) ||
    (providerRaw === undefined &&
      /^claude-/i.test(overrides.model ?? process.env.CODER_MODEL ?? rc.model ?? ""));
  const provider: ProviderName = providerRaw === "anthropic" || isAnthropic ? "anthropic" : "openai";

  const cfg: AgentConfig = {    provider,
    baseUrl: overrides.baseUrl ?? process.env.CODER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? rc.baseUrl ?? (isAnthropic ? ANTHROPIC_BASE_URL : DEFAULT_BASE_URL),
    apiKey:
      overrides.apiKey ??
      process.env.CODER_API_KEY ??
      (isAnthropic ? process.env.ANTHROPIC_API_KEY : undefined) ??
      process.env.OPENAI_API_KEY ??
      rc.apiKey ??
      "",
    model: overrides.model ?? process.env.CODER_MODEL ?? process.env.OPENAI_MODEL ?? rc.model ?? (isAnthropic ? ANTHROPIC_DEFAULT_MODEL : DEFAULT_MODEL),
    workdir,
    buildCmd: overrides.buildCmd ?? process.env.CODER_BUILD_CMD ?? rc.buildCmd ?? null,
    maxSteps: overrides.maxSteps ?? Number(process.env.CODER_MAX_STEPS ?? rc.maxSteps ?? 40),
    maxTokens: 8192,
    temperature: 0.2,
    yes: overrides.yes ?? false,
    noSave: (overrides as { noSave?: boolean }).noSave ?? process.env.CODER_NO_SAVE === "1",
    logFile:
      (overrides as { logFile?: boolean | string }).logFile ??
      // "1" means auto-path (.coder/logs/<session>.jsonl); any other non-empty
      // value is treated as an explicit path. A bare string "1" would otherwise
      // resolve to a file literally named "1".
      (process.env.CODER_LOG_FILE === "1"
        ? true
        : process.env.CODER_LOG_FILE || undefined),
    mcpServers: rc.mcpServers,
    stream: overrides.stream ?? (process.env.CODER_STREAM !== "0" ? true : false),
    permissionMode: overrides.permissionMode ??
      parsePermissionMode(process.env.CODER_PERMISSION ?? rc.permission ?? rc.permissions?.mode ?? "auto"),
  };

  // Secrets hygiene: warn if apiKey is set in the rc file (risk of accidental commit)
  if (rc.apiKey && !process.env.CODER_NO_APIKEY_WARNING) {
    console.error(
      `\n⚠  WARNING: API key found in .coderrc.json — this file may be committed to git.\n` +
      `   Prefer the environment variable CODER_API_KEY (or OPENAI_API_KEY) instead,\n` +
      `   and add .coderrc.json to .gitignore. Suppress: CODER_NO_APIKEY_WARNING=1\n`,
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
