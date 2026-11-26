/**
 * Replay log session THẬT của scoder qua GuardrailEngine hiện tại — trả lời câu
 * hỏi "fix có bắt được loop trong production không?" bằng chứng cứ, không đoán.
 *
 * Usage: node scripts/replay-guardrails.mjs [--days 7] [--verbose]
 *   Đọc events.jsonl trong ~/.scoder/sessions/<id>/ (durable event log), dựng
 *   lại từng RUN (run.started → finish) và feed các bước của run đó vào engine
 *   đúng như runLoop làm, gồm cả tool results thật đã ghi trong log.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { GuardrailEngine } from "../dist/agent/guardrails.js";
import { READ_ONLY_TOOLS } from "../dist/agent/tool-signature.js";

const SESSIONS = join(homedir(), ".scoder", "sessions");
const daysIdx = process.argv.indexOf("--days");
const DAYS = daysIdx > 0 ? Number(process.argv[daysIdx + 1]) : 7;
const verbose = process.argv.includes("--verbose");

/** Chia event log thành các run: [{ task, steps: [{message, results}] }]. */
function runsFrom(events) {
  const runs = [];
  let cur = null;
  let pending = null;
  for (const e of events) {
    if (e.type === "run.started") {
      cur = { task: e.task ?? "", steps: [] };
      runs.push(cur);
      pending = null;
      continue;
    }
    if (e.type === "finish") {
      if (cur) cur.finished = e;
      cur = null;
      pending = null;
      continue;
    }
    const m = e.message;
    if (!m || !cur) continue;
    if (m.role === "assistant") {
      pending = { message: m, results: new Map() };
      cur.steps.push(pending);
    } else if (m.role === "tool" && pending) {
      const text = m.content || "";
      pending.results.set(m.tool_call_id ?? `${m.name}:${pending.results.size}`, {
        ok: !/^ERROR/.test(text),
        output: text,
      });
    }
  }
  return runs;
}

/**
 * Replay MỘT run. `stopOnChatTurn=false` vì lượt chat thuần là kết thúc HỢP LỆ —
 * chỉ quan tâm loop, nên chat-turn được coi là "run dừng đúng" và không cắt.
 */
async function replayRun(run) {
  const eng = new GuardrailEngine();
  let filesModified = false;
  const fired = [];
  let stopped = null;
  let stepNo = 0;
  for (const s of run.steps) {
    stepNo++;
    const m = s.message;
    const calls = m.tool_calls ?? [];
    for (const tc of calls) if (!READ_ONLY_TOOLS.has(tc.name) && s.results.get(tc.id)?.ok) filesModified = true;
    const ds = await eng.evaluate({
      step: stepNo,
      maxSteps: 40,
      text: m.content || "",
      message: m,
      hasToolCalls: calls.length > 0,
      toolResults: s.results,
      buildPassedThisStep: false,
      buildCallPresent: false,
      filesModified,
      chatDone: false,
      planOpen: false,
    });
    for (const d of ds) {
      fired.push({ step: stepNo, rule: d.rule, kind: d.action.kind, reason: d.reason });
      if (d.action.kind === "inject" && d.rule === "doom-loop") eng.markLoopIntervention();
      if (d.action.kind === "inject" && d.rule === "no-new-information") eng.markNoInfoIntervention();
      if (d.action.kind === "finish") {
        const chatTurn = d.rule === "continue-nudge" && /chat turn/.test(d.reason);
        if (!chatTurn) {
          stopped = { step: stepNo, rule: d.rule, reason: d.reason };
          return { steps: stepNo, fired, stopped };
        }
      }
    }
  }
  return { steps: stepNo, fired, stopped };
}

const rows = [];
for (const name of readdirSync(SESSIONS).sort().reverse()) {
  const dir = join(SESSIONS, name);
  if (!statSync(dir).isDirectory()) continue;
  const f = join(dir, "events.jsonl");
  if (!existsSync(f) || statSync(f).mtimeMs < Date.now() - DAYS * 864e5) continue;
  const events = readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  for (const run of runsFrom(events)) {
    if (run.steps.length < 2) continue; // lượt chat 1 bước: không có gì để replay
    const r = await replayRun(run);
    rows.push({ session: name, task: run.task.slice(0, 60), ...r });
  }
}

for (const r of rows) {
  const loop = r.fired.filter((x) => ["doom-loop", "no-new-information", "error-loop", "token-no-progress"].includes(x.rule));
  const tag = r.stopped ? `CẮT DỪNG ở step ${r.stopped.step} vì ${r.stopped.rule}` : `không cắt (${r.steps} steps)`;
  console.log(`\n${r.session}  [${r.steps} steps]  task: ${JSON.stringify(r.task)}\n  ${tag}`);
  for (const x of (verbose ? loop : loop.slice(0, 4))) {
    console.log(`   step ${x.step}  ${x.rule} → ${x.kind}  | ${x.reason}`);
  }
}
console.log(`\nreplayed ${rows.length} run(s) from the last ${DAYS} day(s)`);
