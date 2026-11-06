import { readFileSync, writeFileSync } from "node:fs";
import { unifiedDiff } from "../diff.js";
import { safePath } from "./path-safety.js";
import { gateWrite, toToolDiff, formatFile, applyOneEdit } from "./file-edit-common.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

export async function toolEditFile(
  ctx: ToolContext,
  args: { path: string; old_string: string; new_string: string },
): Promise<ToolResult> {
  let abs: string;
  try {
    abs = safePath(ctx.workdir, args.path);
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
  const content = readFileSync(abs, "utf8");
  const outcome = applyOneEdit(content, args.path, args.old_string, args.new_string);
  if (!outcome.ok) return { ok: false, output: outcome.error };
  const newContent = outcome.content;

  const diff = unifiedDiff(args.path, content, newContent);
  const gate = await gateWrite(ctx, args.path, diff);
  if (gate) return gate;

  writeFileSync(abs, newContent, "utf8");
  const fmtNote = formatFile(ctx, abs);
  return {
    ok: true,
    output: `Edited ${args.path}${outcome.fuzzy ? " (fuzzy whitespace match)" : ""}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
}

