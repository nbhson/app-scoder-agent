/**
 * P1-2 (RC-5): fingerprint trạng thái workspace — dùng để KHÔNG chạy lại
 * build/test/typecheck/lint khi không có gì thay đổi.
 *
 * Chi phí: 1 lần `stat` mỗi file (danh sách file lấy từ file-index —
 * gitignore-aware, TTL 5s, đã invalidate mỗi lần tool write/edit). Không đọc
 * nội dung file: size + mtime đổi khi agent sửa code; độ chính xác đủ cho một
 * CACHE (kết quả cũ chỉ được tái sử dụng khi lần trước PASS), và có tắt bằng
 * rc `"verifyCache": false`.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { join } from "node:path";
import { fileIndex, rgFilesAsync } from "./file-index.js";

/** Số file tối đa đưa vào fingerprint (file-index cap thực tế ~vài nghìn). */
const MAX_FINGERPRINT_FILES = 5_000;

/**
 * Fingerprint ổn định cho một trạng thái workspace. Trả về chuỗi dài ~40 ký
 * tự; khác 1 byte khi 1 file thêm/bỏ/đổi size hoặc mtime.
 *
 * `fileIndex(workdir, force)` — BỎ QUA cache TTL 5s (và cache one-slot theo
 * workdir khác): file mới tạo bởi `run_command`/trình sửa ngoài PHẢI đổi hash,
 * nếu không kết quả verify cũ sẽ được tái sử dụng sai. Chi phí một lần
 * `rg --files` + stat — nhỏ hơn rất nhiều so với một lệnh build chạy thừa.
 */
export function workspaceFingerprint(workdir: string, cap = MAX_FINGERPRINT_FILES): string {
  const files = fileIndex(workdir, true);
  const list = files.slice(0, cap);
  const stats: Array<{ size: number; mtimeMs: number } | null> = [];
  for (const rel of list) {
    try {
      const st = statSync(join(workdir, rel));
      stats.push({ size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      stats.push(null);
    }
  }
  return digestFingerprint(files, list, stats);
}

/**
 * P-perf (item 9): async twin for the verify hot path. `verifyAll` is awaited
 * by the agent loop but runs INSIDE the event loop — the sync version's
 * `spawnSync rg` + up to 5.000 statSync calls froze TUI paint and stream
 * parsing for 50–500 ms. Same file list source (`rg --files`), same stats
 * (batched), SAME digest bytes — the two functions are interchangeable for
 * the verify cache.
 */
export async function workspaceFingerprintAsync(workdir: string, cap = MAX_FINGERPRINT_FILES): Promise<string> {
  let files = await rgFilesAsync(workdir);
  if (!files || files.length === 0) {
    files = fileIndex(workdir, true); // no rg / empty → identical fallback to the sync path
  } else {
    files.sort();
  }
  const list = files.slice(0, cap);
  const stats: Array<{ size: number; mtimeMs: number } | null> = [];
  for (let i = 0; i < list.length; i += 200) {
    const batch = await Promise.allSettled(
      list.slice(i, i + 200).map((rel) => statAsync(join(workdir, rel))),
    );
    for (const r of batch) {
      stats.push(r.status === "fulfilled" ? { size: r.value.size, mtimeMs: r.value.mtimeMs } : null);
    }
  }
  return digestFingerprint(files, list, stats);
}

/** Shared digest core — identical string sequence for sync and async paths. */
function digestFingerprint(
  files: readonly string[],
  list: readonly string[],
  stats: ReadonlyArray<{ size: number; mtimeMs: number } | null>,
): string {
  const hash = createHash("sha1");
  const truncated = files.length > list.length;
  hash.update(`files=${files.length}${truncated ? " (capped)" : ""}\n`);
  for (let i = 0; i < list.length; i++) {
    const st = stats[i];
    if (!st) {
      hash.update(`${list[i]}:gone\n`);
      continue;
    }
    hash.update(`${list[i]}:${st.size}:${Math.round(st.mtimeMs)}\n`);
  }
  return hash.digest("hex");
}
