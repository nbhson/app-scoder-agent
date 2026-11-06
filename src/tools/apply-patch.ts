import { readFileSync, writeFileSync, statSync } from "node:fs";
import { unifiedDiff } from "../workspace/diff.js";
import { safePath, MAX_FILE_SIZE_BYTES } from "./path-safety.js";
import { gateWrite, toToolDiff, formatFile, applyOneEdit } from "./file-edit-common.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function toolApplyPatch(
  ctx: ToolContext,
  args: { path: string; edits: Array<{ old_string: string; new_string: string }> },
): Promise<ToolResult> {
  let abs: string;
  try {
    abs = safePath(ctx.workdir, args.path);
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    return { ok: false, output: "ERROR: edits must be a non-empty array." };
  }
  if (args.edits.length > 50) {
    return { ok: false, output: `ERROR: too many edits (${args.edits.length}); split into chunks of at most 50.` };
  }
  let content: string;
  try {
    if (statSync(abs).size > MAX_FILE_SIZE_BYTES) {
      return { ok: false, output: `ERROR: ${args.path} exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB patch limit.` };
    }
    content = readFileSync(abs, "utf8");
  } catch (err) {
    return { ok: false, output: `ERROR: cannot read ${args.path}: ${(err as Error).message}` };
  }
  const original = content;
  let fuzzy = 0;
  for (let i = 0; i < args.edits.length; i++) {
    const e = args.edits[i];
    if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string") {
      return { ok: false, output: `ERROR: edit #${i + 1} must have string old_string and new_string. No changes written.` };
    }
    const outcome = applyOneEdit(content, args.path, e.old_string, e.new_string);
    if (!outcome.ok) {
      return {
        ok: false,
        output: `ERROR: edit #${i + 1}/${args.edits.length} failed — ${outcome.error} No changes written.`,
      };
    }
    content = outcome.content;
    if (outcome.fuzzy) fuzzy++;
  }
  if (content === original) {
    return { ok: true, output: `No changes to ${args.path} (all edits were no-ops).` };
  }

  const diff = unifiedDiff(args.path, original, content);
  const gate = await gateWrite(ctx, args.path, diff);
  if (gate) return gate;

  writeFileSync(abs, content, "utf8");
  const fmtNote = formatFile(ctx, abs);
  const fuzzyNote = fuzzy > 0 ? ` (${fuzzy} fuzzy whitespace match${fuzzy === 1 ? "" : "es"})` : "";
  return {
    ok: true,
    output: `Applied ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"} to ${args.path}${fuzzyNote}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
}

