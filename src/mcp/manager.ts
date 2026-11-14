import { redactSecrets, type ToolSpec } from "../llm/llm.js";
import type { McpConnState, McpPrompt, McpResource, McpResourceTemplate, McpServerConfig, McpTool } from "./types.js";
import { MCP_RESOURCE_TOOL_NAMES, mcpToolKey } from "./types.js";
import { filterToolNames } from "./tool-filter.js";
import { McpConnection } from "./connection.js";

const schemaObj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const strProp = (description: string) => ({ type: "string", description });
const boolProp = (description: string) => ({ type: "boolean", description });

// ── Manager: multi-server registry ─────────────────────────────────────────

export interface RegisteredMcpTool {
  conn: McpConnection;
  serverName: string;
  toolName: string;
  def: McpTool;
}

export class McpManager {
  private conns = new Map<string, McpConnection>();
  private tools = new Map<string, RegisteredMcpTool>();
  /** Status sink (default console.error; the TUI routes it to a notice). */
  onStatus: ((line: string) => void) | null = null;
  /** Sidebar TUI: máy trạng thái per-server (connecting/ready/reconnecting/dead). */
  onServerState: ((name: string, state: McpConnState, detail: string) => void) | null = null;
  /** Phase 4: server-pushed resource updates (after resources/subscribe). */
  onResourceUpdated: ((server: string, uri: string) => void) | null = null;
  /** Phase 4: progress notifications from long-running MCP tool calls. */
  onProgress: ((server: string, params: Record<string, unknown>) => void) | null = null;
  /** Phase 4: per-server resource/template cache (refreshed on list_changed). */
  private resources = new Map<string, { resources: McpResource[]; templates: McpResourceTemplate[] }>();
  /** Phase 4: per-server prompt cache. */
  private prompts = new Map<string, McpPrompt[]>();
  /** Phase 4: URIs subscribed per server. */
  private subscriptions = new Map<string, Set<string>>();

  constructor(private configs: Record<string, McpServerConfig>) {}

  /** Connect all servers; skip failures with a warning. Returns discovered tool count. */
  async connectAll(): Promise<number> {
    const report = this.onStatus ?? ((line: string) => console.error(line));
    await Promise.allSettled(
      Object.entries(this.configs).map(async ([name, cfg]) => {
        // MCP B: `enabled:false` and `trust:"readonly"` servers are NOT spawned —
        // readonly mode must never start an external process. Report them as
        // skipped so /mcp can still list them.
        if (cfg.enabled === false || cfg.trust === "readonly") {
          if (cfg.enabled === false) report(`· MCP "${name}" skipped (enabled: false)`);
          else report(`· MCP "${name}" skipped (trust: readonly — not spawned)`);
          this.onServerState?.(name, "disabled", cfg.enabled === false ? "enabled:false" : "trust:readonly");
          return;
        }
        const conn = new McpConnection(name, cfg);
        this.wireReconnect(name, conn);
        await conn.connect();
        await this.registerTools(name, conn);
        await this.refreshResources(name, conn);
        await this.refreshPrompts(name, conn);
        this.conns.set(name, conn);
      }),
    ).then((results) => {
      results.forEach((r, i) => {
        const name = Object.keys(this.configs)[i];
        const cfg = this.configs[name];
        if (cfg?.enabled === false || cfg?.trust === "readonly") return; // already reported as skipped
        if (r.status === "rejected") {
          this.onServerState?.(name, "dead", "connect failed");
          report(`⚠  MCP server "${name}" unavailable: ${String((r.reason as Error)?.message).slice(0, 160)}`);
        } else {
          const n = [...this.tools.values()].filter((t) => t.serverName === name).length;
          report(`✓ MCP "${name}" connected — ${n} tool${n === 1 ? "" : "s"}`);
        }
      });
    });
    return this.tools.size;
  }

