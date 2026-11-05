#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { loadConfig, type AgentConfig } from "./config.js";
import { Agent } from "./agent.js";
import { listSessions, resolveSessionId, pruneSessions } from "./session.js";
import { JsonlLogger } from "./logger.js";
import { collectUsage, formatCostReport } from "./cost.js";
import { getVersion as getPackageVersion } from "./version.js";
import { dispatchCommand, type CommandHost } from "./tui/command-registry.js";
import { selectableAgents } from "./agents.js";
import * as ui from "./ui.js";

// Single source of truth: read version from package.json (see src/version.ts).
const VERSION = getPackageVersion();

// Safety net: a stray promise rejection (e.g. a provider socket aborting after
// its consumer already moved on) must log — never hard-crash the agent.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  ui.warn(`background error (ignored): ${msg.slice(0, 200)}`);
});

interface CliArgs {
  task: string | null;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  buildCmd?: string;
  workdir?: string;
  maxSteps?: number;
  yes: boolean;
  agent?: string;
  permission?: string;
  provider?: string;
  noSave?: boolean;
  logFile?: boolean;
  subcommand?: "list" | "resume" | "logs" | "cost" | "serve" | "tui" | "init" | "models";
  resumeId?: string;
  logsId?: string;
  logsFilter?: string;
  costSession?: string;
  modelsProvider?: string;
  modelsRefresh?: boolean;
  costLast?: number;
  serveHost?: string;
  servePort?: number;
  help: boolean;
  version: boolean;
}

