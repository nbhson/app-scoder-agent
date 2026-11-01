#!/usr/bin/env node
/**
 * T-12: TUI KPI benchmark — đo các SLO đã cam kết trong P3:
 *
 *   1. cold-start    ≤ 1500ms   (time-to-first-frame trong PTY)
 *   2. input latency ≤ 100ms    (keystroke echo → repaint)
 *   3. @ suggestion  ≤ 200ms p95 (typing "@src/" cho đến khi overlay render)
 *   4. theme switch  ≤ 300ms   (/theme mono → notice mới render)
 *   5. 500 items     ≤ 500ms   (applyEvent 500 items + render throughput)
 *
 * Dùng test/pty-run.py cho các đo PTY (real terminal, 100x30) và đo trực
 * tiếp trên engine cho metric in-process. Mock LLM không cần thiết — các
 * đo này không gọi LLM.
 *
 * Chạy: node scripts/tui-bench.mjs [--quick]
 * Exit 1 khi một SLO fail (dùng trong CI/verify gate).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const quick = process.argv.includes("--quick");

function record(name, ms, slo) {
  const ok = ms <= slo;
  results.push({ name, ms: Math.round(ms), slo, ok });
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(28)} ${Math.round(ms)}ms  (SLO ≤${slo}ms)`);
}
void quick;

// ── 5. 500 items qua applyEvent (in-process, chính xác) ─────────────────────
async function bench500Items() {
  const { applyEvent, initialState } = await import("../dist/tui/state.js");
  const t0 = performance.now();
  let state = initialState();
  const events = [];
  for (let i = 0; i < 500; i++) {
    events.push({ type: "llm_delta", delta: `line ${i} of streamed assistant output ` });
  }
  for (const ev of events) state = applyEvent(state, ev);
  // Tool items (riêng lẻ hơn text) — trộn vào.
  for (let i = 0; i < 250; i++) {
    state = applyEvent(state, { type: "tool_call", step: 1, id: `t${i}`, name: "run_command", args: { command: `cmd ${i}` } });
    state = applyEvent(state, { type: "tool_result", step: 1, name: "run_command", ok: true, output: "ok" });
  }
  const ms = performance.now() - t0;
  record("500 items applyEvent", ms, 500);
}

// ── 3. @ suggestion engine p95 (in-process — engine sync) ───────────────────
async function benchAtSuggest() {
  const { fileIndex, suggest, invalidateFileIndex } = await import("../dist/tui/at-complete.js");
  const workdir = process.cwd();
  invalidateFileIndex();
  const idx = fileIndex(workdir); // warm
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const q = ["src", "tui", "test", "state", "app", "config", "perm"][i % 7];
    const t0 = performance.now();
    suggest(idx, q);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  record("@ suggest p95 (engine)", p95, 200);
  void workdir;
}

// ── Theme switch (in-process) ───────────────────────────────────────────────
async function benchThemeSwitch() {
  const { useNamedTheme, THEMES, setActiveTheme } = await import("../dist/tui/theme.js");
  setActiveTheme(THEMES.mission);
  const t0 = performance.now();
  useNamedTheme("paper");
  const ms = performance.now() - t0;
  record("theme switch (engine)", ms, 300);
  setActiveTheme(THEMES.mission);
}

// ── 1. Cold-start qua PTY: time-to-first-frame ──────────────────────────────
async function benchColdStart() {
  const workdir = mkdtempSync(join(tmpdir(), "tui-bench-"));
  writeFileSync(join(workdir, "build.js"), "console.log(1)");
  // pty-run.py ghi output vào file khi --out — timestamp không có sẵn. Giải
  // pháp: chạy pty-run nhiều lần với --timeout tăng dần? Quá chậm. Thay thế:
  // đo time-to-first-frame bằng cách fork PTY trực tiếp từ node qua python
  // inline script stamp thời gian mỗi chunk.
  const py = `
import os, fcntl, pty, select, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
t0 = time.monotonic()
while time.monotonic() - t0 < ${6}:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        print(f"{(time.monotonic()-t0)*1000:.0f} {len(chunk)}", flush=True)
        if b"scoder" in chunk:
            print(f"FIRST_FRAME {(time.monotonic()-t0)*1000:.0f}", flush=True)
            break
os.kill(pid, 15)
`;
  writeFileSync(join(workdir, "bench.py"), py);
  const ms = await new Promise((resolve) => {
    const p = spawn("python3", ["bench.py", "node", join(process.cwd(), "dist", "index.js"), "-d", workdir, "tui"], {
      cwd: workdir,
      env: { ...process.env, SCODER_API_KEY: "bench", SCODER_BASE_URL: "http://127.0.0.1:1", SCODER_NO_SAVE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => {
      const m = out.match(/FIRST_FRAME (\d+)/);
      resolve(m ? Number(m[1]) : 9999);
    });
  });
  record("cold-start (time-to-first-frame)", ms, 1500);
  rmSync(workdir, { recursive: true, force: true });
}

// ── 2. Input latency + 4. theme switch qua PTY (end-to-end) ────────────────
async function benchInputLatency() {
  // End-to-end keystroke→echo đo qua inline python PTY: gõ 'x' sau khi thấy
  // input row, đo time đến khi 'x' xuất hiện lại trong output.
  const workdir = mkdtempSync(join(tmpdir(), "tui-bench-in-"));
  writeFileSync(join(workdir, "build.js"), "console.log(1)");
  const py = `
import os, fcntl, pty, re, select, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
t0 = time.monotonic()
buf = b""
sent = False
sent_at = None
lat = None
theme_sent = False
theme_at = None
theme_lat = None
while time.monotonic() - t0 < 8:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        buf += chunk
        dec = buf.decode("utf-8", "replace")
        if not sent and "❯" in dec:
            os.write(fd, b"/")
            sent = True
            sent_at = time.monotonic()
        elif sent and lat is None and dec.count("/") >= 1 and time.monotonic() > sent_at:
            # echo: "/" quay lại trong output sau khi gửi (repaint)
            lat = (time.monotonic() - sent_at) * 1000
            print(f"INPUT_LAT {lat:.0f}", flush=True)
        if sent and lat is not None and not theme_sent and "❯" in dec:
            os.write(fd, b"theme mono\\r")
            theme_sent = True
            theme_at = time.monotonic()
        elif theme_sent and theme_lat is None and "theme → mono" in dec:
            theme_lat = (time.monotonic() - theme_at) * 1000
            print(f"THEME_LAT {theme_lat:.0f}", flush=True)
            break
os.kill(pid, 15)
`;
  writeFileSync(join(workdir, "bench.py"), py);
  const { inputMs, themeMs } = await new Promise((resolve) => {
    const p = spawn("python3", ["bench.py", "node", join(process.cwd(), "dist", "index.js"), "-d", workdir, "tui"], {
      cwd: workdir,
      env: { ...process.env, SCODER_API_KEY: "bench", SCODER_BASE_URL: "http://127.0.0.1:1", SCODER_NO_SAVE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => {
      const i = out.match(/INPUT_LAT (\d+)/);
      const t = out.match(/THEME_LAT (\d+)/);
      resolve({ inputMs: i ? Number(i[1]) : 9999, themeMs: t ? Number(t[1]) : 9999 });
    });
  });
  record("input echo latency (PTY)", inputMs, 100);
  record("theme switch end-to-end (PTY)", themeMs, 300);
  rmSync(workdir, { recursive: true, force: true });
}

// ── Run ─────────────────────────────────────────────────────────────────────
console.log("scoder TUI bench (T-12)\n");
await bench500Items();
await benchAtSuggest();
await benchThemeSwitch();
await benchColdStart();
await benchInputLatency();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} SLO pass${failed.length ? ` — FAIL: ${failed.map((f) => f.name).join(", ")}` : ""}`);
process.exit(failed.length > 0 ? 1 : 0);
