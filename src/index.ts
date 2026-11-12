#!/usr/bin/env node
/** LEGACY PUBLIC PATH — CLI implementation lives in ./cli/main.js. */
import process from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import * as ui from "./io/terminal.js";
import { main } from "./cli/main.js";

export { parseArgs } from "./cli/args.js";
export { runInit } from "./cli/init.js";

// Guard: only run when executed as entry point (not imported in tests).
const _argv1 = process.argv[1]
  ? (() => {
      try {
        return realpathSync(process.argv[1]);
      } catch {
        return process.argv[1];
      }
    })()
  : null;
if (_argv1 && import.meta.url === pathToFileURL(_argv1).href) {
  main().catch((err) => {
    ui.error(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
    process.exit(2);
  });
}
