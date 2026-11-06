/**
 * Phase 8 — Migration / backward-compat test.
 * Verifies that old config schemas (0.8.x), old event formats, and old skill
 * frontmatter load correctly in 0.9.0.
 *
 * Chạy: node --test test/migration.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_SCHEMA_VERSION, resolvePrimaryConfig } from "../dist/agent.js";
import { discoverSkills } from "../dist/context/skills.js";
import { initialState, applyEvent } from "../dist/tui/state.js";

describe("config migration — 0.8.x → 0.9.0", () => {
  it("minimal 0.8 config (no mcpServers, no routing) resolves unchanged", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cfg-mig1-"));
    try {
      // v0.8 had only: agent, model, provider, workdir, buildCmd, permission.
      const oldConfig = {
        agent: "build",
        model: "gpt-4o",
        provider: "openai",
        workdir: tmp,
        buildCmd: "npm run build",
        permissionMode: "auto",
      };
      const { config, def } = resolvePrimaryConfig(oldConfig);
      assert.equal(config.agent, "build");
      assert.equal(config.model, "gpt-4o");
      assert.ok(def, "build def found");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("0.8 config with routing key (plan) resolves plan routing", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cfg-mig2-"));
    try {
      const oldConfig = {
        agent: "plan",
        model: "gpt-4o-mini",
        provider: "openai",
        workdir: tmp,
        routing: { plan: "gpt-4o" },
        permissionMode: "readonly",
      };
      const { config } = resolvePrimaryConfig(oldConfig);
      assert.equal(config.agent, "plan");
      assert.equal(config.model, "gpt-4o", "routing.plan overrode the model");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("0.8 unknown agent falls back to build (no crash)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cfg-mig3-"));
    try {
      const oldConfig = { agent: "does-not-exist", model: "m", provider: "openai", workdir: tmp, permissionMode: "auto" };
      const { config } = resolvePrimaryConfig(oldConfig);
      assert.equal(config.agent, "build");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("event schema backward compat", () => {
  it("EVENT_SCHEMA_VERSION is 2", () => {
    assert.equal(EVENT_SCHEMA_VERSION, 2);
  });

  it("old run_start without v2 fields (no agent, no schemaVersion) still folds", () => {
    // v0.8 events lacked agent/schemaVersion.
    const ev = { type: "run_start", task: "fix bug", model: "gpt-4o", provider: "openai", workdir: "/tmp", buildCmd: "make", permission: "auto" };
    const s = applyEvent(initialState(), ev);
    assert.equal(s.status, "running");
    assert.equal(s.agent, "build"); // default fill
  });

  it("old run_start with agent (v2 partial) still folds", () => {
    const ev = { type: "run_start", task: "x", model: "x", provider: "openai", workdir: "/tmp", buildCmd: "x", permission: "auto", agent: "review" };
    const s = applyEvent(initialState(), ev);
    assert.equal(s.agent, "review");
  });

  it("old tool_result without id still correlates by name (backward compat)", () => {
    const s = applyEvent(initialState(), { type: "run_start", task: "x", model: "x", provider: "openai", workdir: "/tmp", buildCmd: "x", permission: "auto" });
    applyEvent(s, { type: "tool_call", step: 1, name: "read_file", args: {} });
    applyEvent(s, { type: "tool_result", step: 1, name: "read_file", ok: true, output: "ok" });
    const lastTool = s.items[s.items.length - 1];
    assert.equal(lastTool.kind, "tool");
    assert.equal(lastTool.ok, true);
  });
});

describe("skill format backward compat", () => {
  it("v1 skill (no frontmatter, body only) is silently skipped (requires name+description)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "skill-mig-"));
    try {
      mkdirSync(join(tmp, ".scoder", "skills"), { recursive: true });
      await writeFile(join(tmp, ".scoder", "skills", "old-skill.md"), "Review code.\n");
      const skills = discoverSkills(tmp);
      // v1 body-only skill (no frontmatter) → loadSkillFile returns null → not found.
      assert.ok(!skills.some((s) => s.name === "old-skill"), "body-only skill skipped");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("v1 skill with minimal frontmatter (name + description) loads correctly", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "skill-mig2-"));
    try {
      // Convention: skills/<skill-name>/SKILL.md (Anthropic-style subdirectory).
      mkdirSync(join(tmp, ".scoder", "skills", "my-skill"), { recursive: true });
      await writeFile(join(tmp, ".scoder", "skills", "my-skill", "SKILL.md"), [
        "---",
        "name: my-skill",
        "description: Run analysis",
        "---",
        "Run the analysis on the codebase.",
      ].join("\n"));
      const skills = discoverSkills(tmp);
      const skill = skills.find((s) => s.name === "my-skill");
      assert.ok(skill, "my-skill discovered");
      assert.equal(skill.description, "Run analysis");
      assert.ok(skill.body.includes("analysis"), "body preserved");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
