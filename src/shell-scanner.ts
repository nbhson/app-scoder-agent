/**
 * Shell scanner — AST-aware permission analysis using tree-sitter-bash.
 *
 * Source: anomalyco/opencode (shell permission scanner, /v2/docs/permissions) —
 * concept adapted to tree-sitter-bash on Node. Behavior contract:
 *  - A syntactically INVALID command (or dynamic evaluation the scanner
 *    cannot resolve) returns { ok: false, error } — the caller must treat it
 *    as "ask" (never execute unverified).
 *  - Compound commands produce one resource per subcommand; redirect targets
 *    are reported so callers can gate external writes.
 *  - `cd <dir>` targets are extracted for external_directory gating.
 */
import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";

export interface ShellScan {
  ok: boolean;
  /** Parse/analysis failure — never execute; require user approval. */
  error?: string;
  /** Top-level command invocations, in source order (e.g. ["npm", "rm"]). */
  commands: string[];
  /** Full command line of each invocation (for rule matching like "git push*"). */
  commandLines: string[];
  /** Redirect targets ("file" and "append" forms). */
  redirectTargets: string[];
  /** `cd` directory arguments (external-directory gating). */
  cdTargets: string[];
  /** Command substitutions $(...) / backticks detected. */
  hasCommandSubstitution: boolean;
  /** eval / dynamic execution detected. */
  hasDynamicEval: boolean;
}

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Bash as never);
  }
  return parser;
}

function collect(root: Parser.SyntaxNode): {
  commandNames: string[];
  commandLines: string[];
  redirectTargets: string[];
  cdTargets: string[];
  hasCommandSubstitution: boolean;
  hasDynamicEval: boolean;
  hasError: boolean;
} {
  const commandNames: string[] = [];
  const commandLines: string[] = [];
  const redirectTargets: string[] = [];
  const cdTargets: string[] = [];
  let hasCommandSubstitution = false;
  let hasDynamicEval = false;
  let hasError = root.hasError;

  const walk = (n: Parser.SyntaxNode): void => {
    if (n.type === "ERROR") hasError = true;
    if (n.type === "command_substitution" || n.type === "process_substitution") {
      hasCommandSubstitution = true;
    }
    if (n.type === "command") {
      const nameNode = n.child(0);
      const name = nameNode?.type === "command_name" ? nameNode.text : "";
      if (name) {
        commandNames.push(name);
        commandLines.push(n.text);
        if (name === "cd") {
          const firstArg = n.child(1);
          if (firstArg && firstArg.type !== "command_name") cdTargets.push(firstArg.text);
        }
        if (name === "eval" || name === "source" || name === ".") hasDynamicEval = true;
      }
    }
    if (n.type === "file_redirect") {
      // child(0) = operator (>, >>), child(1) = destination word
      const dest = n.child(1)?.text ?? "";
      if (dest) redirectTargets.push(dest);
    }
    if (n.type === "heredoc_redirect") {
      // heredoc body is safe to ignore, but the target word matters
      const dest = n.child(0)?.text ?? "";
      if (dest) redirectTargets.push(dest);
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(root);
  return { commandNames, commandLines, redirectTargets, cdTargets, hasCommandSubstitution, hasDynamicEval, hasError };
}

/** Scan one shell command line (exactly what run_command would execute). */
export function scanCommand(command: string): ShellScan {
  const empty: ShellScan = {
    ok: false,
    error: "empty command",
    commands: [],
    commandLines: [],
    redirectTargets: [],
    cdTargets: [],
    hasCommandSubstitution: false,
    hasDynamicEval: false,
  };
  if (!command || !command.trim()) return empty;

  let tree: Parser.Tree;
  try {
    tree = getParser().parse(command);
  } catch (err) {
    return { ...empty, error: `scanner parse failure: ${(err as Error).message}` };
  }

  const r = collect(tree.rootNode);
  if (r.hasError) {
    return {
      ...empty,
      error: "command has invalid syntax or unresolvable constructs — approval required",
      hasCommandSubstitution: r.hasCommandSubstitution,
      hasDynamicEval: r.hasDynamicEval,
    };
  }
  return {
    ok: true,
    commands: r.commandNames,
    commandLines: r.commandLines,
    redirectTargets: r.redirectTargets,
    cdTargets: r.cdTargets,
    hasCommandSubstitution: r.hasCommandSubstitution,
    hasDynamicEval: r.hasDynamicEval,
  };
}
