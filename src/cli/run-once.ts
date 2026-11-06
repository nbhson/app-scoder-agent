/** One-shot `scoder "<task>"` mode: run to completion, exit with the result code. */
import process from "node:process";
import { Agent } from "../agent.js";
import type { AgentConfig } from "../config/config.js";
import { pruneSessions } from "../session/session.js";
import * as ui from "../io/terminal.js";

export async function runOnce(cfg: AgentConfig, task: string): Promise<number> {
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

