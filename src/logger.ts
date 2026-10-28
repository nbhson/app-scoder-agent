/**
 * Structured JSONL session logging.
 * One JSON object per line — parseable with jq or any log consumer.
 * Never crashes the agent: write failures are swallowed after one warning.
 */
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class JsonlLogger {
  private filePath: string | null;
  private warned = false;

  private constructor(path: string | null) {
    this.filePath = path;
  }

  /**
   * Create a logger for a session.
   * logFile: true    -> <workdir>/.coder/logs/<sessionId>.jsonl
   *          string  -> that exact path
   *          false/undefined -> disabled (no-op)
   */
  static forSession(
    workdir: string,
    sessionId: string,
    logFile?: boolean | string,
  ): JsonlLogger {
    if (logFile === undefined || logFile === false || logFile === null) {
      return new JsonlLogger(null);
    }
    const path =
      typeof logFile === "string" && logFile.length > 0
        ? resolve(logFile)
        : resolve(workdir, ".coder/logs", `${sessionId}.jsonl`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      return new JsonlLogger(path);
    } catch (err) {
      console.error(`⚠  logging disabled (cannot create log dir): ${(err as Error).message}`);
      return new JsonlLogger(null);
    }
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  /** Read a session's JSONL log file, returning parsed events (or null if missing/unreadable). */
  static read(workdir: string, sessionId: string): Array<Record<string, unknown>> | null {
    const path = resolve(workdir, ".coder/logs", `${sessionId}.jsonl`);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    const events: Array<Record<string, unknown>> = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // skip malformed lines
      }
    }
    return events;
  }

  /** Append one event. Never throws. */
  log(event: Record<string, unknown>): void {
    if (!this.filePath) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
      appendFileSync(this.filePath, line + "\n", "utf8");
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.error(`⚠  log write failed (${(err as Error).message}) — disabling session log`);
      }
      this.filePath = null;
    }
  }
}
