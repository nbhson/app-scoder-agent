import { saveApproval } from "../config/config.js";
import { redactSecrets, type ToolSpec } from "../llm/llm.js";
import {allToolSpecs} from "../tools/registry.js";
import { applyToolFilter } from "./types.js";
import {McpManager} from "../mcp/manager.js";
import { type McpServerConfig } from "../mcp/types.js";
import type { AgentConfig } from "../config/config.js";
import type { AgentEvent } from "./types.js";
import type { PermissionChecker } from "../security/permissions.js";
import { validateSchema } from "../shared/json-schema.js";
import type { JsonlLogger } from "../session/logger.js";
import type { Reporter } from "../io/reporter.js";

export interface McpBridgeRuntime {
  config: AgentConfig;
  reporter: Reporter;
  logger: JsonlLogger;
  permissions: PermissionChecker;
  primaryDef: import("../context/agents.js").AgentDef | null;
  pendingAllowedTools: string[] | null;
  getMcp: () => McpManager | null;
  setMcp: (manager: McpManager | null) => void;
  setTools: (tools: ToolSpec[]) => void;
  emit: (event: AgentEvent) => void;
  confirmMcpTool: (fullName: string) => Promise<boolean>;
}

export function rebuildToolList(runtime: McpBridgeRuntime): void {
  const manager = runtime.getMcp();
  const mcpSpecs = manager ? [...manager.toToolSpecs(), ...manager.resourceToolSpecs()] : [];
  let base = applyToolFilter(allToolSpecs(), runtime.primaryDef, runtime.reporter);
  if (runtime.pendingAllowedTools && runtime.pendingAllowedTools.length > 0) {
    const allow = new Set(runtime.pendingAllowedTools.map((tool) => tool.toLowerCase()));
    base = base.filter((spec) => allow.has(spec.function.name.toLowerCase()));
    runtime.setTools([...base, ...mcpSpecs.filter((spec) => allow.has(spec.function.name.toLowerCase()))]);
  } else {
    runtime.setTools([...base, ...mcpSpecs]);
  }
}

export async function connectMcp(runtime: McpBridgeRuntime): Promise<void> {
  const servers = runtime.config.mcpServers ?? {};
  if (Object.keys(servers as Record<string, unknown>).length === 0) return;
  if (runtime.getMcp()) return;
  if (runtime.config.permissionMode === "readonly") {
    runtime.reporter.warn("readonly mode: MCP tools are disabled (they bypass the permission system)");
  }
  const manager = new McpManager(servers);
  runtime.setMcp(manager);
  manager.onStatus = (line) => {
    runtime.logger.log({ type: "mcp_status", line });
    runtime.emit({ type: "mcp_status", line });
    runtime.reporter.info(line);
  };
  manager.onServerState = (name, state, detail) => {
    const line = `MCP "${name}" ${state}${detail ? ` — ${detail}` : ""}`;
    runtime.logger.log({ type: "mcp_status", line, server: name, state });
    runtime.emit({ type: "mcp_status", line, server: name, state });
  };
  await manager.connectAll();
  rebuildToolList(runtime);
}

export function shutdownMcp(runtime: McpBridgeRuntime): void {
  runtime.getMcp()?.killAll();
  runtime.setMcp(null);
}

export async function invokeMcpTool(runtime: McpBridgeRuntime, name: string, args: Record<string, unknown>): Promise<import("../tools/types.js").ToolResult> {
  const registration = runtime.getMcp()?.getTool(name);
  if (!registration) return { ok: false, output: `ERROR: unknown tool "${name}"` };
  const schemaErrors = validateSchema(args, registration.def.inputSchema);
  if (schemaErrors.length > 0) {
    return { ok: false, output: `ERROR: invalid arguments for ${name}:\n${schemaErrors.join("\n")}` };
  }
  runtime.logger.log({
    type: "mcp_audit",
    tool: name,
    server: registration.serverName,
    args: redactSecrets(JSON.stringify(args)),
    ts: new Date().toISOString(),
  });
  const result = await registration.conn.callTool(registration.toolName, args);
  return {
    ok: result.ok,
    output: result.output.length > 20_000 ? result.output.slice(0, 20_000) + "\n... [truncated]" : result.output,
    untrusted: true,
  };
}

