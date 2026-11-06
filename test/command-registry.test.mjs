/**
 * T1: unit tests cho command-registry — dispatch dùng chung REPL/TUI.
 * Chạy: node --test test/command-registry.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchCommand,
  coreCommands,
  formatUsage,
  formatSkills,
  formatMcpStatus,
} from "../dist/commands/registry.js";
import { discoverCustomCommands, runCustomCommand } from "../dist/commands/definitions.js";

/** Fake host — agent chỉ cần các method /cost /skills /permission đụng tới. */
/** @typedef {import("../dist/commands/registry.js").CommandHost} CommandHost */
/** @typedef {import("../dist/commands/registry.js").NoticeSink} NoticeSink */

function fakeHost(over = {}) {
  return {
    agent: () => null,
    config: { workdir: "/tmp/x", permissionMode: "auto" },
    replaceAgent: () => {},
    ...over,
  };
}

/** Notice collector. */
function sink() {
  const lines = [];
  return { lines, fn: (text, level = "info") => lines.push({ text, level }) };
}

describe("dispatchCommand (T1)", () => {
  it("input thường → handled:false (frontend gửi LLM)", async () => {
    const s = sink();
    const r = await dispatchCommand("fix the bug", fakeHost(), s.fn);
    assert.equal(r.handled, false);
    assert.equal(r.outcome, null);
    assert.equal(s.lines.length, 0);
  });

  it("/help → notice listing, handled", async () => {
    const s = sink();
    const r = await dispatchCommand("/help", fakeHost(), s.fn);
    assert.equal(r.handled, true);
    assert.match(s.lines[0].text, /Commands/);
    assert.match(s.lines[0].text, /\/cost/);
  });

  it("không phải slash → handled:false", async () => {
    const r = await dispatchCommand("hello world", fakeHost(), sink().fn);
    assert.equal(r.handled, false);
  });

  it("command lạ → error notice", async () => {
    const s = sink();
    const r = await dispatchCommand("/nonexistent", fakeHost(), s.fn);
    assert.equal(r.handled, true);
    assert.equal(s.lines[0].level, "error");
    assert.match(s.lines[0].text, /unknown command/);
  });

  it("/skill không arg → liệt kê skills (merge từ /skills cũ)", async () => {
    const s = sink();
    await dispatchCommand("/skill", fakeHost(), s.fn);
    assert.match(s.lines[0].text, /no skills discovered|Skills:/);
  });

  it("/skill <name> <task> → stage skill rồi trả task để frontend chạy ngay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scoder-skill-cmd-"));
    try {
      mkdirSync(join(dir, ".scoder", "skills", "review"), { recursive: true });
      writeFileSync(join(dir, ".scoder", "skills", "review", "SKILL.md"), "---\nname: code-review\ndescription: review code\n---\nbody");
      const staged = [];
      const host = fakeHost({
        config: { workdir: dir, permissionMode: "auto" },
        agent: () => ({ stageSkill: (n) => { staged.push(n); return { ok: true, message: `staged ${n}` }; } }),
      });
      const s = sink();
      const r = await dispatchCommand("/skill code-review fix the login bug", host, s.fn);
      assert.equal(r.handled, true);
      assert.deepEqual(staged, ["code-review"], "stage đúng skill (không dính task text)");
      assert.equal(r.outcome?.task, "fix the login bug", "task text được trả về để frontend submit ngay");
      assert.match(s.lines[0].text, /staged/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/skill <name> không task → chỉ stage, không trả task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scoder-skill-cmd-"));
    try {
      mkdirSync(join(dir, ".scoder", "skills", "review"), { recursive: true });
      writeFileSync(join(dir, ".scoder", "skills", "review", "SKILL.md"), "---\nname: code-review\ndescription: review code\n---\nbody");
      const host = fakeHost({
        config: { workdir: dir, permissionMode: "auto" },
        agent: () => ({ stageSkill: () => ({ ok: true, message: "staged" }) }),
      });
      const r = await dispatchCommand("/skill code-review", host, sink().fn);
      assert.equal(r.handled, true);
      assert.equal(r.outcome?.task, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handler ném lỗi → bắt thành error notice (không crash dispatcher)", async () => {
    const s = sink();
    const host = fakeHost({
      agent: () => {
        throw new Error("boom from agent");
      },
    });
    const r = await dispatchCommand("/cost", host, s.fn);
    assert.equal(r.handled, true);
    assert.equal(s.lines[0].level, "error");
    assert.match(s.lines[0].text, /boom from agent/);
  });

  it("agent null → /cost fallback zero usage", async () => {
    const s = sink();
    await dispatchCommand("/cost", fakeHost(), s.fn);
    assert.match(s.lines[0].text, /no LLM calls yet/);
  });

  it("/compact → gọi agent.compactHistory và hiển thị kết quả", async () => {
    const s = sink();
    let calls = 0;
    const host = fakeHost({
      agent: () => ({
        compactHistory: async () => {
          calls++;
          return { ok: true, message: "compaction done: 20 → 4 messages" };
        },
      }),
    });
    const r = await dispatchCommand("/compact", host, s.fn);
    assert.equal(r.handled, true);
    assert.equal(calls, 1);
    assert.match(s.lines[0].text, /compaction done/);
  });

  it("/compact khi agent đang chạy → warn, không gọi compactHistory", async () => {
    const s = sink();
    let calls = 0;
    const host = fakeHost({
      isRunning: () => true,
      agent: () => ({ compactHistory: async () => { calls++; return { ok: true, message: "x" }; } }),
    });
    await dispatchCommand("/compact", host, s.fn);
    assert.equal(calls, 0);
    assert.equal(s.lines[0].level, "warn");
    assert.match(s.lines[0].text, /running/);
  });

  it("/compact khi chưa có agent → warn", async () => {
    const s = sink();
    await dispatchCommand("/compact", fakeHost(), s.fn);
    assert.equal(s.lines[0].level, "warn");
    assert.match(s.lines[0].text, /agent not ready/);
  });

  it("extra command được nhận trước core (frontend-specific override)", async () => {
    const s = sink();
    const r = await dispatchCommand("/cost", fakeHost(), s.fn, [
      { name: "/cost", description: "override", run: () => ({ notice: "OVERRIDE" }) },
    ]);
    assert.equal(r.handled, true);
    assert.equal(r.outcome?.notice, "OVERRIDE");
    assert.equal(s.lines.length, 0);
  });

  it("coreCommands: mỗi entry có name bắt đầu / + description", () => {
    for (const c of coreCommands()) {
      assert.ok(c.name.startsWith("/"));
      assert.ok(c.description.length > 0);
      assert.equal(typeof c.run, "function");
    }
    assert.ok(coreCommands().some((c) => c.name === "/mcp"));
    assert.ok(coreCommands().some((c) => c.name === "/skill"));
    assert.ok(coreCommands().some((c) => c.name === "/compact"));
  });
});

describe("formatters (T1)", () => {
  it("formatUsage: zero + có cached", () => {
    assert.match(formatUsage({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), /no LLM calls yet/);
    assert.match(
      formatUsage({ calls: 2, inputTokens: 100, outputTokens: 50, cachedTokens: 10 }),
      /2 LLM calls.*in 100 \/ out 50.*\+10 cached/s,
    );
  });
  it("formatSkills: rỗng + có skill", () => {
    assert.match(formatSkills([]), /no skills discovered/);
    assert.match(formatSkills([{ name: "rev", description: "review code", path: "/p", scope: "project", body: "" }]), /rev\s+review code\s+\[project\]/);
  });
  it("formatMcpStatus: rỗng + server không kết nối + tool", () => {
    assert.match(formatMcpStatus([]), /no MCP servers configured/);
    const t = formatMcpStatus([{ name: "srv", command: "node x.js", connected: false, tools: [] }]);
    assert.match(t, /· srv — node x\.js \(not connected\)/);
    const t2 = formatMcpStatus([{ name: "srv", command: "c", connected: true, tools: [{ name: "t1", description: "d" }] }]);
    assert.match(t2, /✓ srv/);
    assert.match(t2, /mcp__srv__t1\s+d/);
  });
});

// ── Phase 6: custom commands ────────────────────────────────────────────────

describe("discoverCustomCommands", () => {
  it("finds project-level custom command from .scoder/commands/", async () => {
    const tmp = mkdirSync(join(tmpdir(), "cmd-test-" + Math.random()), { recursive: true });
    try {
      const cmdDir = join(tmp, ".scoder", "commands");
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, "review-fix.md"), [
        "---",
        "name: review-fix",
        "description: Review all changed files",
        "args: [path]",
        "---",
        "Review @$1 and list blocking issues.",
      ].join("\n"));
      const cmds = discoverCustomCommands(tmp);
      assert.equal(cmds.length, 1);
      assert.equal(cmds[0].name, "review-fix");
      assert.equal(cmds[0].description, "Review all changed files");
      assert.deepStrictEqual(cmds[0].args, ["path"]);
      assert.equal(cmds[0].source, "project");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parses frontmatter-less file (name = filename, body = content)", async () => {
    const tmp = mkdirSync(join(tmpdir(), "cmd-test-" + Math.random()), { recursive: true });
    try {
      const cmdDir = join(tmp, ".scoder", "commands");
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, "quick-fix.md"), "Apply the smallest fix that makes the tests pass.\n");
      const cmds = discoverCustomCommands(tmp);
      assert.equal(cmds[0].name, "quick-fix");
      assert.ok(cmds[0].body.includes("smallest fix"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runCustomCommand substitutes $1 $ARGUMENTS in body", async () => {
    const cmd = { name: "x", description: "d", visibility: "public", aliases: [], body: "Review $1\n$ARGUMENTS\nDone", source: "project", filePath: "/tmp/x.md" };
    const out = runCustomCommand(cmd, "src/main.go --verbose");
    assert.match(out, /Review src\/main\.go/);
    assert.match(out, /--verbose/);
  });
});

describe("custom commands dispatch", () => {
  it("/help liệt kê cả custom commands (merge từ /commands cũ)", async () => {
    const tmp = mkdirSync(join(tmpdir(), "cmd-test-" + Math.random()), { recursive: true });
    try {
      const cmdDir = join(tmp, ".scoder", "commands");
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, "mycmd.md"), "---\ndescription: My custom command\n---\nDo the thing.\n");
      const s = sink();
      const host = fakeHost({ config: { workdir: tmp, permissionMode: "auto" } });
      await dispatchCommand("/help", host, s.fn);
      assert.ok(s.lines[0].text.includes("/help"), `should list builtins: ${s.lines[0].text.slice(0, 200)}`);
      assert.ok(s.lines[0].text.includes("/mycmd"), `should list custom: ${s.lines[0].text.slice(0, 400)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("custom prompt command returns a task for the frontend to submit", async () => {
    const tmp = mkdirSync(join(tmpdir(), "cmd-test-" + Math.random()), { recursive: true });
    try {
      const cmdDir = join(tmp, ".scoder", "commands");
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, "fix.md"), "---\ndescription: Fix it\naliases: [repair]\n---\nFix $1.\n");
      const s = sink();
      const r = await dispatchCommand("/repair src/app.ts", fakeHost({ config: { workdir: tmp, permissionMode: "auto" } }), s.fn);
      assert.equal(r.handled, true);
      assert.equal(r.outcome?.task, "Fix src/app.ts.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
