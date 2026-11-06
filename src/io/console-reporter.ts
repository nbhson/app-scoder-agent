import * as ui from "../ui.js";
import type { Reporter } from "./reporter.js";

/** Default reporter preserving the existing classic terminal behavior. */
export const consoleReporter: Reporter = {
  info: ui.info,
  step: ui.step,
  success: ui.success,
  warn: ui.warn,
  error: ui.error,
  llm: ui.llm,
  toolCall: ui.toolCall,
  toolResult: ui.toolResult,
  buildStatus: ui.buildStatus,
  header: ui.header,
  banner: ui.banner,
  llmStreamStart: ui.llmStreamStart,
  llmStreamChunk: ui.llmStreamChunk,
  llmStreamEnd: ui.llmStreamEnd,
  toolStreamStart: ui.toolStreamStart,
  toolStreamChunk: ui.toolStreamChunk,
  toolStreamEnd: ui.toolStreamEnd,
  isToolStreamOpen: ui.isToolStreamOpen,
  printDiff: ui.printDiff,
  diffSummary: ui.diffSummary,
};
