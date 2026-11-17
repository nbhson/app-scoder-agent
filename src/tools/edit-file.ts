import { readFileSync, writeFileSync, statSync } from "node:fs";
import { unifiedDiff } from "../workspace/diff.js";
import { safePath, MAX_FILE_SIZE_BYTES } from "./path-safety.js";
import { gateWrite, toToolDiff, formatFile, applyOneEdit } from "./file-edit-common.js";
import type { ToolContext, ToolResult } from "./types.js";

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
  // P-perf (item 8): size gate before the full read — edit_file used to
  // slurp files of ANY size (a 500MB minified bundle then hit 4 full scans
  // in applyOneEdit + a 2× diff). Other read errors keep throwing to the
  // executor's catch, exactly as before (byte-identical ERROR text).
  try {
    if (statSync(abs).size > MAX_FILE_SIZE_BYTES) {
      return { ok: false, output: `ERROR: ${args.path} exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB edit limit.` };
    }
  } catch {
    // missing / raced away — fall through: readFileSync below throws the
    // exact ENOENT the old code did (executor renders "ERROR: <message>").
  }
  const content = readFileSync(abs, "utf8");
  const outcome = applyOneEdit(content, args.path, args.old_string, args.new_string);
  if (!outcome.ok) return { ok: false, output: outcome.error };
  const newContent = outcome.content;

  const diff = unifiedDiff(args.path, content, newContent);
  const gate = await gateWrite(ctx, args.path, diff);
  if (gate) return gate;

  writeFileSync(abs, newContent, "utf8");
  const fmtNote = await formatFile(ctx, abs);
  return {
    ok: true,
    output: `Edited ${args.path}${outcome.fuzzy ? " (fuzzy whitespace match)" : ""}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
}

