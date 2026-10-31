/**
 * Unit tests cho agents + task subagent tool (I-06).
 * Chạy: node --test test/agents.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, findAgent } from "../dist/agents.js";
import { getTool, setTaskRunner, allToolSpecs } from "../dist/tools.js";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "agents-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  setTaskRunner(null);
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
});

describe("task tool (I-06)", () => {
  it("spec nằm trong allToolSpecs", () => {
    assert.ok(allToolSpecs().some((t) => t.function.name === "task"));
  });

  it("chưa wire → lỗi rõ ràng", async () => {
    const tool = getTool("task");
    assert.ok(tool);
    const r = await tool.run({ workdir }, { description: "d", prompt: "p" });
    assert.equal(r.ok, false);
    assert.match(r.output, /not wired/);
  });

  it("wire runner → chạy và trả summary", async () => {
    setTaskRunner(async (_ctx, args) => {
      assert.equal(args.prompt, "find the auth code");
      return { ok: true, output: "[subagent explore done — 2 steps]\nauth lives in src/auth.ts" };
    });
    const tool = getTool("task");
    const r = await tool.run({ workdir }, { description: "locate auth", prompt: "find the auth code" });
    assert.equal(r.ok, true);
    assert.match(r.output, /src\/auth\.ts/);
  });

  it("agent name lạ → lỗi sạch", async () => {
    setTaskRunner(async () => ({ ok: false, output: "ERROR: agent \"nope\" not found" }));
    const tool = getTool("task");
    const r = await tool.run({ workdir }, { description: "d", prompt: "p", agent: "nope" });
    assert.equal(r.ok, false);
  });
});
