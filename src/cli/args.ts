/** CLI argument parsing: CliArgs shape, help text, and the pure parser. */
export interface CliArgs {
  task: string | null;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  buildCmd?: string;
  workdir?: string;
  maxSteps?: number;
  yes: boolean;
  noColor?: boolean;
  noMotion?: boolean;
  plain?: boolean;
  highContrast?: boolean;
  agent?: string;
  permission?: string;
  provider?: string;
  noSave?: boolean;
  logFile?: boolean;
  subcommand?: "list" | "resume" | "logs" | "cost" | "serve" | "tui" | "init" | "models" | "mcp";
  mcpCmd?: "list" | "add" | "remove" | "test" | "import";
  mcpArgs?: string[]; // rest args for the mcp subcommand
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

export const HELP = `scoder — autonomous coding agent CLI

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

export function parseArgs(argv: string[]): CliArgs {
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
      case "--no-color":
        args.noColor = true;
        break;
      case "--no-motion":
        args.noMotion = true;
        break;
      case "--plain":
        args.plain = true;
        break;
      case "--high-contrast":
        args.highContrast = true;
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
      default: {
        if (a.startsWith("-")) {
          // MCP subcommand flags (--command, --url, --trust, --args) are not
          // known globally — pass them through as positional args for runMcpCommand
          // to interpret. Only throw if we are NOT in an mcp subcommand context.
          const isMcpContext = rest[0] === "mcp" || argv.slice(0, i).includes("mcp");
          if (!isMcpContext) throw new Error(`Unknown option: ${a} (see --help)`);
          rest.push(a);
          // Consume the next token as this option's value if present.
          if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
            rest.push(argv[++i]);
          }
          break;
        }
        rest.push(a);
      }
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
  } else if (rest[0] === "mcp") {
    // scoder mcp list|add <name>|remove <name>|test <name>
    // e.g. scoder mcp add github --command "npx mcp-github" --url "..." --trust readonly
    args.subcommand = "mcp";
    const m = rest[1];
    if (m === "list" || m === "add" || m === "remove" || m === "test" || m === "import") {
      args.mcpCmd = m;
    } else if (m) {
      args.mcpCmd = "list";
    } else {
      args.mcpCmd = "list";
    }
    args.mcpArgs = rest.slice(2);
    args.task = null;
  }

  return args as CliArgs;
}

