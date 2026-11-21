/**
 * P7 — git context trong chrome: hook (probe mock, refresh when idle/finish,
 * stale-response guard) + Ink render asserting where the chip paints.
 * Chạy: node --test test/tui-git.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { useEffect, useState } from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";

process.env.TERM = "xterm-256color";
delete process.env.SCODER_ASCII;
process.env.NO_COLOR = "";
process.env.FORCE_COLOR = "1";

const { useGitStatus } = await import("../dist/tui/hooks/use-git-status.js");
const { gitChip } = await import("../dist/workspace/git-status.js");
const { BuildRail, StatusBar } = await import("../dist/tui/chrome.js");
const { initialState } = await import("../dist/tui/state.js");

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

async function paint(el, columns = 120, rows = 30) {
  const stream = new PassThrough();
  stream.columns = columns;
  stream.rows = rows;
  let out = "";
  stream.on("data", (c) => (out += String(c)));
  const app = render(el, { stdout: stream, stderr: stream, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 100));
  app.unmount();
  await app.waitUntilExit();
  return stripAnsi(out);
}

const cfg = { workdir: "/tmp/x", model: "m1", provider: "openai", permissionMode: "auto", limits: {} };

// ── hook ────────────────────────────────────────────────────────────────────

describe("useGitStatus", () => {
  it("probes on mount and paints the result", async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
      return { branch: "main", detached: false, dirty: 3 };
    };
    function Harness() {
      const g = useGitStatus("/tmp/x", false, probe);
      return React.createElement(Text, null, gitChip(g) ?? "none");
    }
    const out = await paint(React.createElement(Harness));
    assert.match(out, /main · ±3/);
    assert.equal(calls, 1, "mount probe once");
  });

  it("re-probes when a run finishes (running true → false)", async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
      return { branch: "main", detached: false, dirty: calls };
    };
    function Harness() {
      const [running, setRunning] = useState(true);
      useEffect(() => {
        const t = setTimeout(() => setRunning(false), 40);
        return () => clearTimeout(t);
      }, []);
      const g = useGitStatus("/tmp/x", running, probe);
      return React.createElement(Text, null, gitChip(g) ?? "none");
    }
    const out = await paint(React.createElement(Harness));
    assert.match(out, /main · ±2/, `finish phải probe lại (calls=${calls})`);
    assert.equal(calls, 2, "mount + finish, không poll dư");
  });

  it("a slow response from an OLD workdir never overwrites the new one", async () => {
    const probe = (d) =>
      d === "slow"
        ? new Promise((res) => setTimeout(() => res({ branch: "old-slow", detached: false, dirty: 9 }), 70))
        : Promise.resolve({ branch: "new-fast", detached: false, dirty: 1 });
    function Harness() {
      const [dir, setDir] = useState("slow");
      useEffect(() => {
        const t = setTimeout(() => setDir("fast"), 20);
        return () => clearTimeout(t);
      }, []);
      const g = useGitStatus(dir, true, probe);
      return React.createElement(Text, null, gitChip(g) ?? "none");
    }
    const out = await paint(React.createElement(Harness));
    assert.match(out, /new-fast/, "dir mới phải thắng");
    assert.ok(!/old-slow/.test(out), `stale result từ dir cũ leaked: ${JSON.stringify(out.slice(-80))}`);
  });
});

// ── chrome rendering ────────────────────────────────────────────────────────

describe("git chip placement", () => {
  const git = { branch: "feat/login", detached: false, dirty: 4 };

  it("idle → rail center shows branch + dirty; status bar does not duplicate", async () => {
    const rail = await paint(React.createElement(BuildRail, { state: initialState(), config: cfg, git }));
    assert.match(rail, /⎇ feat\/login · ±4/, `rail phải có chip (tail: ${JSON.stringify(rail.slice(-120))})`);
    const bar = await paint(React.createElement(StatusBar, { state: initialState(), git }));
    assert.ok(!/feat\/login/.test(bar), "idle: không lặp lại chip ở StatusBar");
  });

  it("running → breadcrumb giữ giữa rail, chip dồn sang StatusBar trái", async () => {
    const st = { ...initialState(), status: "running", summary: null };
    const rail = await paint(React.createElement(BuildRail, { state: st, config: cfg, git }));
    assert.ok(!/feat\/login/.test(rail), `running: rail không có chip (${rail.slice(-120)})`);
    const bar = await paint(React.createElement(StatusBar, { state: st, git }));
    assert.match(bar, /⎇ feat\/login · ±4/);
  });

  it("guardrail fired → chip cũng rời sang StatusBar", async () => {
    const st = { ...initialState(), status: "success", lastGuardrail: "text-only streak" };
    const bar = await paint(React.createElement(StatusBar, { state: st, git }));
    assert.match(bar, /⎇ feat\/login/);
  });

  it("không có git (probe null) → không có glyph ⎇ ở đâu cả", async () => {
    const rail = await paint(React.createElement(BuildRail, { state: initialState(), config: cfg, git: null }));
    const bar = await paint(React.createElement(StatusBar, { state: initialState(), git: null }));
    assert.ok(!/⎇/.test(rail + bar), "non-repo: chip ẩn hoàn toàn");
    assert.match(rail, /ready/);
  });

  it("cửa hẹp: chip bị bỏ chứ không đẩy footer tràn ngang", async () => {
    const st = { ...initialState(), status: "running", model: "very-long-model-name/with-path" };
    const bar = await paint(React.createElement(StatusBar, { state: st, git }), 60, 20);
    const line = bar.split("\n").filter(Boolean).at(-1) ?? "";
    assert.ok(line.length <= 60, `footer ≤ 60 cell (đo ${line.length}): ${JSON.stringify(line)}`);
  });
});
