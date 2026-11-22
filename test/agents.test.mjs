/**
 * Unit tests cho agents + task subagent tool (I-06).
 * Chạy: node --test test/agents.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, findAgent, subagentDefs } from "../dist/context/agents.js";
import { Agent } from "../dist/agent.js";
import {getTool, allToolSpecs, baseToolSpecs} from "../dist/tools/registry.js";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "agents-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("discoverAgents (I-06)", () => {
  it("builtins luôn có: build, plan, explore", () => {
    const names = discoverAgents(workdir).map((a) => a.name);
    assert.ok(names.includes("build"));
    assert.ok(names.includes("plan"));
    assert.ok(names.includes("explore"));
  });

  it(".md file trong .scoder/agents được parse + override builtin", () => {
    mkdirSync(join(workdir, ".scoder", "agents"), { recursive: true });
    writeFileSync(
      join(workdir, ".scoder", "agents", "plan.md"),
      "---\ndescription: my custom planner\nmode: primary\nmodel: anthropic/claude-sonnet-4-5\nsteps: 10\n---\nCustom plan prompt body.",
    );
    const plan = findAgent(workdir, "plan");
    assert.equal(plan.description, "my custom planner");
    assert.equal(plan.model, "anthropic/claude-sonnet-4-5");
    assert.equal(plan.steps, 10);
    assert.match(plan.prompt, /Custom plan prompt body/);
  });

  it("disabled: true → bị loại", () => {
    mkdirSync(join(workdir, ".scoder", "agents"), { recursive: true });
    writeFileSync(join(workdir, ".scoder", "agents", "explore.md"), "---\ndisabled: true\n---\nx");
    assert.equal(findAgent(workdir, "explore"), null);
  });

  it("subagentDefs: mode subagent|all non-hidden; custom subagent phải xuất hiện", () => {
    mkdirSync(join(workdir, ".scoder", "agents"), { recursive: true });
    writeFileSync(join(workdir, ".scoder", "agents", "researcher.md"), "---\ndescription: researcher\nmode: subagent\n---\nbody");
    writeFileSync(join(workdir, ".scoder", "agents", "ghost.md"), "---\ndescription: ghost\nmode: subagent\nhidden: true\n---\nbody");
    const names = subagentDefs(discoverAgents(workdir)).map((a) => a.name);
    assert.ok(names.includes("researcher"), "user-defined mode:subagent spawnable được liệt kê");
    assert.ok(names.includes("explore") && names.includes("build") && names.includes("review"));
    assert.ok(!names.includes("plan"), "plan (primary-only) không phải subagent");
    assert.ok(!names.includes("ghost"), "hidden bị loại");
  });
});

describe("task tool (I-06)", () => {
  it("spec nằm trong allToolSpecs", () => {
    assert.ok(allToolSpecs().some((t) => t.function.name === "task"));
  });

  it("agent không được spawn → tool 'task' không được advertise", () => {
    assert.ok(allToolSpecs(false).every((t) => t.function.name !== "task"));
    assert.ok(baseToolSpecs(null, { warn() {} }, false).every((t) => t.function.name !== "task"));
    assert.ok(baseToolSpecs(null, { warn() {} }, true).some((t) => t.function.name === "task"));
  });

  it("chưa wire → lỗi rõ ràng", async () => {
    const tool = getTool("task");
    assert.ok(tool);
    const r = await tool.run({ workdir }, { description: "d", prompt: "p" });
    assert.equal(r.ok, false);
    assert.match(r.output, /not wired/);
  });

  it("child (allowSubagents:false) → message depth-limit, không phải 'not wired'", async () => {
    const tool = getTool("task");
    const r = await tool.run({ workdir, allowSubagents: false }, { description: "d", prompt: "p" });
    assert.equal(r.ok, false);
    assert.match(r.output, /depth limit/);
  });

  it("wire runner qua ctx → chạy và trả summary", async () => {
    const tool = getTool("task");
    const r = await tool.run(
      { workdir, taskRunner: async (_ctx, args) => {
        assert.equal(args.prompt, "find the auth code");
        return { ok: true, output: "[subagent explore done — 2 steps]\nauth lives in src/auth.ts" };
      } },
      { description: "locate auth", prompt: "find the auth code" },
    );
    assert.equal(r.ok, true);
    assert.match(r.output, /src\/auth\.ts/);
  });

  it("agent name lạ → lỗi sạch", async () => {
    const tool = getTool("task");
    const r = await tool.run(
      { workdir, taskRunner: async () => ({ ok: false, output: "ERROR: agent \"nope\" not found" }) },
      { description: "d", prompt: "p", agent: "nope" },
    );
    assert.equal(r.ok, false);
  });

  it("2 ctx song song → runner cô lập (server multi-run)", async () => {
    const tool = getTool("task");
    const a = tool.run({ workdir, taskRunner: async () => ({ ok: true, output: "A" }) }, { description: "d", prompt: "p" });
    const b = tool.run({ workdir, taskRunner: async () => ({ ok: true, output: "B" }) }, { description: "d", prompt: "p" });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.output, "A");
    assert.equal(rb.output, "B");
  });
});

// ── P2: per-Agent output limits + in-flight run guard ──────────────────────

/** Minimal scripted provider (same shape as agent-v2 tests). */
function scripted(turns) {
  class ScriptedClient {
    lastPartialToolCalls = [];
    get model() { return "scripted/mock"; }
    constructor() { this.idx = 0; this.turns = turns; }
    next() {
      const t = this.turns[this.idx++] ?? { content: "done" };
      return {
        message: {
          role: "assistant",
          content: t.content ?? null,
          stop_reason: t.toolCalls ? "tool_calls" : "stop",
          tool_calls: t.toolCalls?.map((x) => ({ id: x.id, name: x.function.name, arguments: x.function.arguments })),
        },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    }
    async chat() {
      if (this.beforeFirst) { await this.beforeFirst; this.beforeFirst = null; }
      return this.next();
    }
    async *streamChat() { const r = this.next(); yield { contentDelta: r.message.content ?? "", done: false }; yield { final: r, done: true }; }
  }
  return new ScriptedClient();
}

describe("subagent summary clamp (P2-limit)", () => {
  it("child summary over limits.maxOutputChars → parent context nhận bản cắt có marker", async () => {
    let built = 0;
    const factory = () => {
      built++;
      if (built === 1) {
        return scripted([
          { toolCalls: [{ id: "t1", type: "function", function: { name: "task", arguments: JSON.stringify({ description: "dig", prompt: "dig deep" }) } }] },
          { content: "done" },
        ]);
      }
      // child: chat-only run, dài vượt mọi trần (finish() cắt 2000 — vẫn trên cap 800)
      return scripted([{ content: "S".repeat(30000) }]);
    };
    const agent = new Agent({
      baseUrl: "http://localhost:0",
      apiKey: "eval",
      model: "scripted/mock",
      provider: "openai",
      workdir,
      buildCmd: null,
      maxSteps: 6,
      yes: true,
      noSave: true,
      snapshots: false,
      stream: false,
      permissionMode: "auto",
      clientFactory: factory,
      allowSubagents: true,
      limits: { maxOutputChars: 800 },
    });
    const events = [];
    agent.onEvent = (ev) => events.push(ev);
    await agent.run("parent task");
    const tr = events.find((e) => e.type === "tool_result" && e.name === "task");
    assert.ok(tr, "task tool_result present");
    assert.match(tr.output, /subagent .* done — \d+ steps/);
    assert.match(tr.output, /subagent summary truncated: \d+ chars/);
    assert.ok(tr.output.length < 1_200, `output phải gọn trong ngân sách (got ${tr.output.length})`);
  });
});

describe("in-flight run guard (P2-guard)", () => {
  it("run() thứ hai khi run thứ nhất còn sống → reject, run thứ nhất không bị phá", async () => {
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    let built = 0;
    const factory = () => {
      built++;
      if (built === 1) {
        const c = scripted([{ content: "first done" }]);
        c.beforeFirst = gate; // chat đầu treo → run #1 ở trong loop
        return c;
      }
      return scripted([{ content: "second should never run" }]);
    };
    const agent = new Agent({
      baseUrl: "http://localhost:0",
      apiKey: "eval",
      model: "scripted/mock",
      provider: "openai",
      workdir,
      buildCmd: null,
      maxSteps: 4,
      yes: true,
      noSave: true,
      snapshots: false,
      stream: false,
      permissionMode: "auto",
      clientFactory: factory,
    });
    const p1 = agent.run("one");
    await assert.rejects(
      () => agent.run("two"),
      /already running/,
      "overlap phải bị từ chối ngay ở entry — trước khi setup ResetRunSignal phá run #1",
    );
    releaseFirst();
    const r1 = await p1;
    assert.equal(r1.success, true, "run #1 phải nguyên vẹn");
    // flag đã release → lần kế tiếp chạy bình thường
    built = 0; // cho run mới script ngắn
    const agent2 = agent;
    await assert.doesNotReject(() => agent2.runTurn("three"), "sau khi xong, entry mới được chấp nhận");
  });

  it("resume() khi đang chạy → reject", async () => {
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    const factory = () => { const c = scripted([{ content: "hang" }]); c.beforeFirst = gate; return c; };
    const agent = new Agent({
      baseUrl: "http://localhost:0",
      apiKey: "eval",
      model: "scripted/mock",
      provider: "openai",
      workdir,
      buildCmd: null,
      maxSteps: 4,
      yes: true,
      noSave: true,
      snapshots: false,
      stream: false,
      permissionMode: "auto",
      clientFactory: factory,
    });
    const p1 = agent.run("busy");
    await assert.rejects(() => agent.resume({ version: 2, id: "x", task: "t", createdAt: "", steps: 0, events: [] }), /already running/);
    releaseFirst();
    await p1;
  });
});
