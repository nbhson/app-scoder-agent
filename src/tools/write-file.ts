import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { unifiedDiff } from "../diff.js";
import { safePath } from "./path-safety.js";
import { gateWrite, toToolDiff, formatFile } from "./file-edit-common.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

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
  const fmtNote = formatFile(ctx, abs);
  return {
    ok: true,
    output: `Wrote ${args.content.split("\n").length} lines to ${args.path}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
}

/** v2: whitespace-insensitive regex for edit_file fuzzy fallback. */
