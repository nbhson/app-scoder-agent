import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { unifiedDiff } from "../workspace/diff.js";
import { safePath } from "./path-safety.js";
import { gateWrite, toToolDiff, formatFile } from "./file-edit-common.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function toolWriteFile(ctx: ToolContext, args: { path: string; content: string }): Promise<ToolResult> {
  let abs: string;
  try {
    abs = safePath(ctx.workdir, args.path);
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
  let oldContent: string | null = null;
  try {
    oldContent = readFileSync(abs, "utf8");
  } catch {
    // new file
  }

  const diff = unifiedDiff(args.path, oldContent, args.content);
  const gate = await gateWrite(ctx, args.path, diff);
  if (gate) return gate;

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, args.content, "utf8");
  const fmtNote = await formatFile(ctx, abs);
  // P-perf (item 11): count newlines with an indexOf scan — `split("\n")` on
  // a 2MB file allocated ~50k throwaway strings just for the line count.
  let writtenLines = 1;
  for (let i = args.content.indexOf("\n"); i !== -1; i = args.content.indexOf("\n", i + 1)) writtenLines++;
  return {
    ok: true,
    output: `Wrote ${writtenLines} lines to ${args.path}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
}

/** v2: whitespace-insensitive regex for edit_file fuzzy fallback. */
