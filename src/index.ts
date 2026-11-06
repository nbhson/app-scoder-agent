#!/usr/bin/env node
/** LEGACY PUBLIC PATH — CLI implementation lives in ./cli/main.js. */
import process from "node:process";
import { pathToFileURL } from "node:url";
import * as ui from "./ui.js";
import { main } from "./cli/main.js";

export { parseArgs } from "./cli/args.js";
export { runInit } from "./cli/init.js";

// Guard: only run when executed as entry point (not imported in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    ui.error(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
    process.exit(2);
  });
}
