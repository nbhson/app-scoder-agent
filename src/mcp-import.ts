/**
 * Phase 5 — MCP config import: parse server configs from third-party formats
 * (Claude Desktop, OpenCode, .mcp.json) and merge them into our format.
 *
 * Supports:
 * - Claude Desktop: `~/.claude/config.json` → `mcpServers` (stdio + env)
 * - OpenCode:       `opencode.json`          → `mcp` (stdio or http)
 * - Standard:       `.mcp.json`             → array of `{name, command, url, …}`
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "./mcp.js";

/** Result of parsing one source file. */
export interface ImportedServer {
  /** Source file + server key this was parsed from. */
  source: string;
  /** Canonical name used in our config. */
  name: string;
  /** Original key from the source file (may differ from `name`). */
  originalKey: string;
  config: McpServerConfig;
}

/** What we detected in a source file. */
export interface ImportSource {
  path: string;
  format: "claude" | "opencode" | "mcp-json";
  servers: ImportedServer[];
}

/** Normalise a Claude Desktop mcpServers entry to our McpServerConfig. */
function fromClaudeDesktop(raw: Record<string, unknown>, _name: string): McpServerConfig {
  const cfg: McpServerConfig = {};
  if (typeof raw.command === "string") {
    cfg.command = raw.command;
    if (Array.isArray(raw.args)) cfg.args = raw.args as string[];
  } else if (typeof raw.url === "string") {
    cfg.url = raw.url;
    if (typeof raw.headers === "object" && raw.headers !== null) {
      cfg.headers = raw.headers as Record<string, string>;
    }
  }
  if (typeof raw.env === "object" && raw.env !== null) {
    cfg.env = raw.env as Record<string, string>;
  }
  if (typeof raw.autoApprove === "boolean") {
    // Claude Desktop autoApprove maps to our trust levels:
    // autoApprove=true → "auto" (trust the server to run without prompt)
    // autoApprove=false → "ask" (default, prompt before each tool call)
    // We deliberately do NOT set trust here — let the global mode apply.
  }
  return cfg;
}

/** Normalise an OpenCode mcp config entry to our McpServerConfig. */
function fromOpenCode(raw: Record<string, unknown>, _name: string): McpServerConfig {
  const cfg: McpServerConfig = {};
  if (typeof raw.command === "string") {
    cfg.command = raw.command;
    if (Array.isArray(raw.args)) cfg.args = raw.args as string[];
  } else if (typeof raw.url === "string") {
    cfg.url = raw.url;
    if (typeof raw.headers === "object" && raw.headers !== null) {
      cfg.headers = raw.headers as Record<string, string>;
    }
  }
  if (typeof raw.env === "object" && raw.env !== null) {
    cfg.env = raw.env as Record<string, string>;
  }
  if (raw.disabled === true) cfg.enabled = false;
  return cfg;
}

/** Parse Claude Desktop `mcpServers` config from a JSON string. */
function parseClaude(raw: string, sourcePath: string): ImportedServer[] {
  const parsed = JSON.parse(raw);
  const servers: ImportedServer[] = [];
  const entries = parsed?.mcpServers ?? parsed?.mcp?.servers ?? {};
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    if (rec.enabled === false) continue;
    const config = fromClaudeDesktop(rec, key);
    if (!config.command && !config.url) continue;
    servers.push({ source: sourcePath, name: key, originalKey: key, config });
  }
  return servers;
}

/** Parse OpenCode `mcp` config from a JSON string. */
function parseOpenCode(raw: string, sourcePath: string): ImportedServer[] {
  const parsed = JSON.parse(raw);
  const servers: ImportedServer[] = [];
  const entries = parsed?.mcp ?? parsed?.servers ?? {};
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    // OpenCode: "disabled" flag; our config: "enabled: false". Both mean skip.
    if (rec.disabled === true || rec.enabled === false) continue;
    const config = fromOpenCode(rec, key);
    if (!config.command && !config.url) continue;
    servers.push({ source: sourcePath, name: key, originalKey: key, config });
  }
  return servers;
}