const HELP = `scoder — autonomous coding agent CLI

USAGE
  scoder [options] "<task>"        Run a task autonomously until the build passes
  scoder                           Start interactive session (chat + tools)
  scoder tui [task]                Full-screen terminal UI (chat pane, live tool feed)
  scoder init                      First-run wizard: writes .scoderrc.json + tests the connection
  scoder list                      List saved sessions for this directory
  scoder models [provider] [--refresh]
                                    Model catalog (context window, pricing) —
                                    synced from models.dev, cached 24h
  scoder resume <id|last> [task]   Resume a saved session (optionally with a follow-up task)
  scoder logs [id|last] [filter]   Print a session's JSONL log (requires --log-file runs)
  scoder cost [--session <id>] [--last <n>]
                                    Token usage & estimated cost from JSONL logs
  scoder serve [--port <n>] [--host <addr>]
                                    Run as an HTTP server: POST tasks, stream
                                    progress via Server-Sent Events (see below)
  scoder --version | --help

OPTIONS
  -m, --model <name>        LLM model (env SCODER_MODEL / OPENAI_MODEL, default gpt-4o-mini)
  --base-url <url>          OpenAI-compatible API base URL (env SCODER_BASE_URL / OPENAI_BASE_URL)
  -k, --api-key <key>       API key (env SCODER_API_KEY / OPENAI_API_KEY)
  --provider <name>         openai | anthropic (env SCODER_PROVIDER; auto-detected from model/baseUrl)
  -B, --build <cmd>         Build command = stop condition (auto-detected if omitted)
  -d, --dir <path>          Working directory (default: current directory)
  -s, --max-steps <n>       Max autonomous loop iterations (default 40)
  -y, --yes                 Non-interactive mode (auto-approves commands)
  --permission <mode>       auto | ask | readonly (env SCODER_PERMISSION, default auto)
  --agent <name>            primary agent to run (default build; see /agent): build | plan | review | <custom>
  --no-save                 Disable session auto-save to .scoder/sessions/
  --log-file                Write a JSONL event log to .scoder/logs/<session>.jsonl
                            (or set SCODER_LOG_FILE=1 / =/path/to/log.jsonl)
  --session <id>            (cost) Aggregate usage of one specific session
  --last <n>                (cost) Aggregate usage of the n most recent sessions
  -h, --help                Show this help
  -v, --version             Show version

CONFIG FILE
  .scoderrc.json in the working directory (see .scoderrc.example.json):
    { "model": "...", "baseUrl": "...", "buildCmd": "...", "maxSteps": 40,
      "permissions": { "mode": "auto", "allowCommands": ["npm "], "denyCommands": ["curl "] } }

EXAMPLES
  scoder "add a divide function to src/math.ts with tests"
  scoder --build "make test" "fix the failing test in utils"
  scoder --permission ask "npm install express and wire up a route"
  scoder -m claude-sonnet-4-5 "refactor the parser module"   # auto-detects Anthropic
  scoder resume last "now add unit tests"
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { task: null, yes: false, help: false, version: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-m":
      case "--model":
        args.model = next();
        break;
      case "-k":
      case "--api-key":
        args.apiKey = next();
        break;
      case "--base-url":
        args.baseUrl = next();
        break;
      case "-B":
      case "--build":
        args.buildCmd = next();
        break;
      case "-d":
      case "--dir":
        args.workdir = next();
        break;
      case "-s":
      case "--max-steps":
        args.maxSteps = Number(next());
        break;
      case "-y":
      case "--yes":
        args.yes = true;
        break;
      case "--agent":
        args.agent = next();
        break;
      case "--permission": {
        const mode = next();
        if (mode !== "auto" && mode !== "ask" && mode !== "readonly") {
          throw new Error(`Invalid --permission mode: ${mode} (expected auto | ask | readonly)`);
        }
        args.permission = mode;
        break;
      }
      case "--no-save":
        args.noSave = true;
        break;
      case "--log-file":
        args.logFile = true;
        break;
      case "--session":
        args.costSession = next();
        break;
      case "--last": {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`Invalid --last value (expected a positive integer): ${n}`);
        }
        args.costLast = Math.floor(n);
        break;
      }
      case "--provider": {
        const p = next();
        if (p !== "openai" && p !== "anthropic") {
          throw new Error(`Invalid --provider: ${p} (expected openai | anthropic)`);
        }
        args.provider = p;
        break;
      }
      case "--port": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          throw new Error(`Invalid --port value (expected 0-65535): ${n}`);
        }
        args.servePort = n;
        break;
      }
      case "--host":
        args.serveHost = next();
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new Error(`Unknown option: ${a} (see --help)`);
        }
        rest.push(a);
    }
  }

  args.task = rest.length > 0 ? rest.join(" ") : null;

  // Subcommands: scoder list | scoder resume <id|last> [follow-up task] | scoder logs [id]
  if (rest.length > 0 && rest[0] === "list") {
    args.subcommand = "list";
    args.task = null;
  } else if (rest[0] === "resume") {
    args.subcommand = "resume";
    args.resumeId = rest[1] ?? "last";
    args.task = rest.length > 2 ? rest.slice(2).join(" ") : null;
  } else if (rest[0] === "logs") {
    args.subcommand = "logs";
    args.logsId = rest[1] ?? "last";
    args.logsFilter = rest.length > 2 ? rest.slice(2).join(" ") : undefined;
  } else if (rest[0] === "cost") {
    args.subcommand = "cost";
    args.task = null;
  } else if (rest[0] === "serve") {
    args.subcommand = "serve";
    args.task = null;
  } else if (rest[0] === "tui") {
    // scoder tui [initial-task] — full-screen Ink interface
    args.subcommand = "tui";
    args.task = rest.length > 1 ? rest.slice(1).join(" ") : null;
  } else if (rest[0] === "models") {
    // scoder models [provider] [--refresh] — models.dev catalog (I-02)
    args.subcommand = "models";
    args.modelsProvider = rest[1] && !rest[1].startsWith("--") ? rest[1] : undefined;
    args.modelsRefresh = rest.includes("--refresh");
    args.task = null;
  } else if (rest[0] === "init") {
    args.subcommand = "init";
    args.task = null;
  }

  return args as CliArgs;
}

async function runOnce(cfg: AgentConfig, task: string): Promise<number> {
  const agent = new Agent(cfg);
  process.on("SIGINT", () => {
    ui.warn("\nSIGINT received — finishing current tool, then stopping...");
    agent.abort();
  });

  try {
    const result = await agent.run(task);
    const pruned = pruneSessions(cfg.workdir, 7);
    if (pruned > 0) ui.info(`pruned ${pruned} old session(s)`);
    return result.success ? 0 : 1;
  } catch (err) {
    ui.error((err as Error).message);
    return 2;
  } finally {
    agent.dispose();
  }
}

/**
 * `scoder init` — first-run wizard: asks for the essentials, writes
 * .scoderrc.json, then offers a live connection test against the provider.
 */
export async function runInit(): Promise<void> {
  const { existsSync, writeFileSync } = await import("node:fs");
  const rcPath = resolve(process.cwd(), ".scoderrc.json");

  ui.banner("scoder init — configure this project", [
    ["file", rcPath],
    ["note", "answers are saved to .scoderrc.json (env vars still override)"],
  ]);

  if (existsSync(rcPath)) {
    const rl0 = createInterface({ input: process.stdin, output: process.stdout });
    const overwrite = await new Promise<string>((res) =>
      rl0.question(`.scoderrc.json already exists — overwrite? [y/N] `, res),
    );
    rl0.close();
    if (!/^y(es)?$/i.test(overwrite.trim())) {
      ui.info("kept the existing .scoderrc.json");
      return;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def: string) =>
    new Promise<string>((res) => rl.question(`${q}${def ? ` [${def}]` : ""}: `, (a) => res(a.trim() || def)));

  // I-03: probe local engines first — suggest when found (no auto-switch when
  // a cloud key exists; user always decides).
  ui.info("probing local engines (ollama :11434, lmstudio :1234, vllm :8000)…");
  const { discoverLocalEngines } = await import("./provider-registry.js");
  const locals = await discoverLocalEngines();
  for (const e of locals) {
    ui.info(`  found ${e.provider.id} at ${e.provider.baseUrl} — ${e.models.length} model(s), e.g. ${e.models[0]}`);
  }

  const suggestBase = locals[0]?.provider.baseUrl ?? "https://api.openai.com/v1";
  const suggestModel = locals[0]?.models[0] ?? "gpt-4o-mini";
  const baseUrl = await ask("API base URL (OpenAI-compatible)", suggestBase);
  const apiKey = await ask("API key (SCODER_API_KEY/OPENAI_API_KEY also work at runtime)", "");
  const model = await ask("Model", suggestModel);
  const buildCmd = await ask("Build command (empty = auto-detect)", "");
  const permission = (await ask("Permission mode (auto | ask | readonly)", "auto")).toLowerCase();
  rl.close();

  const provider = /api\.anthropic\.com/.test(baseUrl) || /^claude-/i.test(model) ? "anthropic" : "openai";
  const rc: Record<string, unknown> = {
    model,
    baseUrl,
    provider,
    ...(buildCmd ? { buildCmd } : {}),
    permissions: { mode: ["auto", "ask", "readonly"].includes(permission) ? permission : "auto" },
  };
  writeFileSync(rcPath, JSON.stringify(rc, null, 2) + "\n");
  ui.success(`wrote ${rcPath} (provider: ${provider})`);

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const doTest = await new Promise<string>((res) => rl2.question("Test the connection now? [Y/n] ", res));
  rl2.close();
  if (!/^y(es)?$/i.test(doTest.trim()) && doTest.trim() !== "") {
    ui.info("skipped connection test");
    return;
  }
  if (!apiKey) {
    ui.warn("no API key provided — set SCODER_API_KEY/OPENAI_API_KEY before running tasks");
    return;
  }
  ui.info(`connecting to ${baseUrl} (${provider}) …`);
  try {
    const { LlmClient } = await import("./llm.js");
    const { AnthropicClient } = await import("./provider-anthropic.js");
    const client =
      provider === "anthropic"
        ? new AnthropicClient({ baseUrl, apiKey, model, maxTokens: 16, temperature: 0 })
        : new LlmClient({ baseUrl, apiKey, model, maxTokens: 16, temperature: 0 });
    const res = await client.chat([{ role: "user", content: "Reply with exactly: OK" }], []);
    const reply = (res.message.content ?? "").trim();
    ui.success(`connection OK — model replied: ${JSON.stringify(reply)}`);
  } catch (err) {
    ui.error(`connection test failed: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}