  /** M1: surface connection state machine + refresh tools sau reconnect + wire notifications. */
  private wireReconnect(name: string, conn: McpConnection): void {
    conn.onState = (state, detail) => {
      // Sidebar TUI: structured state trước — mọi transition đều thú vị với
      // map mcpServers, còn chat notice chỉ với reconnect/dead/ready (dưới).
      this.onServerState?.(name, state, detail);
      const report = this.onStatus ?? ((line: string) => console.error(line));
      if (state === "reconnecting") report(`⚠  MCP "${name}" ${detail}`);
      if (state === "dead") report(`✘ MCP "${name}" dead: ${detail}`);
      if (state === "ready" && detail === "reconnected") {
        report(`✓ MCP "${name}" reconnected`);
        // Refresh tool + resource + prompt lists — the server may have changed.
        conn
          .listTools()
          .then((defs) => this.reregisterTools(name, conn, defs))
          .catch(() => {});
        void this.refreshResources(name, conn).catch(() => {});
        void this.refreshPrompts(name, conn).catch(() => {});
        for (const uri of this.subscriptions.get(name) ?? []) {
          void conn.subscribeResource(uri).catch(() => {});
        }
      }
    };
    // MCP A: react to server notifications — tools/list_changed re-registers
    // the tool set (no full reconnect needed); progress/message are surfaced
    // as status lines but don't disrupt anything.
    conn.onNotification = (msg) => {
      const method = String(msg.method ?? "");
      const report = this.onStatus ?? ((line: string) => console.error(line));
      const params = (msg.params ?? {}) as Record<string, unknown>;
      if (method === "notifications/tools/list_changed" || method === "tools/list_changed") {
        conn
          .listTools()
          .then((defs) => {
            this.reregisterTools(name, conn, defs);
            report(`↻ MCP "${name}" tools changed — re-registered ${defs.length}`);
          })
          .catch(() => {});
      } else if (method === "notifications/resources/list_changed" || method === "resources/list_changed") {
        void this.refreshResources(name, conn).then(() => {
          const n = this.resources.get(name)?.resources.length ?? 0;
          report(`↻ MCP "${name}" resources changed — ${n} resource${n === 1 ? "" : "s"}`);
        });
      } else if (method === "notifications/prompts/list_changed" || method === "prompts/list_changed") {
        void this.refreshPrompts(name, conn).then(() => {
          const n = this.prompts.get(name)?.length ?? 0;
          report(`↻ MCP "${name}" prompts changed — ${n} prompt${n === 1 ? "" : "s"}`);
        });
      } else if (method === "notifications/resources/updated" || method === "resources/updated") {
        const uri = typeof params.uri === "string" ? params.uri : "";
        if (uri) {
          this.onResourceUpdated?.(name, uri);
          report(`↻ MCP "${name}" resource updated: ${uri}`);
        }
      } else if (method === "notifications/progress" || method === "progress") {
        // Long-running tool progress — forwarded to the UI hook (no chat spam).
        this.onProgress?.(name, params);
      } else if (method === "notifications/message" || method === "message") {
        report(`ℹ MCP "${name}": ${String(params.message ?? "message")}`);
      }
    };
  }

  private async registerTools(name: string, conn: McpConnection): Promise<void> {
    const defs = await conn.listTools();
    this.reregisterTools(name, conn, defs);
  }

  /** Phase 4: cache resources + templates when the server advertises them. */
  private async refreshResources(name: string, conn: McpConnection): Promise<void> {
    if (conn.capabilities.resources == null) {
      this.resources.delete(name);
      return;
    }
    let resources: McpResource[] = [];
    let templates: McpResourceTemplate[] = [];
    try { resources = await conn.listResources(); } catch { /* optional method */ }
    try { templates = await conn.listResourceTemplates(); } catch { /* optional method */ }
    this.resources.set(name, { resources, templates });
  }

  /** Phase 4: cache prompts when the server advertises them. */
  private async refreshPrompts(name: string, conn: McpConnection): Promise<void> {
    if (conn.capabilities.prompts == null) {
      this.prompts.delete(name);
      return;
    }
    try { this.prompts.set(name, await conn.listPrompts()); } catch { /* optional method */ }
  }

  /** MCP A: apply per-server tool include/exclude filters to a tool list. */
  private filterToolDefs(name: string, defs: McpTool[]): McpTool[] {
    // P0-3: matcher dùng chung với bộ lọc toàn cục rc "mcpTools" (tool-filter.ts).
    return filterToolNames(defs, (t) => t.name, this.configs[name]?.tools);
  }

