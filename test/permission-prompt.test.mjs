/**
 * Unit test cho promptForPermission — chạy qua child process để kiểm tra
 * timeout THỰC SỰ kết thúc process (không treo vô hạn khi không ai trả lời).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const distPermissions = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "permissions.js"
);

/** Tạo script con gọi promptForPermission với stdin đóng ngay (không ai trả lời). */
function runChild(timeoutSecs) {
  const tmp = join(tmpdir(), `perm-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    tmp,
    `import { promptForPermission } from ${JSON.stringify(distPermissions)};
const start = Date.now();
const result = await promptForPermission({
  command: "npm install suspicious-package",
  timeoutSecs: ${timeoutSecs},
});
console.log("RESULT:" + JSON.stringify({ result, elapsedMs: Date.now() - start }));
process.exit(0);
`
  );
  const res = spawnSync(process.execPath, [tmp], {
    input: "", // stdin đóng ngay
    timeout: 15_000, // test fail nếu prompt treo quá 15s
    encoding: "utf8",
  });
  try { unlinkSync(tmp); } catch { /* ignore */ }
  return res;
}

describe("promptForPermission — timeout thực sự hoạt động", () => {
  it("tự động deny (false) khi timeout mà không có ai trả lời", () => {
    const res = runChild(2);
    assert.ok(!res.error, `prompt treo quá 15s (không tự kết thúc): ${res.error?.message ?? ""}`);
    // LƯU Ý: prompt không có newline cuối nên RESULT nằm CÙNG DÒNG với menu
    const line = (res.stdout || "")
      .split("\n")
      .find((l) => l.includes("RESULT:"));
    assert.ok(line, `không thấy RESULT. stdout=${JSON.stringify(res.stdout)} stderr=${String(res.stderr || "").slice(-300)}`);
    const parsed = JSON.parse(line.slice(line.indexOf("RESULT:") + "RESULT:".length));
    assert.equal(parsed.result, false, "deadline hết hạn phải deny an toàn");
    assert.ok(
      parsed.elapsedMs >= 1900 && parsed.elapsedMs < 5000,
      `timeout phải ~2s, thực tế ${parsed.elapsedMs}ms`
    );
  });

  it("y (yes) trả lời ngay thì trả về true không chờ timeout", () => {
    const tmp = join(tmpdir(), `perm-prompt-yes-${Date.now()}.mjs`);
    writeFileSync(
      tmp,
      `import { promptForPermission } from ${JSON.stringify(distPermissions)};
const start = Date.now();
const result = await promptForPermission({ command: "npm test", timeoutSecs: 60 });
console.log("RESULT:" + JSON.stringify({ result, elapsedMs: Date.now() - start }));
process.exit(0);
`
    );
    const res = spawnSync(process.execPath, [tmp], {
      input: "y\n",
      timeout: 15_000,
      encoding: "utf8",
    });
    try { unlinkSync(tmp); } catch { /* ignore */ }
    assert.ok(!res.error, "prompt với input 'y' không được treo");
    const line = (res.stdout || "").split("\n").find((l) => l.includes("RESULT:"));
    assert.ok(line, `không thấy RESULT. stdout=${JSON.stringify(res.stdout)} stderr=${String(res.stderr || "").slice(-300)}`);
    const parsed = JSON.parse(line.slice(line.indexOf("RESULT:") + "RESULT:".length));
    assert.equal(parsed.result, true);
    assert.ok(parsed.elapsedMs < 2000, `trả lời 'y' phải ngay lập tức, thực tế ${parsed.elapsedMs}ms`);
  });
});