export async function mcpStatus(runtime: McpBridgeRuntime): Promise<Array<{
  name: string;
  command: string;
  connected: boolean;
  tools: Array<{ name: string; description?: string }>;
  serverInfo: { name?: string; version?: string };
  capabilities: Record<string, unknown>;
  resourceCount: number;
  promptCount: number;
}>> {
  const configs = (runtime.config.mcpServers ?? {}) as Record<string, { command?: string; url?: string }>;
  const target = (config: { command?: string; url?: string }) => config.url ?? config.command ?? "(unknown)";
  const manager = runtime.getMcp();
  if (!manager) {
    return Object.entries(configs).map(([name, config]) => ({ name, command: target(config), connected: false, tools: [], serverInfo: {}, capabilities: {}, resourceCount: 0, promptCount: 0 }));
  }
  await connectMcp(runtime);
  const states = manager.serverStates();
  const stateMap = new Map(states.map((state) => [state.name, state]));
  const byServer = new Map(manager.listToolsByServer().map((server) => [server.server, server.tools]));
  return Object.entries(configs).map(([name, config]) => {
    const state = stateMap.get(name);
    return {
      name,
      command: target(config),
      connected: state?.state === "ready",
      tools: byServer.get(name) ?? [],
      serverInfo: state?.serverInfo ?? {},
      capabilities: state?.capabilities ?? {},
      resourceCount: state?.resourceCount ?? 0,
      promptCount: state?.promptCount ?? 0,
    };
  });
}

export async function callMcpTool(runtime: McpBridgeRuntime, fullName: string, inputArgs: Record<string, unknown>): Promise<{ ok: boolean; output: string; structured?: Record<string, unknown> }> {
  await connectMcp(runtime);
  const manager = runtime.getMcp();
  const registration = manager?.getTool(fullName);
  if (!registration) return { ok: false, output: `ERROR: unknown MCP tool "${fullName}" — run /mcp to list servers and tools.` };
  const trust = (runtime.config.mcpServers as Record<string, McpServerConfig>)[registration.serverName]?.trust;
  const decision = runtime.permissions.classifyMcpTool(fullName, trust) ??
    (runtime.config.permissionMode === "readonly" ? { decision: "deny" as const, reason: "readonly mode" } :
      runtime.config.permissionMode === "ask" ? { decision: "ask" as const, reason: "requires user confirmation" } :
        { decision: "allow" as const, reason: "auto mode" });
  if (decision.decision === "deny") return { ok: false, output: `ERROR: MCP tool denied (${decision.reason}).` };
  if (decision.decision === "ask" && !runtime.config.yes && !(await runtime.confirmMcpTool(fullName))) {
    return { ok: false, output: `ERROR: user denied permission to call MCP tool: ${fullName}` };
  }
  let args = inputArgs;
  if ("__text" in args && typeof args.__text === "string") {
    const properties = (registration.def.inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
    const required = (registration.def.inputSchema?.required ?? []) as string[];
    const target = required.find((key) => properties[key]?.type === "string") ?? Object.keys(properties).find((key) => properties[key]?.type === "string");
    if (!target) return { ok: false, output: `ERROR: "${fullName}" has no string parameter — pass JSON args instead.` };
    args = { [target]: args.__text };
  }
  try {
    return await registration.conn.callTool(registration.toolName, args);
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
}

export async function confirmMcpTool(runtime: McpBridgeRuntime, fullName: string): Promise<boolean> {
  return runtime.permissions.confirmMcpTool(fullName, () => {
    try {
      saveApproval(runtime.config.workdir, { action: fullName, resource: "*", effect: "allow" });
    } catch {
      // Persistence failure must not block the run.
    }
  });
}