/** Parse standard `.mcp.json` array of server configs. */
function parseMcpJson(raw: string, sourcePath: string): ImportedServer[] {
  const parsed = JSON.parse(raw);
  const servers: ImportedServer[] = [];
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "unknown";
    if (rec.enabled === false) continue;
    const cfg: McpServerConfig = {};
    if (typeof rec.command === "string") {
      cfg.command = rec.command;
      if (Array.isArray(rec.args)) cfg.args = rec.args as string[];
    } else if (typeof rec.url === "string") {
      cfg.url = rec.url;
      if (typeof rec.headers === "object" && rec.headers !== null) {
        cfg.headers = rec.headers as Record<string, string>;
      }
    }
    if (typeof rec.timeoutMs === "number") cfg.timeoutMs = rec.timeoutMs;
    if (typeof rec.env === "object" && rec.env !== null) {
      cfg.env = rec.env as Record<string, string>;
    }
    if (typeof rec.trust === "string") cfg.trust = rec.trust as McpServerConfig["trust"];
    if (typeof rec.enabled === "boolean") cfg.enabled = rec.enabled;
    if (!cfg.command && !cfg.url) continue;
    servers.push({ source: sourcePath, name, originalKey: name, config: cfg });
  }
  return servers;
}

/** Detect format and parse a source file; throws on unreadable/invalid JSON. */
export function parseConfigFile(raw: string, sourcePath: string): ImportedServer[] {
  // Heuristic: if it has `mcpServers` top-level → Claude Desktop.
  // If it has `mcp` top-level (object or array) → OpenCode or standard MCP.
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in ${sourcePath}`); }
  if ("mcpServers" in parsed) return parseClaude(raw, sourcePath);
  if ("mcp" in parsed) return parseOpenCode(raw, sourcePath);
  // Fallback: treat as standard MCP JSON array.
  return parseMcpJson(raw, sourcePath);
}

/**
 * Load + parse one config file by path.
 * Returns `null` when the file does not exist; throws on unreadable/invalid.
 */
export function loadConfigFile(path: string): ImportedServer[] | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  return parseConfigFile(raw, path);
}

/** Scan for config files in common locations. */
export interface AutoDiscovered {
  source: string;
  format: "claude" | "opencode" | "mcp-json";
  serverCount: number;
}

export function discoverConfigs(): AutoDiscovered[] {
  const found: AutoDiscovered[] = [];
  const checks: Array<[string, "claude" | "opencode" | "mcp-json"]> = [
    [join(homedir(), ".claude", "config.json"), "claude"],
    [join(homedir(), ".config", "claude", "config.json"), "claude"],
    [join(process.cwd(), "opencode.json"), "opencode"],
    [join(process.cwd(), ".mcp.json"), "mcp-json"],
  ];
  for (const [path, format] of checks) {
    try {
      const raw = readFileSync(path, "utf8");
      const servers = parseConfigFile(raw, path);
      if (servers.length > 0) found.push({ source: path, format, serverCount: servers.length });
    } catch { /* not present */ }
  }
  return found;
}

/** Merge imported servers into an existing config map. */
export function mergeConfigs(
  existing: Record<string, McpServerConfig>,
  imported: ImportedServer[],
  opts: { force?: boolean; dryRun?: boolean } = {},
): { added: ImportedServer[]; skipped: ImportedServer[]; updated: string[] } {
  const added: ImportedServer[] = [];
  const skipped: ImportedServer[] = [];
  const updated: string[] = [];
  for (const srv of imported) {
    const existingCfg = existing[srv.name];
    if (existingCfg && !opts.force) {
      skipped.push(srv);
      continue;
    }
    if (existingCfg && opts.force) updated.push(srv.name);
    if (!opts.dryRun) existing[srv.name] = srv.config;
    added.push(srv);
  }
  return { added, skipped, updated };
}
