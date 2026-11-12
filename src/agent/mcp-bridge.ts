import { saveApproval } from "../config/config.js";
import { redactSecrets, type ToolSpec } from "../llm/llm.js";
import { clamp } from "../tools/path-safety.js";
import {allToolSpecs} from "../tools/registry.js";
import { applyToolFilter } from "./types.js";
import { filterToolNames } from "../mcp/tool-filter.js";
import { estimateSchemaTokens } from "../context/compaction.js";
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

let schemaCapWarned = new Set<string>();

/** Trần schema không bao giờ siết xuống dưới mức này (còn ~3 tool nhỏ). */
const MIN_SCHEMA_CAP_TOKENS = 1_200;
/**
 * P0-3+: tỷ lệ window dành cho TOÀN BỘ tool schema (builtin + MCP). Đo trên
 * máy thật (llama.cpp -c 16384, 37 tools): chi phí schema THẬT 10.305 token
 * = 64% window → history chỉ còn dăm nghìn token, trim liên tục và mỗi lần
 * trim phá một KV-cache. 35% là mức để history + reply còn đất thở; window
 * lớn (≥64k) thì con số này thường không binding nên trần cứng trong rc vẫn
 * thắng.
 */
export const SCHEMA_SHARE_OF_WINDOW = 0.35;

/**
 * Trần MCP hiệu dụng = min(trần rc khai báo, 35% window − phần builtin).
 * 0 = tắt trần (tôn trọng ý người dùng).
 */
export function effectiveMcpSchemaCap(declaredCap: number, contextWindow: number, builtinTokens: number): number {
  if (declaredCap <= 0) return 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return declaredCap;
  const share = Math.floor(contextWindow * SCHEMA_SHARE_OF_WINDOW) - builtinTokens;
  if (share >= declaredCap) return declaredCap;
  return Math.max(MIN_SCHEMA_CAP_TOKENS, share);
}

/**
 * P0-3 (RC-2): trần token cho toàn bộ MCP schema gửi mỗi lượt.
 *
 * Tool schema là chi phí CỐ ĐỊNH: session baseline của plan
 * performance-issue.md trả ~20.300 token schema cho một câu "chào" (53 tool
 * MCP ≈ 14.000 token). Vượt trần → giữ theo thứ tự khai báo đến khi hết
 * ngân sách, phần còn lại không được quảng cáo (model vẫn gọi được tool đã
 * giữ; tool bị bỏ sẽ nhận "not available" — kèm danh sách thay thế).
 * Mặc định 0 = tắt (không đổi hành vi cũ); local profile bật 6.000.
 * Trần áp dụng trên thực tế có thể thấp hơn — xem `effectiveMcpSchemaCap`.
 */
export function capMcpSchemaTokens(specs: ToolSpec[], capTokens: number, report: (line: string) => void): ToolSpec[] {
  if (capTokens <= 0 || specs.length === 0) return specs;
  const total = estimateSchemaTokens(specs);
  if (total <= capTokens) return specs;
  const kept: ToolSpec[] = [];
  let used = 0;
  for (const spec of specs) {
    const cost = estimateSchemaTokens([spec]);
    if (used + cost > capTokens) continue;
    kept.push(spec);
    used += cost;
  }
  const dropped = specs.length - kept.length;
  // Warn một lần cho mỗi (trần, số tool bị bỏ) — đổi server/model thì báo lại.
  const signature = `${capTokens}:${dropped}`;
  if (dropped > 0 && !schemaCapWarned.has(signature)) {
    schemaCapWarned.add(signature);
    if (schemaCapWarned.size > 8) schemaCapWarned = new Set([signature]);
    report(
      `MCP tool schema ${total} token > trần ${capTokens} (limits.mcpSchemaTokens) — bỏ quảng cáo ${dropped} tool, giữ ${kept.length} (${used} token). ` +
      `Cần tool nào, ghi rõ trong rc: "mcpTools": {"include":["mcp__server__tool"]} hoặc "mcpServers.<server>.tools.include", hoặc đặt "limits": {"mcpSchemaTokens": 0} để tắt trần.`,
    );
  }
  return kept;
}

/**
 * P0-3: toàn bộ phần quản trị MCP tool specs — allowlist toàn cục (rc
 * "mcpTools") rồi tới trần schema (`limits.mcpSchemaTokens`); người dùng chọn
 * tường minh luôn thắng heuristic.
 *
 * Hàm này DÙNG CHUNG cho `rebuildToolList()` và `Agent.run()`: khi MCP đã
 * kết nối sẵn, `connectMcp()` return sớm và run() tự ghép tools — nếu chỗ đó
 * lấy raw specs thì trần schema bị bỏ qua (model lại nhận 53 tool như cũ).
 */
export function governedMcpSpecs(runtime: McpBridgeRuntime): ToolSpec[] {
  const manager = runtime.getMcp();
  const specs = manager ? [...manager.toToolSpecs(), ...manager.resourceToolSpecs()] : [];
  const declared = runtime.config.limits?.mcpSchemaTokens ?? 0;
  // Window THẬT (rc `contextWindow` hoặc probe P1-1) siết trần mạnh hơn trần
  // cứng khi server nhỏ — xem comment SCHEMA_SHARE_OF_WINDOW.
  const window = runtime.config.contextWindow ?? 0;
  const builtinTokens = estimateSchemaTokens(allToolSpecs());
  const cap = effectiveMcpSchemaCap(declared, window, builtinTokens);
  if (declared > 0 && cap < declared) {
    const signature = `share:${window}:${cap}`;
    if (!schemaCapWarned.has(signature)) {
      schemaCapWarned.add(signature);
      runtime.reporter.warn(
        `context window ${window} token: trần MCP schema hạ từ ${declared} → ${cap} token ` +
          `(35% window trừ ${builtinTokens} token builtin — giới hạn "SCHEMA_SHARE_OF_WINDOW", ` +
          `đặt "limits": {"mcpSchemaTokens": 0} để tắt trần).`,
      );
    }
  }
  return capMcpSchemaTokens(
    filterToolNames(specs, (spec) => spec.function.name, runtime.config.mcpTools),
    cap,
    (line) => runtime.reporter.warn(line),
  );
}

export function rebuildToolList(runtime: McpBridgeRuntime): void {
  const governed = governedMcpSpecs(runtime);
  let base = applyToolFilter(allToolSpecs(), runtime.primaryDef, runtime.reporter);
  if (runtime.pendingAllowedTools && runtime.pendingAllowedTools.length > 0) {
    const allow = new Set(runtime.pendingAllowedTools.map((tool) => tool.toLowerCase()));
    base = base.filter((spec) => allow.has(spec.function.name.toLowerCase()));
    runtime.setTools([...base, ...governed.filter((spec) => allow.has(spec.function.name.toLowerCase()))]);
  } else {
    runtime.setTools([...base, ...governed]);
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
    // P0-2: dùng trần cấu hình được (limits.maxOutputChars) thay vì 20k cứng.
    output: clamp(result.output),
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