  /** Replace một server's tool registrations (reconnect refresh) — honor config filters. */
  private reregisterTools(name: string, conn: McpConnection, defs: McpTool[]): void {
    for (const [key, t] of [...this.tools]) {
      if (t.serverName === name) this.tools.delete(key);
    }
    for (const def of this.filterToolDefs(name, defs)) {
      const key = mcpToolKey(name, def.name);
      this.tools.set(key, { conn, serverName: name, toolName: def.name, def });
    }
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** Per-server tool listing (for /mcp status display). */
  listToolsByServer(): Array<{ server: string; tools: McpTool[] }> {
    const map = new Map<string, McpTool[]>();
    for (const t of this.tools.values()) {
      const arr = map.get(t.serverName) ?? [];
      arr.push({ name: t.toolName, description: t.def.description, inputSchema: t.def.inputSchema });
      map.set(t.serverName, arr);
    }
    return [...map.entries()].map(([server, tools]) => ({ server, tools }));
  }

  getTool(name: string): RegisteredMcpTool | undefined {
    return this.tools.get(name);
  }

  /** MCP A: connection state + metadata for /mcp status display.
   *  connected is based on McpConnection.state, not tool count. */
  serverStates(): Array<{
    name: string;
    state: McpConnState;
    serverInfo: { name?: string; version?: string };
    capabilities: Record<string, unknown>;
    instructions: string | null;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  }> {
    return [...this.conns.entries()].map(([name, conn]) => ({
      name,
      state: conn.state,
      serverInfo: conn.serverInfo,
      capabilities: conn.capabilities,
      instructions: conn.instructions,
      toolCount: [...this.tools.values()].filter((t) => t.serverName === name).length,
      resourceCount: this.resources.get(name)?.resources.length ?? 0,
      promptCount: this.prompts.get(name)?.length ?? 0,
    }));
  }

  /** Phase 4: cached resources + templates per server. */
  listResourcesByServer(): Array<{ server: string; resources: McpResource[]; templates: McpResourceTemplate[] }> {
    return [...this.resources.entries()].map(([server, r]) => ({ server, ...r }));
  }

  /** Phase 4: cached prompts per server. */
  listPromptsByServer(): Array<{ server: string; prompts: McpPrompt[] }> {
    return [...this.prompts.entries()].map(([server, prompts]) => ({ server, prompts }));
  }

  hasResources(): boolean {
    return this.resources.size > 0;
  }

  hasPrompts(): boolean {
    return this.prompts.size > 0;
  }

  /** Phase 4: read a resource; optionally subscribe to its update notifications. */
  async readResource(
    server: string,
    uri: string,
    opts: { subscribe?: boolean } = {},
  ): Promise<{ ok: boolean; output: string }> {
    const conn = this.conns.get(server);
    if (!conn) return { ok: false, output: `ERROR: MCP server "${server}" is not connected.` };
    try {
      const res = await conn.readResource(uri);
      if (opts.subscribe) {
        try {
          await conn.subscribeResource(uri);
          const set = this.subscriptions.get(server) ?? new Set<string>();
          set.add(uri);
          this.subscriptions.set(server, set);
        } catch {
          // Subscription is best-effort; the read itself already succeeded.
        }
      }
      const parts = res.contents.map((c) => {
        if (typeof c.text === "string") return c.text;
        if (typeof c.blob === "string") {
          return `[binary ${c.mimeType ?? "application/octet-stream"} — ${c.blob.length} base64 chars]`;
        }
        return "";
      }).filter(Boolean);
      return { ok: true, output: redactSecrets(parts.join("\n")) || "(empty resource)" };
    } catch (err) {
      return { ok: false, output: `ERROR: resources/read failed: ${(err as Error).message}` };
    }
  }

  /** Phase 4: render a server prompt template into text messages. */
  async getPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<{ ok: boolean; output: string }> {
    const conn = this.conns.get(server);
    if (!conn) return { ok: false, output: `ERROR: MCP server "${server}" is not connected.` };
    try {
      const res = await conn.getPrompt(name, args);
      const msgs = res.messages.map((m) => {
        const content = m.content as { type?: string; text?: string } | undefined;
        const text = content && content.type === "text" && typeof content.text === "string"
          ? content.text
          : JSON.stringify(m.content);
        return `[${m.role ?? "user"}] ${text}`;
      });
      const header = res.description ? `${res.description}\n\n` : "";
      return { ok: true, output: redactSecrets(header + (msgs.join("\n\n") || "(empty prompt)")) };
    } catch (err) {
      return { ok: false, output: `ERROR: prompts/get failed: ${(err as Error).message}` };
    }
  }

  /** Phase 4: true when `name` is a generic resource/prompt tool. */
  isResourceTool(name: string): boolean {
    return MCP_RESOURCE_TOOL_NAMES.has(name);
  }

  /** Phase 4: specs for resource/prompt tools — advertised only when available. */
  resourceToolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    if (this.hasResources()) {
      specs.push({
        type: "function",
        function: {
          name: "mcp_list_resources",
          description:
            "List MCP resources and resource templates exposed by connected servers. " +
            "Use before mcp_read_resource when you don't know the URI.",
          parameters: schemaObj({ server: strProp("Optional server name — omit to list all servers") }, []),
        },
      });
      specs.push({
        type: "function",
        function: {
          name: "mcp_read_resource",
          description:
            "Read one MCP resource by URI (resources/read). Pass subscribe=true to receive " +
            "resources/updated notifications for that URI.",
          parameters: schemaObj(
            {
              server: strProp("Server name that owns the resource"),
              uri: strProp("Resource URI (from mcp_list_resources or a resource template)"),
              subscribe: boolProp("Subscribe to updates for this URI (default: false)"),
            },
            ["server", "uri"],
          ),
        },
      });
    }
    if (this.hasPrompts()) {
      specs.push({
        type: "function",
        function: {
          name: "mcp_list_prompts",
          description: "List prompt templates exposed by connected MCP servers.",
          parameters: schemaObj({ server: strProp("Optional server name — omit to list all servers") }, []),
        },
      });
      specs.push({
        type: "function",
        function: {
          name: "mcp_get_prompt",
          description: "Render one MCP prompt template (prompts/get) into text messages.",
          parameters: schemaObj(
            {
              server: strProp("Server name that owns the prompt"),
              name: strProp("Prompt name (from mcp_list_prompts)"),
              arguments: {
                type: "object",
                description: "Prompt arguments (string values)",
                additionalProperties: { type: "string" },
              },
            },
            ["server", "name"],
          ),
        },
      });
    }
    return specs;
  }

