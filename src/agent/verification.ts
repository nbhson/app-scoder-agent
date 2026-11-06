import type { AgentConfig } from "../config.js";
import { runBuild, type BuildResult } from "../build.js";
import type { ProviderRuntimeContract } from "../provider-registry.js";
import type { ChatResult } from "../llm.js";
import { parseDiagnostics, detectVerifyCmds, type VerifyCommands } from "../diagnostics.js";
import type { AgentEvent } from "./types.js";
import type { EventSessionStore } from "../session.js";
import type { JsonlLogger } from "../logger.js";
import type { Reporter } from "../io/reporter.js";

export interface VerificationRuntime {
  config: AgentConfig;
  reporter: Reporter;
  logger: JsonlLogger;
  events: EventSessionStore;
  emit: (event: AgentEvent) => void;
  onToolOutput: (stream: "stdout" | "stderr", delta: string) => void;
  endToolStream: () => void;
  setLastBuildResult: (result: BuildResult) => void;
}

/** Resolve the configured verification commands without changing precedence. */
export function resolveVerify(config: AgentConfig, buildCmd: string): VerifyCommands {
  const cfg = config.verifyCmds ?? {};
  const detected = detectVerifyCmds(config.workdir);
  const pick = (name: keyof VerifyCommands, fallback: string | undefined): string | undefined => {
    const value = cfg[name];
    if (value === "") return undefined;
    return value ?? fallback;
  };
  return {
    build: pick("build", buildCmd),
    test: pick("test", detected.test),
    typecheck: pick("typecheck", detected.typecheck),
    lint: pick("lint", detected.lint),
  };
}

/** Run build → test → typecheck → lint, preserving the existing event order. */
export async function verifyAll(runtime: VerificationRuntime, buildCmd: string): Promise<BuildResult> {
  const commands = resolveVerify(runtime.config, buildCmd);
  const outputs: Array<{ cmd: string; res: BuildResult }> = [];
  const runOne = async (cmd: string): Promise<BuildResult> => {
    const result = await runBuild(runtime.config.workdir, cmd, runtime.onToolOutput);
    runtime.endToolStream();
    runtime.reporter.buildStatus(result.success, result.output);
    runtime.emit({ type: "build", success: result.success, command: cmd, output: result.output });
    runtime.logger.log({ type: "build", success: result.success, command: cmd, output: result.output.slice(0, 10_000) });
    return result;
  };

  for (const cmd of [commands.build, commands.test, commands.typecheck, commands.lint]) {
    if (!cmd) continue;
    const result = await runOne(cmd);
    outputs.push({ cmd, res: result });
    if (!result.success) break;
  }
  if (outputs.length === 0) {
    return { success: true, command: buildCmd, output: "(no verify commands)" };
  }
  const allOk = outputs.every((output) => output.res.success);
  const combined = outputs.map((output) => `$ ${output.cmd}\n${output.res.output}`).join("\n\n");
  const lastBuild: BuildResult = {
    success: allOk,
    command: outputs.map((output) => output.cmd).join(" && "),
    output: combined,
  };
  runtime.setLastBuildResult(lastBuild);
  runtime.events.append({ type: "build.checked", success: allOk, command: lastBuild.command, output: combined.slice(0, 10_000) });
  return lastBuild;
}

/** Signature of a verification failure, stable across cosmetic differences. */
export function failureSignature(output: string): string {
  const diagnostics = parseDiagnostics(output);
  if (diagnostics.length > 0) return diagnostics.slice(0, 5).map((d) => d.code ?? d.message).join("|");
  return output.toLowerCase().replace(/\d+/g, "N").replace(/\s+/g, " ").slice(0, 300);
}

/** Collect the run's diff texts (capped) for the self-review pass. */
export function collectRunDiff(runDiffs: string[]): string {
  if (runDiffs.length === 0) return "";
  const joined = runDiffs.join("\n");
  return joined.length > 12_000 ? `…[truncated]\n${joined.slice(-12_000)}` : joined;
}

export interface SelfReviewRuntime {
  config: AgentConfig;
  currentTask: () => string;
  runDiffs: () => string[];
  filesModified: () => boolean;
  selfReviewDone: () => boolean;
  setSelfReviewDone: (value: boolean) => void;
  client: ProviderRuntimeContract;
  signal: AbortSignal;
  recordLlmUsage: (usage: ChatResult["usage"]) => void;
  logger: JsonlLogger;
}

/** Ask the model for blocking findings once before successful completion. */
export async function selfReviewGate(runtime: SelfReviewRuntime): Promise<string | null> {
  if (runtime.config.selfReview === false) return null;
  if (runtime.selfReviewDone()) return null;
  if (!runtime.filesModified()) return null;
  runtime.setSelfReviewDone(true);
  const diff = collectRunDiff(runtime.runDiffs());
  if (!diff) return null;
  const prompt =
    `You are reviewing an agent's diff for this task:\n\nTASK: ${runtime.currentTask()}\n\nDIFF:\n${diff}\n\n` +
    `List ONLY blocking issues (correctness, security, or acceptance violations), each on its own line prefixed with "[blocking]" ` +
    `and include file:line and a one-line fix. If there are no blocking issues, reply exactly "LGTM".`;
  try {
    const result = await runtime.client.chat([{ role: "user", content: prompt }], [], { signal: runtime.signal });
    runtime.recordLlmUsage(result.usage);
    const text = (result.message.content ?? "").trim();
    const blocking = text.split("\n").filter((line) => /\[blocking\]/i.test(line));
    if (blocking.length === 0) {
      runtime.logger.log({ type: "self_review", verdict: /^LGTM\b/im.test(text) ? "lgtm" : "no-blocking-findings" });
      return null;
    }
    runtime.logger.log({ type: "self_review", verdict: "blocking", findings: blocking.slice(0, 10).join("\n").slice(0, 2000) });
    return blocking.slice(0, 10).join("\n").slice(0, 3000);
  } catch (err) {
    runtime.logger.log({ type: "self_review", verdict: "error", error: (err as Error).message.slice(0, 200) });
    return null;
  }
}
