/**
 * Eval harness golden-file (I-12) — scripted mock-LLM transcripts chạy
 * in-process qua Agent (clientOverride), assert invariants trên event stream:
 *   - không tool-result mồ côi (mọi tool_call có tool message đi kèm)
 *   - finish đúng rule (doom-loop, verify-build, text-only-streak…)
 *   - guardrail events xuất hiện khi kịch bản vi phạm
 *
 * Chạy: npm run eval  (sau npm run build)
 * Kịch bản: test/eval/*.mjs — mỗi file export { name, config, script }.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../dist/agent.js";
import { CHAT_DONE_MARKER } from "../dist/guardrails.js";

/**
 * ScriptedClient — trả tuần tự các turn của transcript. Mỗi turn:
 * { content?, toolCalls? } hoặc { throw: msg }.
 */
class ScriptedClient {
  lastPartialToolCalls = [];
  get model() {
    return "scripted/mock";
  }
  constructor(turns) {
    this.turns = turns;
  }
  idx = 0;
  next() {
    const t = this.turns[this.idx] ?? { content: CHAT_DONE_MARKER };
    this.idx++;
    // Normalize: scenario dùng OpenAI format (function nested); Agent expects
    // flat ToolCall {id, name, arguments}.
    const toolCalls = t.toolCalls?.map((x) => ({
      id: x.id,
      name: x.function?.name ?? x.name,
      arguments: x.function?.arguments ?? x.arguments ?? "{}",
    }));
    return {
      message: {
        role: "assistant",
        content: t.content ?? null,
        stop_reason: toolCalls?.length ? "tool_calls" : "stop",
        tool_calls: toolCalls,
      },
      usage: t.usage ?? { prompt_tokens: 100, completion_tokens: 20 },
    };
  }
  async chat(_messages, _tools, _opts) {
    return this.next();
  }
  async *streamChat(_messages, _tools, _opts) {
    const r = this.next();
    if (r.message.content) yield { contentDelta: r.message.content, done: false };
    if (r.message.tool_calls) {
      for (const tc of r.message.tool_calls) {
        yield { toolCallDelta: { index: 0, id: tc.id, name: tc.name, argumentsDelta: tc.arguments }, done: false };
      }
    }
    yield { final: r, done: true };
  }
}

const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Run một scenario: trả về { events, result }. */
async function runScenario(scenario) {
  const workdir = mkdtempSync(join(tmpdir(), "scoder-eval-"));
  if (scenario.setup) await scenario.setup(workdir);
  const events = [];
  const agent = new Agent({
    baseUrl: "http://localhost:0",
    apiKey: "eval",
    model: "scripted/mock",
    provider: "openai",
    workdir,
    buildCmd: scenario.buildCmd ?? null,
    maxSteps: scenario.maxSteps ?? 12,
    yes: true,
    noSave: true,
    snapshots: false,
    stream: false,
    permissionMode: scenario.permissionMode ?? "auto",
    guardrails: scenario.guardrails,
    clientFactory: () => new ScriptedClient(scenario.script),
    allowSubagents: true,
  });
  agent.onEvent = (ev) => events.push(ev);
  if (scenario.drive) scenario.drive(agent); // async steering hooks (không await — chạy song song run)
  let result;
  try {
    result = await agent.run(scenario.task ?? "eval task");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  return { events, result };
}

/** Invariant: mọi tool_call có tool_result (đếm per-name — event tool_result không mang id). */
function checkNoOrphanTools(events) {
  const counts = new Map();
  for (const ev of events) {
    if (ev.type === "tool_call") counts.set(ev.name, (counts.get(ev.name) ?? 0) + 1);
    if (ev.type === "tool_result") counts.set(ev.name, (counts.get(ev.name) ?? 0) - 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 0).map(([name, n]) => `${name} x${n}`);
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const scenarioFiles = [];
try {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("./eval/", import.meta.url).pathname;
  for (const f of readdirSync(dir)) if (f.endsWith(".mjs")) scenarioFiles.push(join(dir, f));
} catch {
  // no scenarios yet
}

if (scenarioFiles.length === 0) {
  console.error("eval: no scenarios in test/eval/ — nothing to run");
  process.exit(0);
}

for (const file of scenarioFiles.sort()) {
  const mod = await import(file);
  const scenario = mod.default ?? mod.scenario;
  const name = scenario.name ?? file.split("/").pop();
  try {
    const { events, result } = await runScenario(scenario);
    // Invariant chung: không tool-result mồ côi
    const orphans = checkNoOrphanTools(events);
    assert(orphans.length === 0, `orphan tool_calls: ${orphans.join(", ")}`);
    // Assert riêng của scenario
    scenario.check({ events, result });
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, pass: false, detail: (err instanceof Error ? err.message : String(err)) });
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\neval: ${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length > 0 ? 1 : 0);
