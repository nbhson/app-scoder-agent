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
import { join } from "node:path";
import { fileIndex } from "./file-index.js";

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
  const hash = createHash("sha1");
  const truncated = files.length > cap;
  const list = truncated ? files.slice(0, cap) : files;
  hash.update(`files=${files.length}${truncated ? " (capped)" : ""}\n`);
  for (const rel of list) {
    let st;
    try {
      st = statSync(join(workdir, rel));
    } catch {
      hash.update(`${rel}:gone\n`);
      continue;
    }
    hash.update(`${rel}:${st.size}:${Math.round(st.mtimeMs)}\n`);
  }
  return hash.digest("hex");
}