  /** Phase 4: dispatch a generic resource/prompt tool call. */
  async invokeResourceTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
    switch (name) {
      case "mcp_list_resources": {
        const server = typeof args.server === "string" ? args.server : undefined;
        const rows = this.listResourcesByServer().filter((r) => !server || r.server === server);
        if (rows.length === 0) return { ok: true, output: "(no MCP resources)" };
        return {
          ok: true,
          output: rows.map(({ server: s, resources, templates }) => {
            const lines = [`## ${s}`];
            for (const r of resources) {
              lines.push(`- ${r.uri}${r.name ? ` — ${r.name}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}`);
            }
            for (const t of templates) {
              lines.push(`- template: ${t.uriTemplate}${t.name ? ` — ${t.name}` : ""}`);
            }
            return lines.join("\n");
          }).join("\n\n"),
        };
      }
      case "mcp_read_resource": {
        const server = typeof args.server === "string" ? args.server : "";
        const uri = typeof args.uri === "string" ? args.uri : "";
        if (!server || !uri) return { ok: false, output: "ERROR: mcp_read_resource requires server and uri." };
        return this.readResource(server, uri, { subscribe: args.subscribe === true });
      }
      case "mcp_list_prompts": {
        const server = typeof args.server === "string" ? args.server : undefined;
        const rows = this.listPromptsByServer().filter((r) => !server || r.server === server);
        if (rows.length === 0) return { ok: true, output: "(no MCP prompts)" };
        return {
          ok: true,
          output: rows.map(({ server: s, prompts }) => {
            const lines = [`## ${s}`];
            for (const p of prompts) {
              const params = (p.arguments ?? []).map((a) => `${a.name}${a.required ? "" : "?"}`).join(", ");
              lines.push(`- ${p.name}${params ? ` (${params})` : ""}${p.description ? ` — ${p.description}` : ""}`);
            }
            return lines.join("\n");
          }).join("\n\n"),
        };
      }
      case "mcp_get_prompt": {
        const server = typeof args.server === "string" ? args.server : "";
        const promptName = typeof args.name === "string" ? args.name : "";
        if (!server || !promptName) return { ok: false, output: "ERROR: mcp_get_prompt requires server and name." };
        const rawArgs = args.arguments;
        const promptArgs: Record<string, string> = {};
        if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          for (const [k, v] of Object.entries(rawArgs as Record<string, unknown>)) {
            if (typeof v === "string") promptArgs[k] = v;
          }
        }
        return this.getPrompt(server, promptName, promptArgs);
      }
      default:
        return { ok: false, output: `ERROR: unknown MCP resource tool "${name}".` };
    }
  }

  /** Convert all discovered MCP tools to OpenAI function-calling specs. */
  toToolSpecs(): import("../llm/llm.js").ToolSpec[] {
    return [...this.tools.values()].map(({ conn: _, serverName, toolName, def }) => ({
      type: "function" as const,
      function: {
        name: mcpToolKey(serverName, toolName),
        description: def.description ?? `MCP tool "${toolName}" from server "${serverName}"`,
        parameters: def.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }

  killAll(): void {
    for (const c of this.conns.values()) c.kill();
    this.conns.clear();
    this.tools.clear();
    this.resources.clear();
    this.prompts.clear();
    this.subscriptions.clear();
  }

  /** M4: config hot-reload — connect server mới, kill server đã bị xóa/changed khỏi config. */
  async applyConfig(configs: Record<string, McpServerConfig>): Promise<void> {
    const report = this.onStatus ?? ((line: string) => console.error(line));
    // A server's transport-effective config changed → restart it (kill + reconnect).
    const configChanged = (prev: McpServerConfig, next: McpServerConfig): boolean => {
      const pick = (c: McpServerConfig) =>
        JSON.stringify([c.command, c.url, c.type, c.args, c.env ?? {}, c.headers ?? {}, c.timeoutMs ?? null, c.tools ?? {}, c.enabled ?? true, c.trust ?? "auto"]);
      return pick(prev) !== pick(next);
    };
    // Server bị xóa hoặc đổi config → kill + unregister.
    for (const [name, conn] of [...this.conns]) {
      if (!configs[name] || configChanged(this.configs[name], configs[name])) {
        conn.kill();
        this.conns.delete(name);
        for (const [key, t] of [...this.tools]) {
          if (t.serverName === name) this.tools.delete(key);
        }
        this.resources.delete(name);
        this.prompts.delete(name);
        this.subscriptions.delete(name);
        if (configs[name] && configChanged(this.configs[name], configs[name])) {
          report(`↻ MCP "${name}" config changed — restarting`);
        } else {
          report(`✘ MCP "${name}" removed (config changed)`);
        }
      }
    }
    this.configs = configs;
    // Server mới → connect (except enabled:false / trust:readonly — never spawn).
    for (const [name, cfg] of Object.entries(configs)) {
      if (this.conns.has(name)) continue;
      if (cfg.enabled === false || cfg.trust === "readonly") {
        this.onServerState?.(name, "disabled", cfg.enabled === false ? "enabled:false" : "trust:readonly");
        report(`· MCP "${name}" skipped (${cfg.enabled === false ? "enabled: false" : "trust: readonly — not spawned"})`);
        continue;
      }
      const conn = new McpConnection(name, cfg);
      this.wireReconnect(name, conn);
      try {
        await conn.connect();
        await this.registerTools(name, conn);
        await this.refreshResources(name, conn);
        await this.refreshPrompts(name, conn);
        this.conns.set(name, conn);
        const n = [...this.tools.values()].filter((t) => t.serverName === name).length;
        report(`✓ MCP "${name}" connected — ${n} tool${n === 1 ? "" : "s"} (hot-reload)`);
      } catch (e) {
        report(`⚠  MCP server "${name}" unavailable: ${String((e as Error).message).slice(0, 160)}`);
      }
    }
  }
}
