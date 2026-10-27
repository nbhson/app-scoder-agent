#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { loadConfig, type AgentConfig } from "./config.js";
import { Agent } from "./agent.js";
import { listSessions, resolveSessionId, pruneSessions } from "./session.js";
import * as ui from "./ui.js";

const VERSION = "0.1.0";

interface CliArgs {
  task: string | null;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  buildCmd?: string;
  workdir?: string;
  maxSteps?: number;
  yes: boolean;
  permission?: string;
  provider?: string;
  noSave?: boolean;
  logFile?: boolean;
  subcommand?: "list" | "resume";
  resumeId?: string;
  help: boolean;
  version: boolean;
}

const HELP = `coder — autonomous coding agent CLI

USAGE
  coder [options] "<task>"        Run a task autonomously until the build passes
  coder                           Start interactive session (chat + tools)
  coder list                      List saved sessions for this directory
  coder resume <id|last> [task]   Resume a saved session (optionally with a follow-up task)
  coder --version | --help

OPTIONS
  -m, --model <name>        LLM model (env CODER_MODEL / OPENAI_MODEL, default gpt-4o-mini)
  --base-url <url>          OpenAI-compatible API base URL (env CODER_BASE_URL / OPENAI_BASE_URL)
  -k, --api-key <key>       API key (env CODER_API_KEY / OPENAI_API_KEY)
  --provider <name>         openai | anthropic (env CODER_PROVIDER; auto-detected from model/baseUrl)
  -B, --build <cmd>         Build command = stop condition (auto-detected if omitted)
  -d, --dir <path>          Working directory (default: current directory)
  -s, --max-steps <n>       Max autonomous loop iterations (default 40)
  -y, --yes                 Non-interactive mode (auto-approves commands)
  --permission <mode>       auto | ask | readonly (env CODER_PERMISSION, default auto)
  --no-save                 Disable session auto-save to .coder/sessions/
  --log-file                Write a JSONL event log to .coder/logs/<session>.jsonl
                            (or set CODER_LOG_FILE=1 / =/path/to/log.jsonl)
  -h, --help                Show this help
  -v, --version             Show version

CONFIG FILE
  .coderrc.json in the working directory (see .coderrc.example.json):
    { "model": "...", "baseUrl": "...", "buildCmd": "...", "maxSteps": 40,
      "permissions": { "mode": "auto", "allowCommands": ["npm "], "denyCommands": ["curl "] } }

EXAMPLES
  coder "add a divide function to src/math.ts with tests"
  coder --build "make test" "fix the failing test in utils"
  coder --permission ask "npm install express and wire up a route"
  coder -m claude-sonnet-4-5 "refactor the parser module"   # auto-detects Anthropic
  coder resume last "now add unit tests"
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
      case "--provider": {
        const p = next();
        if (p !== "openai" && p !== "anthropic") {
          throw new Error(`Invalid --provider: ${p} (expected openai | anthropic)`);
        }
        args.provider = p;
        break;
      }
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

  // Subcommands: coder list | coder resume <id|last> [follow-up task]
  if (rest.length > 0 && rest[0] === "list") {
    args.subcommand = "list";
    args.task = null;
  } else if (rest[0] === "resume") {
    args.subcommand = "resume";
    args.resumeId = rest[1] ?? "last";
    args.task = rest.length > 2 ? rest.slice(2).join(" ") : null;
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
  }
}

async function repl(cfg: AgentConfig): Promise<never> {
  ui.header(`coder interactive — model: ${cfg.model}`);
  ui.info('Type a task and press Enter. "exit" or Ctrl+D to quit.');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });

  for (;;) {
    const line: string = await new Promise((res) => rl.question("you> ", res));
    const input = line.trim();
    if (!input) continue;
    if (input === "exit" || input === "quit") break;

    const agent = new Agent(cfg);
    try {
      const result = await agent.run(input);
      if (!result.success) ui.warn("task did not complete — try refining it");
    } catch (err) {
      ui.error((err as Error).message);
    }
  }

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
  } as never);

  // Subcommands
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
      ui.error(`Session not found: ${args.resumeId ?? "last"}. Run \`coder list\` to see saved sessions.`);
      process.exit(2);
    }
    const agent = new Agent(cfg);
    process.on("SIGINT", () => {
      ui.warn("\nSIGINT received — finishing current tool, then stopping...");
      agent.abort();
    });
    try {
      const result = await agent.resume(s, args.task ?? undefined);
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      ui.error((err as Error).message);
      process.exit(2);
    }
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
