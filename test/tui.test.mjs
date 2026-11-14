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

/**
 * Ngữ cảnh khi fail: số byte thô, stderr của pty-run, exit code — CI từng
 * có output rỗng mà không rõ con chết hay bị đói CPU (run 43568456376),
 * assertion cũ chỉ in `clean.slice(-300)` (= rỗng, vô dụng).
 */
function ctx(clean, rawLen, ptyErr, exitCode) {
  return `raw=${rawLen}B pty-run="${ptyErr.trim().slice(0, 160)}" exit=${exitCode} clean="${clean.replace(/\s+/g, " ").slice(0, 200)}"`;
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

describe("scoder tui — Ink full-screen UI", { concurrency: 1 }, () => {
  /**
   * Chạy TUI trong PTY thật qua pty-run.py; trả { clean, raw, exitCode,
   * ptyErr }. stderr của pty-run được BẮT (trước đây vứt vào /dev/null) vì
   * nó chứa mã lỗi thật ("pty-run: TIMEOUT" = con còn sống nhưng không kịp
   * render — runner 4-core cold `npm ci` từng trắng màn hình 30s).
   * --timeout 60 (gấp đôi) + it() 90s chống contention; local vẫn xong ~5s.
   */
  async function runPty(tag, sendAfter) {
    const outFile = join(tmpdir(), `scoder-tui-${tag}-${Date.now()}.txt`);
    const proc = spawn(
      "python3",
      [
        "test/pty-run.py",
        "--timeout", "60",
        ...sendAfter,
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
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let ptyErr = "";
    proc.stderr.on("data", (c) => (ptyErr += c));
    const exitCode = await new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? 0)));
    const raw = readFileSync(outFile, "utf8");
    return { clean: stripAnsi(raw), raw, exitCode, ptyErr };
  }

  it("chạy closed-loop trong PTY: header + tool calls + build passed + success, rồi exit sạch", async () => {
    const { clean, raw, exitCode, ptyErr } = await runPty("out", [
      "--send-after", "build passed|All done:exit\\r",
    ]);
    const where = () => ctx(clean, raw.length, ptyErr, exitCode);

    assert.ok(clean.includes("scoder"), `phải render header 'scoder' (${where()})`);
    assert.ok(clean.includes("write_file") || clean.includes("edit_file"), `phải render tool calls (${where()})`);
    assert.ok(clean.includes("run_command"), "phải render run_command (build)");
    assert.ok(/build passed|All done/i.test(clean), `phải render finish (tail: ${clean.slice(-300)})`);
    assert.ok(/success/i.test(clean), "status bar phải chuyển sang success");
    assert.ok(/esc abor|ctrl\+t/i.test(clean), "phải có status bar với keybind hints");
    // Build Rail — bản sắc riêng: đèn build + step fuel gauge
    assert.ok(/● build (ok|fail)|no build yet/.test(clean), `phải có build lamp trong Build Rail (tail: ${clean.slice(-300)})`);
    assert.ok(/▰|▱/.test(clean), "phải có step fuel gauge ▰▱ trong Build Rail");
    // Diff card — ký hiệu ✎ cho file edits
    assert.ok(/✎/.test(clean), "phải render diff card ✎ cho edit_file/write_file");
    assert.equal(exitCode, 0, `exit code phải là 0 (nhận ${exitCode}; ${where()})`);
  }, 90_000);

  it("slash commands trong PTY: /help + /cost hoạt động sau một run, rồi exit sạch", async () => {
    const { clean, raw, exitCode, ptyErr } = await runPty("slash", [
      "--send-after", "All done:/help\\r",
      // Trigger /cost bằng dòng CUỐI của listing — luôn nằm đáy viewport
      // (chat hẹp đi 30 cột sidebar nên tiêu đề listing có thể bị clip khỏi
      // vùng render; dòng cuối luôn thấy).
      "--send-after", "Anything else is sent to the agent:/cost\\r",
      "--send-after", "session usage|no LLM calls:exit\\r",
    ]);
    const where = () => ctx(clean, raw.length, ptyErr, exitCode);

    assert.ok(/Anything else is sent to the agent/.test(clean), `phải render /help listing (${where()})`);
    assert.ok(clean.includes("/skill") && clean.includes("/mcp"), "/help phải liệt kê /skill, /mcp");
    assert.ok(/no LLM calls yet|session usage/.test(clean), "/cost phải báo usage");
    assert.equal(exitCode, 0, `exit code phải là 0 (nhận ${exitCode}; ${where()})`);
  }, 90_000);
});

after(() => {
  mock.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