async function repl(cfg: AgentConfig): Promise<never> {  ui.header(`scoder interactive — model: ${cfg.model}`);
  ui.info('Type a task and press Enter. "exit" or Ctrl+D to quit.');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });

  // One shared session for the whole REPL conversation (plan P0.5 §4):
  // every input is a follow-up turn, context carries over, saved continuously.
  // /clear swaps in a fresh Agent (the /clear branch reassigns this).
  let agent = new Agent(cfg);

  process.on("SIGINT", () => {
    ui.warn("\nSIGINT — aborting current task...");
    agent.abort();
  });

  let first = true;

  for (;;) {
    const line: string = await new Promise((res) => rl.question("you> ", res));
    const input = line.trim();
    if (!input) continue;
    if (input === "exit" || input === "quit") break;

    // Slash commands — registry dùng chung với TUI (T1). Command riêng của
    // TUI (/review /undo /theme /diff turn-scope) do TUI tự xử lý trước.
    const host: CommandHost = {
      agent: () => agent,
      config: cfg,
      updateConfig: (patch) => {
        Object.assign(cfg, patch); // mutate the shared cfg so new Agents see it
      },
      replaceAgent: (next) => {
        agent.abort();
        agent.dispose();
        agent = next ?? new Agent(cfg);
        first = true;
      },
      resumeAndRun: async (s) => {
        agent.abort();
        agent.dispose();
        agent = new Agent(cfg);
        first = false;
        await agent.resume(s);
        return { success: true, steps: 0, buildCmd: cfg.buildCmd, summary: "resumed" };
      },
    };
    const { handled, outcome } = await dispatchCommand(input, host, (text, level) => {
      if (level === "error") ui.error(text);
      else console.log(text);
    });
    if (handled) {
      if (outcome?.quit) break;
      if (outcome?.notice) ui.info(outcome.notice);
      continue;
    }

    try {
      const result = first ? await agent.run(input) : await agent.runTurn(input);
      first = false;
      if (!result.success) ui.warn("task did not complete — try refining it");
    } catch (err) {
      ui.error((err as Error).message);
    }
  }

  agent.dispose();
  ui.info("bye");
  process.exit(0);
}

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
    const { loadCatalog, cacheAgeHours } = await import("./model-catalog.js");
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

  if (args.subcommand === "tui") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      ui.warn("TUI requires an interactive terminal (TTY) — falling back to the classic REPL.");
      await repl(cfg);
      return;
    }
    if (!cfg.apiKey) {
      ui.warn("No API key configured — tasks will fail until SCODER_API_KEY (or OPENAI_API_KEY) is set.");
    }
    const { runTui } = await import("./tui/app.js");
    await runTui(cfg, args.task);
    return;
  }

  if (args.subcommand === "serve") {
    const { startServer } = await import("./server.js");
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

main().catch((err) => {
  ui.error(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(2);
});
