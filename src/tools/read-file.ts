import { readFileSync, statSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import { detectImageBytes } from "../media/image.js";
import { clamp, MAX_FILE_SIZE_BYTES, MAX_OUTPUT_CHARS, MAX_TOOL_OUTPUT_CHARS, safePath, toPosInt, toResult } from "./path-safety.js";
import { isProtectedEnvFile } from "./path-safety.js";
import type { ToolResult } from "./types.js";

export function toolReadFile(workdir: string, args: { path: string; offset?: number | string; limit?: number | string }): ToolResult {
  return toResult(() => {
  const abs = safePath(workdir, args.path);
  // H-04: .env read policy — ask trước khi trả nội dung (secrets hygiene).
  const rel = relative(workdir, abs);
  let policyPath = rel;
  try { policyPath = relative(workdir, realpathSync(abs)); } catch { /* handled by safePath */ }
  const envPolicy = isProtectedEnvFile(policyPath.toLowerCase());
  if (envPolicy === "ask") {
    return {
      ok: false,
      output:
        `ASK_PERMISSION: ${rel} may contain secrets (env file). ` +
        `Ask the user to confirm before reading; suggest reading .env.example instead ` +
        `or running with a permission rule ({"action":"shell","resource":"read .env","effect":"allow"}).`,
    };
  }
  const st = statSync(abs);
  if (st.isDirectory()) {
    return { ok: false, output: `ERROR: ${args.path} is a directory — use list_files instead.` };
  }
  if (st.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      output: `ERROR: ${args.path} is ${(st.size / 1024 / 1024).toFixed(1)}MB (limit ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB). Use run_command with grep/head/tail to inspect specific parts.`,
    };
  }
  // T7: image file → base64 notice cho TUI render (LLM vẫn nhận mô tả text).
  let image: string | undefined;
  try {
    const probe = readFileSync(abs);
    const ext = detectImageBytes(probe);
    if (ext) image = `data:image/${ext};base64,${probe.toString("base64")}`;
  } catch {
    // not an image / unreadable — fall through to text read
  }
  if (image) {
    return { ok: true, output: `[image: ${args.path}]`, image };
  }
  if (statSync(abs).size > MAX_FILE_SIZE_BYTES) {
    return { ok: false, output: `ERROR: ${args.path} exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB edit limit.` };
  }
  const content = readFileSync(abs, "utf8");
  const lines = content.split("\n");
  const total = lines.length;
  // v2: line-range reads — offset (1-based, default 1) + limit (default all).
  const offset = Math.min(toPosInt(args.offset, 1), total);
  const limit = Math.min(toPosInt(args.limit, total - offset + 1), 2000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numberedAll = slice.map((l, i) => `${offset + i}: ${l}`);

  // P0-2 (RC-3): cắt theo DÒNG ngay tại ngân sách history (limits.toolOutputChars)
  // và nói rõ phần còn lại nằm ở dòng nào + lấy tiếp bằng tham số nào. Trunc mù
  // kiểu "... more chars" từng khiến agent đọc lại cả file bằng "cách khác".
  const budget = Math.max(200, Math.min(MAX_TOOL_OUTPUT_CHARS, MAX_OUTPUT_CHARS));
  const kept: string[] = [];
  let used = 0;
  for (const line of numberedAll) {
    if (used + line.length + 1 > budget && kept.length > 0) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = numberedAll.length - kept.length;
  const end = offset + kept.length - 1;
  const header = offset > 1 || end < total ? `[lines ${offset}-${end} of ${total} — ${args.path}]\n` : "";
  const footer =
    dropped > 0
      ? `\n... [${dropped} more line(s): ${end + 1}-${offset + slice.length - 1} of ${total}. ` +
        `Read the REST in ONE step — parallel read_file calls at ` +
        `{"path":"${args.path}","offset":${end + 1}}, ` +
        `{"path":"${args.path}","offset":${end + 1 + kept.length}}, ... ` +
        `until the file is done; do NOT re-read from the start.]`
      : "";
  // clamp cho dòng kếch xù (một dòng 40k ký tự vẫn phải nằm trong ngân sách).
  const numbered = clamp(kept.join("\n"), budget);
  return { ok: true, output: header + numbered + footer };
  });
}

