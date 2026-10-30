/**
 * Integration test cho `scoder tui` (Ink full-screen TUI).
 *
 * Dùng pty-run.py (python3 pty.fork + ioctl TIOCSWINSZ) để tạo PTY thật từ
 * process test không có TTY — chạy ổn định trên macOS/Linux, không cần native
 * deps. Agent chạy closed-loop với mock LLM; verify các panel render đúng rồi
 * thoát sạch bằng phím "exit".
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Strip ANSI escapes + terminal control chars for assertions. */
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// ── Temp project: build.js fails until lib.js is fixed ──────────────────────
const tmp = mkdtempSync(join(tmpdir(), "scoder-tui-test-"));
writeFileSync(
  join(tmp, "build.js"),
  "const lib = require('./lib.js');\n" +
    "if (lib.add(2, 3) !== 5) { console.error('FAIL: add(2,3)=' + lib.add(2, 3)); process.exit(1); }\n" +
    "console.log('PASS');\n",
);
writeFileSync(join(tmp, "lib.js"), "module.exports.add = (a, b) => a - b; // BUG\n");

// ── Mock LLM server (scripted closed loop) ──────────────────────────────────
const mock = spawn("node", ["./test/mock-llm.mjs"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] });
const mockPort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("mock LLM did not report a port")), 10_000);
  mock.stdout.on("data", (c) => {
    const m = String(c).match(/MOCK_LLM_PORT=(\d+)/);
    if (m) {
      clearTimeout(timer);
      resolve(Number(m[1]));
    }
  });
  mock.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`mock LLM crashed (code ${code})`));
  });
});

describe("scoder tui — Ink full-screen UI", () => {
  it("chạy closed-loop trong PTY: header + tool calls + build passed + success, rồi exit sạch", async () => {    const outFile = join(tmpdir(), `scoder-tui-out-${Date.now()}.txt`);
    const proc = spawn(
      "python3",
      [
        "test/pty-run.py",
        "--timeout", "30",
        "--send-after", "build passed|All done:exit\\r",
        "--out", outFile,
        "--",
        "node", "dist/index.js",
        "-d", tmp,
        "tui",
        "fix the bug in lib.js",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SCODER_API_KEY: "test",
          SCODER_BASE_URL: `http://127.0.0.1:${mockPort}`,
          SCODER_NO_SAVE: "1",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    const exitCode = await new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? 0)));
    const clean = stripAnsi(readFileSync(outFile, "utf8"));

    assert.ok(clean.includes("scoder"), "phải render header 'scoder'");
    assert.ok(clean.includes("write_file") || clean.includes("edit_file"), "phải render tool calls");
    assert.ok(clean.includes("run_command"), "phải render run_command (build)");
    assert.ok(/build passed|All done/i.test(clean), `phải render finish (tail: ${clean.slice(-300)})`);
    assert.ok(/success/i.test(clean), "status bar phải chuyển sang success");
    assert.ok(/send · esc abort|abort · ctrl\+c/i.test(clean), "phải có status bar với keybind hints");
    // Build Rail — bản sắc riêng: đèn build + step fuel gauge
    assert.ok(/● build (ok|fail)|no build yet/.test(clean), `phải có build lamp trong Build Rail (tail: ${clean.slice(-300)})`);
    assert.ok(/▰|▱/.test(clean), "phải có step fuel gauge ▰▱ trong Build Rail");
    // Diff card — ký hiệu ✎ cho file edits
    assert.ok(/✎/.test(clean), "phải render diff card ✎ cho edit_file/write_file");
    assert.equal(exitCode, 0, `exit code phải là 0 (nhận ${exitCode})`);
  }, 45_000);

  it("slash commands trong PTY: /help + /cost hoạt động sau một run, rồi exit sạch", async () => {
    const outFile = join(tmpdir(), `scoder-tui-slash-${Date.now()}.txt`);
    const proc = spawn(
      "python3",
      [
        "test/pty-run.py",
        "--timeout", "30",
        "--send-after", "All done:/help\\r",
        "--send-after", "(scoder tui):/cost\\r",
        "--send-after", "2:(scoder tui):exit\\r",
        "--out", outFile,
        "--",
        "node", "dist/index.js",
        "-d", tmp,
        "tui",
        "fix the bug in lib.js",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SCODER_API_KEY: "test",
          SCODER_BASE_URL: `http://127.0.0.1:${mockPort}`,
          SCODER_NO_SAVE: "1",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    const exitCode = await new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? 0)));
    const clean = stripAnsi(readFileSync(outFile, "utf8"));

    assert.ok(/Commands \(scoder tui\)/.test(clean), `phải render /help listing (tail: ${clean.slice(-400)})`);
    assert.ok(clean.includes("/clear") && clean.includes("/cost"), "/help phải liệt kê /clear, /cost");
    assert.ok(/no LLM calls yet|session usage/.test(clean), "/cost phải báo usage");
    assert.equal(exitCode, 0, `exit code phải là 0 (nhận ${exitCode})`);
  }, 30_000);
});

after(() => {
  mock.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
