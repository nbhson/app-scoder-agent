#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { loadConfig } from "../config/config.js";
import { Agent } from "../agent.js";
import { listSessions, resolveSessionId } from "../session.js";
import { JsonlLogger } from "../logger.js";
import { collectUsage, formatCostReport } from "../cost.js";
import { getVersion as getPackageVersion } from "../shared/version.js";
import { selectableAgents } from "../agents.js";
import * as ui from "../ui.js";
import { parseArgs, HELP, type CliArgs } from "./args.js";
import { runOnce } from "./run-once.js";
import { runInit } from "./init.js";
import { repl } from "./repl.js";
import { runMcpCommand } from "./mcp-command.js";

// Single source of truth: read version from package.json (see src/version.ts).
const VERSION = getPackageVersion();

// Safety net: a stray promise rejection (e.g. a provider socket aborting after
// its consumer already moved on) must log — never hard-crash the agent.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  ui.warn(`background error (ignored): ${msg.slice(0, 200)}`);
});

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    ui.error((err as Error).message);
    process.exit(2);
  }

  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  if (args.noColor) process.env.NO_COLOR = "1";
  if (args.noMotion) process.env.SCODER_NO_MOTION = "1";
  if (args.plain) process.env.SCODER_PLAIN = "1";
  if (args.highContrast) process.env.SCODER_THEME = "high-contrast";

  const cfg = loadConfig({
    model: args.model,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    buildCmd: args.buildCmd ?? undefined,
    workdir: args.workdir ? resolve(args.workdir) : undefined,
    maxSteps: args.maxSteps,
    yes: args.yes,
    permissionMode: args.permission as "auto" | "ask" | "readonly" ?? undefined,
    provider: args.provider as "openai" | "anthropic" ?? undefined,
    noSave: args.noSave,
    logFile: args.logFile,
    agent: args.agent,
  });

  // v2: --agent must reference a selectable (mode primary|all) agent.
  if (args.agent) {
    const ok = selectableAgents(cfg.workdir).some((a) => a.name === args.agent);
    if (!ok) {
      ui.error(`unknown or non-primary agent "${args.agent}" — selectable: ${selectableAgents(cfg.workdir).map((a) => a.name).join(", ")}`);
      process.exit(2);
    }
  }

  // Subcommands
  if (args.subcommand === "init") {
    await runInit();
    return;
  }

  if (args.subcommand === "list") {
    const sessions = listSessions(cfg.workdir);
    if (sessions.length === 0) {
      console.log("No saved sessions in this directory.");
      return;
    }
    for (const s of sessions) {
      console.log(`${s.id}  steps=${String(s.steps).padStart(3)}  ${s.updatedAt}  ${s.task}`);
    }
    return;
  }

  if (args.subcommand === "resume") {
    const s = resolveSessionId(cfg.workdir, args.resumeId ?? "last");
    if (!s) {
      ui.error(`Session not found: ${args.resumeId ?? "last"}. Run \`scoder list\` to see saved sessions.`);
      process.exit(2);
    }
    const agent = new Agent(cfg);
    process.on("SIGINT", () => {
      ui.warn("\nSIGINT received — finishing current tool, then stopping...");
      agent.abort();
    });
    try {
      const result = await agent.resume(s, args.task ?? undefined);
      agent.dispose();
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      agent.dispose();
      ui.error((err as Error).message);
      process.exit(2);
    }
  }

  if (args.subcommand === "logs") {
    let id = args.logsId ?? "last";
    if (id === "last") {
      const sessions = listSessions(cfg.workdir);
      if (sessions.length === 0) {
        ui.error("No saved sessions in this directory. Run with --log-file to record logs.");
        process.exit(2);
      }
      id = sessions[0].id;
    }
    const events = JsonlLogger.read(cfg.workdir, id);
    if (events === null || events.length === 0) {
      ui.error(`No log found for session ${id}. Logs require --log-file (or SCODER_LOG_FILE=1).`);
      process.exit(2);
    }
    const filter = args.logsFilter?.toLowerCase();
    for (const ev of events) {
      const line = JSON.stringify(ev);
      if (filter && !line.toLowerCase().includes(filter)) continue;
      console.log(line);
    }
    return;
  }

  if (args.subcommand === "cost") {
    const sessionCosts = collectUsage(cfg.workdir, {
      sessionId: args.costSession,
      last: args.costLast,
      pricingOverrides: cfg.modelPricing,
    });
    console.log(formatCostReport(sessionCosts));
    return;
  }

  if (args.subcommand === "models") {
    const { loadCatalog, cacheAgeHours } = await import("../model-catalog.js");
    const filter = args.modelsProvider ?? null;
    const { models, source } = await loadCatalog(args.modelsRefresh === true);
    const age = cacheAgeHours();
    const ageStr = source === "fallback" ? "offline fallback snapshot" : age < 0 ? "?" : `${age.toFixed(1)}h ago`;
    console.log(`models catalog — source: ${source} (updated ${ageStr}), ${Object.keys(models).length} entries\n`);
    const rows = Object.values(models)
      .filter((m) => !filter || m.provider === filter || m.id.includes(filter))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
      .slice(0, 60);
    for (const m of rows) {
      const flags = [m.supportCache ? "cache" : null, m.supportReasoning ? "reasoning" : null].filter(Boolean).join(",");
      console.log(`  ${m.provider}/${m.id}  ctx=${(m.contextWindow / 1000).toFixed(0)}k${m.pricing ? `  $${m.pricing.input}/$${m.pricing.output} per 1M` : ""}${flags ? `  [${flags}]` : ""}`);
    }
    if (rows.length === 0) console.log(`  (no models match "${filter}")`);
    return;
  }

  if (args.subcommand === "mcp") {
    await runMcpCommand(cfg, args.mcpCmd ?? "list", args.mcpArgs ?? []);
    return;
  }

  if (args.subcommand === "tui") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      ui.warn("TUI requires an interactive terminal (TTY) — falling back to the classic REPL.");
      await repl(cfg);
      return;
    }
    if (!cfg.apiKey) {
      ui.warn("No API key configured — tasks will fail until SCODER_API_KEY (or OPENAI_API_KEY) is set.");
    }
    const { runTui } = await import("../tui/app.js");
    await runTui(cfg, args.task);
    return;
  }

  if (args.subcommand === "serve") {
    const { startServer } = await import("../server.js");
    if (!cfg.apiKey) {
      ui.warn("No API key configured — runs will fail until SCODER_API_KEY (or OPENAI_API_KEY) is set.");
    }
    const srv = await startServer(cfg, { host: args.serveHost, port: args.servePort });
    const token = process.env.SCODER_SERVER_TOKEN ? " · token auth" : "";
    ui.banner(`scoder serve @ http://${args.serveHost ?? "127.0.0.1"}:${srv.port}${token}`, [
      ["task", `POST /api/runs { "task": "..." } → 202 { id, eventsUrl }`],
      ["events", `GET /api/runs/<id>/events → SSE stream`],
      ["list", `GET /api/runs`],
      ["abort", `POST /api/runs/<id>/abort`],
      ["workdir", cfg.workdir],
      ["model", `${cfg.model}  ·  permission ${cfg.permissionMode}`],
    ]);
    const shutdown = async () => {
      ui.info("shutting down server...");
      await srv.close();
      process.exit(0);
    };
    process.on("SIGINT", () => {
      ui.warn("\nSIGINT — shutting down server, aborting in-flight runs...");
      void shutdown();
    });
    return;
  }

  if (args.task) {
    const code = await runOnce(cfg, args.task);
    process.exit(code);
  }

  await repl(cfg);
}

export { main };
