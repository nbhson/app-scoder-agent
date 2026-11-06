/**
 * Output port used by core and tools.
 *
 * The port deliberately mirrors the existing ui.ts surface so the default
 * adapter can preserve the classic CLI output byte-for-byte. Other frontends
 * may provide a reporter without importing the terminal singleton.
 */
export interface Reporter {
  info(msg: string): void;
  step(stepNum: number, total: number, msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  llm(prefix: string, content: string): void;
  toolCall(name: string, args: Record<string, unknown>): void;
  toolResult(name: string, ok: boolean, output: string): void;
  buildStatus(success: boolean, output: string): void;
  header(msg: string): void;
  banner(title: string, rows: Array<[string, string]>): void;
  llmStreamStart(prefix?: string, color?: string): void;
  llmStreamChunk(delta: string): void;
  llmStreamEnd(suffix?: string): string;
  toolStreamStart(): void;
  toolStreamChunk(delta: string): void;
  toolStreamEnd(): void;
  isToolStreamOpen(): boolean;
  printDiff(diffText: string): void;
  diffSummary(path: string, added: number, removed: number): void;
}
