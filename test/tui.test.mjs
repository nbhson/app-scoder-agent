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
import { spawn, execFileSync } from "node:child_process";
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
   * nó chứa mã lỗi thật ("pty-run: TIMEOUT" = con sống mà không in frame nào)
   * — chính tín hiệu đó đã vạch trần Ink CI-gate (xem env bên dưới).
   * --timeout 60 + it() 90s chống contention runner chia sẻ.
   */
  async function runPty(tag, sendAfter, dir = tmp) {
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
        "-d", dir,
        "tui",
        "fix the bug in lib.js",
      ],
      {
        cwd: process.cwd(),
        env: (() => {
          const e = {
            ...process.env,
            SCODER_API_KEY: "test",
            SCODER_BASE_URL: `http://127.0.0.1:${mockPort}`,
            SCODER_NO_SAVE: "1",
          };
          // ROOT CAUSE (mà CI 2 PTY test chưa từng xanh): Ink 8 gate
          // interactivity bằng is-in-ci — env CI/CONTINUOUS_INTEGRATION tồn tại
          // ⇒ interactive=false KỂ CẢ khi stdout là TTY thật ⇒ renderFrame
          // không bao giờ in frame (raw=16B, pty TIMEOUT 124). Con ở đây mô
          // phỏng đầu cuối người dùng thật — không được kế thừa CI.
          delete e.CI;
          delete e.CONTINUOUS_INTEGRATION;
          return e;
        })(),
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

  it("⇧⇥ cycle agent + ⇧P cycle permission (input trống) — dispatch qua /agent, /permission", async () => {
    // "\x1b[Z" = legacy Shift+Tab (backtab); "P" = Shift+P trên terminal legacy.
    const { clean, raw, exitCode, ptyErr } = await runPty("cycles", [
      "--send-after", "All done:\x1b[Z",
      "--send-after", "agent → plan:P",
      "--send-after", "permission mode → ask:exit\\r",
    ]);
    const where = () => ctx(clean, raw.length, ptyErr, exitCode);
    assert.ok(/agent → plan/.test(clean), `⇧⇥ phải switch build→plan (${where()})`);
    assert.ok(/permission mode → ask/.test(clean), `⇧P phải cycle auto→ask (${where()})`);
    assert.equal(exitCode, 0, `exit code phải là 0 (nhận ${exitCode}; ${where()})`);
  }, 90_000);

  it("⇧⏎ (kitty CSI 13;2u) xuống dòng trong input, không submit", async () => {
    // Buffer còn nguyên "MARK-A⏎MARK-B" nên đóng bằng Ctrl+C (idle → quit
    // ngay), không gõ "exit" — exit sẽ bị ghép vào dòng thứ 3.
    const { clean, raw, exitCode, ptyErr } = await runPty("multiline", [
      "--send-after", "All done:MARK-A\x1b[13;2uMARK-B",
      "--send-after", "MARK-B:\x03",
    ]);
    const where = () => ctx(clean, raw.length, ptyErr, exitCode);
    assert.ok(/MARK-A/.test(clean) && /MARK-B/.test(clean), `cả 2 dòng phải hiện trong input (${where()})`);
    assert.ok(!/MARK-AMARK-B/.test(clean), "⇧⏎ phải ngắt thành 2 dòng, không nối một dòng");
    assert.equal(exitCode, 0, `exit code phải là 0 (nhận ${exitCode}; ${where()})`);
  }, 90_000);

  it("git repo thật → ⎇ branch xuất hiện trên rail sau khi run xong (P7)", async () => {
    // Project riêng, có git init, để probe thật chạy (branch + dirty).
    const repo = mkdtempSync(join(tmpdir(), "scoder-tui-git-"));
    writeFileSync(join(repo, "build.js"), "console.log('PASS');\n");
    writeFileSync(join(repo, "lib.js"), "module.exports.add = (a, b) => a - b; // BUG\n");
    execFileSync("git", ["init", "-b", "main", "--quiet"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

    const { clean, raw, exitCode, ptyErr } = await runPty("gitchip", [
      "--send-after", "All done|build passed:exit\\r",
    ], repo);
    const where = () => ctx(clean, raw.length, ptyErr, exitCode);
    try {
      assert.ok(/All done/i.test(clean), `run phải xong (${where()})`);
      assert.match(clean, /⎇ main/, `UI phải có git chip — rail hoặc status bar (${clean.slice(-200)})`);
      assert.equal(exitCode, 0, `exit code phải là 0 (nhận ${exitCode}; ${where()})`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 90_000);

  it("focus-out + finish → OSC 777 notify frame trên stdout (P6)", async () => {
    // Terminal gửi \x1b[O (focus out) qua stdin khi người dùng rời cửa sổ —
    // app phải quan sát ở raw level và phát OSC 777 khi run kết thúc.
    // Inject ngay khi header xuất hiện: chắc chắn BEFORE finish (else the
    // focused-fallback wouldn't have time to flip) và app đã mount listener.
    const { clean, raw, exitCode, ptyErr } = await runPty("notify", [
      "--send-after", "scoder:\x1b[O",
      "--send-after", "All done|FAILED:exit\r",
    ]);
    const where = () => ctx(clean, raw.length, ptyErr, exitCode);
    assert.ok(/All done|build passed/i.test(clean), `run phải kết thúc (${where()})`);
    assert.ok(
      /\x1b]777;notify;SCoder;/.test(raw),
      `stdout phải chứa OSC 777 notify (${where()})`,
    );
    assert.match(raw, /\x1b\]777;notify;SCoder;(done|FAILED)[^\x07]*\x07/, "frame đủ status + counters");
    assert.equal(exitCode, 0, `exit code phải là 0 (nhận ${exitCode}; ${where()})`);
  }, 90_000);

  it("⌃B chuyển sidebar sang tab HARNESS LOG — rows thật, time column, hints (P8)", async () => {
    const { clean, raw, exitCode, ptyErr } = await runPty("logtab", [
      // Run xong (idle) → ⌃B bật tab LOG. Anchor "select…f filter" là footer
      // hint CHỈ có trên tab LOG (label "HARNESS LOG" hiện cả khi OVERVIEW).
      // F → dump viewer; " entries" khớp header dump → esc đóng; hint #2 → ⌃C quit.
      "--send-after", "All done:\x02",
      "--send-after", "select.{0,60}f filter:F",
      "--send-after", " entries:\x1b",
      "--send-after", "2:select.{0,60}f filter:\x03",
    ]);
    const where = () => ctx(clean, raw.length, ptyErr, exitCode);
    assert.ok(/OVERVIEW/.test(clean), `frame đầu phải có tab OVERVIEW (${where()})`);
    assert.ok(/HARNESS LOG/.test(clean), `⌃B phải bật tab HARNESS LOG (${where()})`);
    assert.match(clean, /\d{2}:\d{2}:\d{2}/, "log rows có cột giờ HH:MM:SS");
    assert.match(clean, /→ (ok|PASS|FAIL)|#\d+ /, "rows thật của run (llm/tool/build verdict)");
    assert.match(clean, /(TOOL|SHELL|RUN|LLM|EVT) /, "cột nhãn loại bằng chữ");
    // F → full-screen dump: header + dòng wide (giờ tenths + label cột).
    assert.match(clean, /HARNESS LOG · ALL · \d+ entries/, `F phải mở log dump (${where()})`);
    assert.match(clean, /\d\d:\d\d:\d\d\.\d (RUN|LLM|TOOL|SHELL|FILE|BUILD|MCP|SUB|GUARD|PERM|EVT)/, "dòng dump đủ cột giờ + tên loại");
    assert.ok(!/❯ F/.test(clean), "phím F tắt input — không rơi vào dòng soạn thảo");
    assert.match(clean, /↑↓ select/, "key hints của log tab");
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
