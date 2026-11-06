/** `scoder mcp <list|add|remove|test|import>` subcommand. */
import type { AgentConfig } from "../config/config.js";
import type {McpServerConfig} from "../mcp/types.js";

export async function runMcpCommand(cfg: AgentConfig, cmd: "list" | "add" | "remove" | "test" | "import", restArgs: string[]): Promise<void> {
  const { McpManager } = await import("../mcp/manager.js");
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const rcPath = join(cfg.workdir, ".scoderrc.json");

  // Load existing mcpServers from workdir rc.
  const existing: Record<string, McpServerConfig> = {};
  if (existsSync(rcPath)) {
    try { Object.assign(existing, JSON.parse(readFileSync(rcPath, "utf8")).mcpServers ?? {}); } catch { /* ignore */ }
  }

  if (cmd === "list") {
    const servers = Object.entries(cfg.mcpServers ?? existing);
    if (servers.length === 0) {
      console.log("no MCP servers configured — add mcpServers to .scoderrc.json");
      return;
    }
    for (const [name, cfg_srv] of servers) {
      const trust = cfg_srv.trust ?? "auto";
      const enabled = cfg_srv.enabled === false ? " (disabled)" : "";
      const target = cfg_srv.url ?? cfg_srv.command ?? "?";
      console.log(`${name}: ${target}${trust !== "auto" ? ` [${trust}]` : ""}${enabled}`);
    }
    return;
  }

  if (cmd === "add") {
    // scoder mcp add <name> --command "..." [--url "..."] [--trust auto|ask|readonly|deny]
    const name = restArgs[0];
    if (!name) { console.error("usage: scoder mcp add <name> --command '...' [--url '...'] [--trust readonly]"); return; }
    const opts: Record<string, string> = {};
    for (let i = 1; i < restArgs.length; i++) {
      if (restArgs[i] === "--command" || restArgs[i] === "-c") opts.command = restArgs[++i];
      else if (restArgs[i] === "--url" || restArgs[i] === "-u") opts.url = restArgs[++i];
      else if (restArgs[i] === "--trust" || restArgs[i] === "-t") opts.trust = restArgs[++i];
      else if (restArgs[i] === "--args" || restArgs[i] === "-a") opts.args = restArgs[++i];
    }
    if (!opts.command && !opts.url) { console.error("error: --command or --url required"); return; }
    const newEntry: McpServerConfig = { ...(opts.command ? { command: opts.command } : {}), ...(opts.url ? { url: opts.url } : {}), ...(opts.args ? { args: opts.args.split(" ") } : {}), ...(opts.trust ? { trust: opts.trust as McpServerConfig["trust"] } : {}) };
    const allServers = { ...existing, [name]: newEntry };
    const rc = existsSync(rcPath) ? JSON.parse(readFileSync(rcPath, "utf8")) : {};
    mkdirSync(dirname(rcPath) || ".", { recursive: true });
    writeFileSync(rcPath, JSON.stringify({ ...rc, mcpServers: allServers }, null, 2) + "\n", "utf8");
    console.log(`MCP server "${name}" added to ${rcPath}`);
    return;
  }

  if (cmd === "remove") {
    const name = restArgs[0];
    if (!name) { console.error("usage: scoder mcp remove <name>"); return; }
    if (!existing[name] && !(cfg.mcpServers ?? {})[name]) { console.error(`MCP server "${name}" not found in config`); return; }
    const allServers = { ...existing };
    delete allServers[name];
    const rc = existsSync(rcPath) ? JSON.parse(readFileSync(rcPath, "utf8")) : {};
    mkdirSync(dirname(rcPath) || ".", { recursive: true });
    writeFileSync(rcPath, JSON.stringify({ ...rc, mcpServers: allServers }, null, 2) + "\n", "utf8");
    console.log(`MCP server "${name}" removed from ${rcPath}`);
    return;
  }

  if (cmd === "test") {
    const name = restArgs[0];
    if (!name) { console.error("usage: scoder mcp test <name>"); return; }
    const srvCfg = (cfg.mcpServers ?? {})[name] ?? existing[name];
    if (!srvCfg) { console.error(`MCP server "${name}" not found`); return; }
    if (srvCfg.enabled === false) { console.log(`✘ "${name}" is disabled (enabled:false)`); return; }
    if (srvCfg.trust === "readonly") { console.log(`✘ "${name}" is trust:readonly — not spawning`); return; }
    console.log(`connecting to "${name}"...`);
    const m = new McpManager({ [name]: srvCfg });
    try {
      await m.connectAll();
      const states = m.serverStates();
      const s = states[0];
      if (s?.state === "ready") {
        console.log(`✓ "${name}" connected — ${s.toolCount} tools`);
        console.log(`  serverInfo: ${s.serverInfo.name ?? "?"} v${s.serverInfo.version ?? "?"}`);
        console.log(`  capabilities: ${Object.keys(s.capabilities).join(", ") || "(none)"}`);
      } else {
        console.log(`✘ "${name}" failed to connect (state: ${s?.state})`);
      }
    } finally {
      m.killAll();
    }
    return;
  }

  if (cmd === "import") {
    // scoder mcp import [path] [--dry-run] [--force]
    const { loadConfigFile, discoverConfigs, mergeConfigs } = await import("../mcp/mcp-import.js");
    const dryRun = restArgs.includes("--dry-run");
    const force = restArgs.includes("--force");
    const paths = restArgs.filter((a) => !a.startsWith("--"));

    let discovered: Awaited<ReturnType<typeof discoverConfigs>> = [];
    try { discovered = discoverConfigs(); } catch { /* ignore */ }

    if (paths.length === 0 && discovered.length === 0) {
      console.log("No config files found. Provide a path or ensure one of these exists:");
      console.log("  ~/.claude/config.json  — Claude Desktop MCP servers");
      console.log("  opencode.json         — OpenCode MCP config");
      console.log("  .mcp.json             — standard MCP server list");
      console.log("\nUsage: scoder mcp import [path] [--dry-run] [--force]");
      return;
    }

    // Auto-discover when no path given
    const toCheck: string[] = paths.length > 0 ? paths : discovered.map((d) => d.source);
    if (paths.length === 0 && discovered.length > 0) {
      console.log("Auto-discovered MCP config files:");
      for (const d of discovered) {
        console.log(`  ${d.format}: ${d.source} (${d.serverCount} server${d.serverCount === 1 ? "" : "s"})`);
      }
      console.log();
    }

    const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");

    let totalAdded = 0;
    let totalSkipped = 0;
    for (const srcPath of toCheck) {
      const servers = loadConfigFile(srcPath);
      if (!servers) { console.log(`  skip: ${srcPath} not found`); continue; }
      const { added, skipped } = mergeConfigs(existing, servers, { force, dryRun });
      totalAdded += added.length;
      totalSkipped += skipped.length;
      console.log(`${srcPath}:`);
      for (const s of added) {
        const target = s.config.url ?? s.config.command ?? "?";
        console.log(`  + ${s.name}: ${target} (from ${s.originalKey})`);
      }
      for (const s of skipped) {
        console.log(`  ~ ${s.name}: skipped (already exists; use --force to overwrite)`);
      }
      if (added.length === 0 && skipped.length === 0) {
        console.log(`    (no servers found)`);
      }
    }

    if (dryRun) {
      console.log(`\n[DRY RUN] Would import ${totalAdded} server${totalAdded === 1 ? "" : "s"} (${totalSkipped} skipped).`);
      return;
    }

    if (totalAdded > 0) {
      const rc = existsSync(rcPath) ? JSON.parse(readFileSync(rcPath, "utf8")) : {};
      mkdirSync(dirname(rcPath) || ".", { recursive: true });
      writeFileSync(rcPath, JSON.stringify({ ...rc, mcpServers: existing }, null, 2) + "\n", "utf8");
      console.log(`\nImported ${totalAdded} server${totalAdded === 1 ? "" : "s"} into ${rcPath} (${totalSkipped} skipped).`);
    } else {
      console.log(`\nNothing to import.`);
    }
    return;
  }

  console.error(`unknown mcp command: ${cmd}`);
}

