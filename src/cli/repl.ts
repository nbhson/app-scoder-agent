/** Classic interactive REPL (`scoder` with no task). */
import process from "node:process";
import { createInterface } from "node:readline";
import { Agent } from "../agent.js";
import type { AgentConfig } from "../config/config.js";
import { dispatchCommand, type CommandHost } from "../commands/registry.js";
import * as ui from "../ui.js";

export async function repl(cfg: AgentConfig): Promise<never> {  ui.header(`scoder interactive — model: ${cfg.model}`);
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
      if (!outcome?.task) continue;
      try {
        const result = first ? await agent.run(outcome.task) : await agent.runTurn(outcome.task);
        first = false;
        if (!result.success) ui.warn("task did not complete — try refining it");
      } catch (err) {
        ui.error((err as Error).message);
      }
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

