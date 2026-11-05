/**
 * Phase 1 — Agent profiles & repo context:
 *  resolvePrimaryConfig (routing/tools/permission), read_file ranges, grep
 *  context, list_files depth/exclude/hidden, repo map, AGENTS.md hierarchy.
 * Chạy: npm run build && node --test test/agent-v2.test.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrimaryConfig, Agent } from "../dist/agent.js";
import { filterToolNamesForDef, discoverAgents, selectableAgents, MUTATING_TOOL_SPECS } from "../dist/agents.js";
import { getTool, AGENT_TOOLS } from "../dist/tools.js";
import { buildRepoMap, extractSymbols, repoMapKey } from "../dist/repo-map.js";
import { collectAgentGuides, extractFocusFiles, buildAgentGuideBlock, agentsMdTemplate } from "../dist/agents-guide.js";

const TMP = mkdtempSync(join(tmpdir(), "scoder-v2-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function mkWorkdir() {
  const dir = mkdtempSync(join(TMP, "w-"));
  return dir;
}

describe("resolvePrimaryConfig — routing & def application", () => {
  it("no def changes: name=build keeps base model", () => {
    const wd = mkWorkdir();
    const base = { workdir: wd, agent: "build", model: "gpt-4o-mini", provider: "openai" };
    const { config, def } = resolvePrimaryConfig(base);
    assert.equal(def.name, "build");
    assert.equal(config.model, "gpt-4o-mini");
  });

  it("plan def applies permission readonly + read-only tool filter", () => {
    const wd = mkWorkdir();
    const { config, def } = resolvePrimaryConfig({ workdir: wd, agent: "plan", model: "gpt-4o-mini", provider: "openai" });
    assert.equal(def.name, "plan");
    assert.equal(config.permissionMode, "readonly");
    assert.equal(def.reasoning, "on");
    const names = ["read_file", "write_file", "edit_file", "run_command", "grep"];
    assert.deepEqual(filterToolNamesForDef(names, def), ["read_file", "grep"]);
  });

  it("rc routing overrides def/model, same provider", () => {
    const wd = mkWorkdir();
    const { config } = resolvePrimaryConfig({ workdir: wd, agent: "plan", model: "gpt-4o-mini", provider: "openai", routing: { plan: "gpt-4o" } });
    assert.equal(config.model, "gpt-4o");
    assert.equal(config.provider, "openai");
  });

  it("rc routing cross-provider rebuilds provider resolution", () => {
    const wd = mkWorkdir();
    const { config } = resolvePrimaryConfig({
      workdir: wd, agent: "plan", model: "gpt-4o-mini", provider: "openai", apiKey: "k", routing: { plan: "anthropic/claude-plan-9" },
    });
    assert.equal(config.provider, "anthropic");
    assert.equal(config.model, "claude-plan-9");
    assert.match(config.baseUrl, /anthropic\.com/);
  });

  it("unknown agent falls back to build with def", () => {
    const wd = mkWorkdir();
    const { def } = resolvePrimaryConfig({ workdir: wd, agent: "does-not-exist", model: "m", provider: "openai" });
    assert.equal(def.name, "build");
  });

  it("builtin review agent exists and is readonly", () => {
    const wd = mkWorkdir();
    const review = discoverAgents(wd).find((a) => a.name === "review");
    assert.ok(review, "review builtin present");
    assert.equal(review.permission, "readonly");
    assert.equal(review.mode, "all");
  });

  it("selectableAgents excludes subagents", () => {
    const wd = mkWorkdir();
    const names = selectableAgents(wd).map((a) => a.name);
    assert.ok(names.includes("build") && names.includes("plan") && names.includes("review"));
    assert.ok(!names.includes("explore"));
  });
});

describe("--agent plan: writes never happen (spec-level filter)", () => {
  it("write_file call fails as unknown tool; no file created", async () => {
    const wd = mkWorkdir();
    class ScriptedClient {
      lastPartialToolCalls = [];
      get model() { return "scripted/mock"; }
      constructor() { this.idx = 0; }
      turns = [
        { toolCalls: [{ id: "w1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hacked.txt", content: "x" }) } }] },
        { content: "done" },
      ];
      next() {
        const t = this.turns[this.idx++] ?? { content: "done" };
        return {
          message: { role: "assistant", content: t.content ?? null, stop_reason: t.toolCalls ? "tool_calls" : "stop", tool_calls: t.toolCalls?.map((x) => ({ id: x.id, name: x.function.name, arguments: x.function.arguments })) },
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      }
      async chat() { return this.next(); }
      async *streamChat() { const r = this.next(); yield { contentDelta: r.message.content ?? "", done: false }; yield { final: r, done: true }; }
    }
    const agent = new Agent({
      baseUrl: "http://localhost:0",
      apiKey: "eval",
      model: "scripted/mock",
      provider: "openai",
      workdir: wd,
      buildCmd: null,
      maxSteps: 6,
      yes: true,
      noSave: true,
      snapshots: false,
      stream: false,
      permissionMode: "auto",
      agent: "plan",
      clientFactory: () => new ScriptedClient(),
      allowSubagents: true,
    });
    const events = [];
    agent.onEvent = (ev) => events.push(ev);
    await agent.run("write a file");
    assert.equal(existsSync(join(wd, "hacked.txt")), false, "plan agent must never create files");
    const wr = events.find((e) => e.type === "tool_result" && e.name === "write_file");
    assert.ok(wr, "tool_result for write_file emitted");
    assert.equal(wr.ok, false);
  });
});

describe("read_file offset/limit", () => {
  it("returns the requested slice with a range header", async () => {
    const wd = mkWorkdir();
    const src = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
    writeFileSync(join(wd, "f.txt"), src);
    const readFile = getTool("read_file");
    const r = await readFile.run({ workdir: wd, permissionMode: "auto" }, { path: "f.txt", offset: 10, limit: 5 });
    assert.equal(r.ok, true);
    assert.match(r.output, /\[lines 10-14 of 30/);
    assert.match(r.output, /10: line10/);
    assert.match(r.output, /14: line14/);
    assert.ok(!r.output.includes("15: line15"));
  });

  it("offset past EOF clamps to the last line; full read keeps old format", async () => {
    const wd = mkWorkdir();
    writeFileSync(join(wd, "g.txt"), "a\nb\nc\n");
    const readFile = getTool("read_file");
    const slice = await readFile.run({ workdir: wd, permissionMode: "auto" }, { path: "g.txt", offset: 99, limit: 5 });
    assert.match(slice.output, /\[lines 4-4 of 4/);
    const full = await readFile.run({ workdir: wd, permissionMode: "auto" }, { path: "g.txt" });
    assert.ok(!full.output.includes("[lines"));
    assert.match(full.output, /1: a/);
  });
});

describe("grep context + max_results", () => {
  it("returns match and surrounding context lines", async () => {
    const wd = mkWorkdir();
    writeFileSync(join(wd, "target.txt"), "before1\nbefore2\nMATCHME needle\nafter1\nafter2\n");
    const grep = getTool("grep");
    const r = await grep.run({ workdir: wd, permissionMode: "auto" }, { pattern: "MATCHME", context_before: 1, context_after: 1 });
    assert.equal(r.ok, true);
    assert.match(r.output, /MATCHME needle/);
    assert.match(r.output, /before2/);
    assert.match(r.output, /after1/);
  });

  it("max_results caps matching lines", async () => {
    const wd = mkWorkdir();
    writeFileSync(join(wd, "many.txt"), Array.from({ length: 20 }, (_, i) => `hit ${i}`).join("\n"));
    const grep = getTool("grep");
    const r = await grep.run({ workdir: wd, permissionMode: "auto" }, { pattern: "hit", max_results: 3 });
    assert.equal(r.ok, true);
    const matchLines = r.output.split("\n").filter((l) => /hit \d+/.test(l));
    assert.ok(matchLines.length <= 4, `expected ≤4 match lines, got ${matchLines.length}`); // 3 + slack for tool prefixes
  });
});

describe("list_files depth/exclude/hidden", () => {
  it("depth limits recursion", async () => {
    const wd = mkWorkdir();
    mkdirSync(join(wd, "a", "b", "c", "d", "e"), { recursive: true });
    writeFileSync(join(wd, "top.txt"), "x");
    const listFiles = getTool("list_files");
    const r = await listFiles.run({ workdir: wd, permissionMode: "auto" }, { path: ".", depth: 2 });
    assert.match(r.output, /top\.txt/);
    assert.match(r.output, /a\/b\//);
    assert.ok(!r.output.includes("d/e"), "depth=2 must not reach level 5");
  });

  it("exclude globs drop matching entries; dotfiles hidden by default, .github kept", async () => {
    const wd = mkWorkdir();
    writeFileSync(join(wd, "keep.txt"), "x");
    writeFileSync(join(wd, "drop.log"), "x");
    mkdirSync(join(wd, ".github"), { recursive: true });
    writeFileSync(join(wd, ".github", "ci.yml"), "x");
    writeFileSync(join(wd, ".hidden.txt"), "x");
    const listFiles = getTool("list_files");
    const r = await listFiles.run({ workdir: wd, permissionMode: "auto" }, { path: ".", exclude: "*.log" });
    assert.match(r.output, /keep\.txt/);
    assert.ok(!r.output.includes("drop.log"));
    assert.match(r.output, /\.github/);
    assert.ok(!r.output.includes(".hidden.txt"));
    const r2 = await listFiles.run({ workdir: wd, permissionMode: "auto" }, { path: ".", include_hidden: "true" });
    assert.match(r2.output, /\.hidden\.txt/);
  });
});

describe("repo map", () => {
  it("extractSymbols finds TS exports", () => {
    const syms = extractSymbols("x.ts", "export function alpha() {}\nexport const beta = 1;\nclass Gamma {}\n");
    assert.ok(syms.includes("alpha") && syms.includes("beta") && syms.includes("Gamma"));
  });

  it("buildRepoMap renders tree + symbols and caches by mtime signature", () => {
    const wd = mkWorkdir();
    mkdirSync(join(wd, "src"));
    writeFileSync(join(wd, "src", "foo.ts"), "export function myThing() { return 1; }\n");
    writeFileSync(join(wd, "README.md"), "# hi\n");
    const map1 = buildRepoMap(wd, 8000);
    assert.match(map1, /REPO MAP/);
    assert.match(map1, /src\/foo\.ts/);
    assert.match(map1, /myThing/);
    const map2 = buildRepoMap(wd, 8000);
    assert.equal(map2, map1, "second call should hit the cache");
    // mtime change invalidates the cache key
    const k1 = repoMapKey(wd);
    const future = new Date(Date.now() + 5000);
    utimesSync(join(wd, "src", "foo.ts"), future, future);
    assert.notEqual(repoMapKey(wd), k1);
  });

  it("respects the char budget", () => {
    const wd = mkWorkdir();
    for (let i = 0; i < 80; i++) writeFileSync(join(wd, `f${String(i).padStart(3, "0")}.ts`), `export const s${i}_LongSymbolName = ${i};\n`);
    const small = buildRepoMap(wd, 600);
    assert.match(small, /more file\(s\)/);
  });

  it("repo_map tool returns the map", async () => {
    const wd = mkWorkdir();
    writeFileSync(join(wd, "main.ts"), "export function entryPoint() {}\n");
    const tool = getTool("repo_map");
    const r = await tool.run({ workdir: wd, permissionMode: "auto" }, {});
    assert.equal(r.ok, true);
    assert.match(r.output, /REPO MAP/);
    assert.match(r.output, /entryPoint/);
  });
});

describe("AGENTS.md hierarchy", () => {
  it("root + nested files collected; focus extraction finds existing files only", () => {
    const wd = mkWorkdir();
    writeFileSync(join(wd, "AGENTS.md"), "# root conventions\nAlways use tabs.");
    mkdirSync(join(wd, "src", "tui"), { recursive: true });
    writeFileSync(join(wd, "src", "tui", "AGENTS.md"), "# tui conventions\nInk only.");
    writeFileSync(join(wd, "src", "tui", "app.tsx"), "export {}\n");
    const focus = extractFocusFiles("please fix src/tui/app.tsx and also src/missing.ts", wd);
    assert.deepEqual(focus, ["src/tui/app.tsx"]);
    const guides = collectAgentGuides(wd, focus);
    const sources = guides.map((g) => g.content);
    assert.ok(sources.some((s) => s.includes("root conventions")), "root guide present");
    assert.ok(sources.some((s) => s.includes("tui conventions")), "nested guide present");
    const block = buildAgentGuideBlock(wd, "please fix src/tui/app.tsx");
    assert.match(block, /AGENTS\.md/);
    assert.match(block, /root conventions/);
  });
});

describe("agents v2 frontmatter (.scoder/agents/*.md)", () => {
  it("parses tools/permission/temperature/reasoning/maxTokens/skills/color", () => {
    const wd = mkWorkdir();
    mkdirSync(join(wd, ".scoder", "agents"), { recursive: true });
    writeFileSync(
      join(wd, ".scoder", "agents", "seo.md"),
      [
        "---",
        "description: seo specialist",
        "mode: primary",
        "model: openai/gpt-4o-mini",
        "steps: 7",
        "tools: read_file, grep, write_file",
        "permission: ask",
        "temperature: 0.4",
        "reasoning: on",
        "maxTokens: 1000",
        "skills: copywriting, seo",
        "color: magenta",
        "---",
        "You optimize pages.",
      ].join("\n"),
    );
    const seo = discoverAgents(wd).find((a) => a.name === "seo");
    assert.deepEqual(seo.tools, ["read_file", "grep", "write_file"]);
    assert.equal(seo.permission, "ask");
    assert.equal(seo.temperature, 0.4);
    assert.equal(seo.reasoning, "on");
    assert.equal(seo.maxTokens, 1000);
    assert.deepEqual(seo.skills, ["copywriting", "seo"]);
    assert.equal(seo.color, "magenta");
    assert.equal(seo.mode, "primary");
  });
});

describe("/agent + /init dispatch", () => {
  function fakeHost(cfg, over = {}) {
    const state = { replaced: null, patched: [] };
    const host = {
      agent: () => null,
      config: cfg,
      updateConfig: (patch) => {
        Object.assign(cfg, patch);
        state.patched.push(patch);
      },
      replaceAgent: (next) => {
        state.replaced = next;
      },
      isRunning: () => false,
      ...over,
    };
    return { host, state };
  }

  it("/agent lists selectable agents; /agent plan switches via updateConfig", async () => {
    const wd = mkWorkdir();
    const cfg = { workdir: wd, permissionMode: "auto", agent: "build" };
    const { host, state } = fakeHost(cfg);
    const { dispatchCommand } = await import("../dist/tui/command-registry.js");
    const notices = [];
    const notice = (text) => notices.push(text);
    await dispatchCommand("/agent", host, notice);
    assert.match(notices.join("\n"), /Agents:/);
    assert.match(notices.join("\n"), /\* build/);
    assert.match(notices.join("\n"), /plan/);
    await dispatchCommand("/agent plan", host, notice);
    assert.equal(cfg.agent, "plan", "updateConfig/host.config must carry the switch");
    assert.equal(state.replaced, null, "replaceAgent(null) clears the agent");
    // unknown agent rejected
    notices.length = 0;
    await dispatchCommand("/agent nope", host, notice);
    assert.match(notices.join("\n"), /not selectable/);
  });

  it("/init creates AGENTS.md and refuses to overwrite", async () => {
    const wd = mkWorkdir();
    const cfg = { workdir: wd, permissionMode: "auto" };
    const { host } = fakeHost(cfg);
    const { dispatchCommand } = await import("../dist/tui/command-registry.js");
    const notices = [];
    const notice = (text) => notices.push(text);
    await dispatchCommand("/init", host, notice);
    assert.ok(existsSync(join(wd, "AGENTS.md")));
    assert.match(readFileSync(join(wd, "AGENTS.md"), "utf8"), /# /);
    notices.length = 0;
    await dispatchCommand("/init", host, notice);
    assert.match(notices.join("\n"), /already exists/);
  });
});

describe("agentsMdTemplate (/init)", () => {
  it("generates a valid AGENTS.md with detected commands", () => {
    const wd = mkWorkdir();
    writeFileSync(join(wd, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "tsc", test: "node --test" } }));
    const t = agentsMdTemplate(wd);
    assert.match(t, /# demo — AGENTS\.md/);
    assert.match(t, /npm run build/);
    assert.match(t, /npm test/);
  });
});

describe("run_command spec timeout_secs is a number (was string)", () => {
  it("timeout_secs param type is number", () => {
    const rc = AGENT_TOOLS.find((t) => t.spec.function.name === "run_command");
    assert.equal(rc.spec.function.parameters.properties.timeout_secs.type, "number");
  });
});

describe("builtin agents have tool/permission discipline", () => {
  it("plan + explore + review use only read-only specs; build is not restricted", () => {
    const wd = mkWorkdir();
    const byName = Object.fromEntries(discoverAgents(wd).map((a) => [a.name, a]));
    for (const name of ["plan", "explore", "review"]) {
      assert.ok(byName[name].tools?.length, `${name} has explicit tool whitelist`);
      assert.ok(!byName[name].tools.some((t) => MUTATING_TOOL_SPECS.includes(t)), `${name} excludes mutating tools`);
      assert.equal(byName[name].permission, "readonly");
    }
    assert.equal(byName.build.permission, undefined);
  });

  it("mutating specs are filtered for readonly defs without explicit tools", () => {
    const def = { name: "ro", mode: "primary", prompt: "x", permission: "readonly" };
    assert.deepEqual(filterToolNamesForDef(["read_file", "write_file", "run_command", "grep"], def), ["read_file", "grep"]);
  });
});
