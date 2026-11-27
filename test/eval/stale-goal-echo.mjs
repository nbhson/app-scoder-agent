/**
 * Eval gate — "run không được kết thúc bằng câu trả lời rác" (ba session thật
 * 2026-11-27: 20261127-104714-602d, 20261127-105851-7fb8, 20261127-103715-f250).
 *
 * Tự chạy (self-contained) vì harness `runScenario` chỉ drive MỘT lượt
 * `agent.run(task)`, còn triệu chứng này cần ≥2 lượt trong cùng session:
 *   F1 — ledger fold vào hội thoại với `goal` của lượt CŨ ⇒ model chào lại;
 *   F2 — run finish success:true với summary = chính câu chào đó;
 *   F3 — đáp án cắt vì hết token output (finish_reason=length) được nhận làm kết quả.
 *
 * Chạy: npm run eval  (sau npm run build)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../dist/agent.js";
import { CHAT_DONE_MARKER } from "../../dist/agent/guardrails.js";

const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args ?? {}) },
});

const GREETING = "Chào bạn! 👋 Nếu bạn cần giúp gì với code hoặc dự án, cứ nói nhé.";
const REQUEST = "liệt kê những tính năng mới nhất của Angular mà dự án này có thể dùng";
const ANSWER =
  "Dự án nên bật Angular signals (stable), effect(), control flow @if/@for/@switch và deferred templates.";

/** Mock client trả tuần tự `turns`; mỗi turn { content?, toolCalls?, stopReason? }. */
function makeAgent(workdir, turns, events, calls = []) {
  class Scripted {
    lastPartialToolCalls = [];
    idx = 0;
    get model() {
      return "scripted/mock";
    }
    next(messages) {
      calls.push(messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" })));
      const t = turns[this.idx++] ?? { content: ANSWER };
      const toolCalls = t.toolCalls?.map((x) => ({
        id: x.id,
        name: x.function.name,
        arguments: x.function.arguments,
      }));
      return {
        message: {
          role: "assistant",
          content: t.content ?? null,
          stop_reason: t.stopReason ?? (toolCalls ? "tool_calls" : "stop"),
          tool_calls: toolCalls,
        },
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
    }
    async chat(messages) {
      return this.next(messages);
    }
    async *streamChat(messages) {
      const r = this.next(messages);
      yield { final: r, done: true };
    }
  }
  const agent = new Agent({
    baseUrl: "http://localhost:0",
    apiKey: "eval",
    model: "scripted/mock",
    provider: "openai",
    workdir,
    buildCmd: null,
    maxSteps: 12,
    yes: true,
    noSave: true,
    snapshots: false,
    stream: false,
    permissionMode: "auto",
    allowSubagents: false,
    clientFactory: () => new Scripted(),
  });
  agent.onEvent = (ev) => events.push(ev);
  return { agent, calls };
}

const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const SIX_READS = Array.from({ length: 6 }, (_, i) => ({
  toolCalls: [tc(`r${i}`, "read_file", { path: `notes${i + 1}.md` })],
}));

/** Scenario 1: session mở đầu bằng "chào" rồi chạy research — không được chào lại. */
async function staleGoalEcho(workdir) {
  const events = [];
  const { agent } = makeAgent(workdir, [{ content: GREETING }, ...SIX_READS, { content: GREETING }, { content: ANSWER }], events);
  await agent.run("chào");
  const result = await agent.runTurn(REQUEST);

  const rules = events.filter((e) => e.type === "guardrail").map((e) => `${e.rule}:${e.action}`);
  ok(rules.some((r) => r.startsWith("stale-answer:inject")), `stale-answer phải can thiệp (rules=${rules.join(",")})`);
  const summary = (result.summary ?? "").trim();
  ok(!summary.startsWith(GREETING.slice(0, 20)), `summary vẫn là câu chào cũ: ${JSON.stringify(summary.slice(0, 80))}`);
  ok(/signals|deferred/i.test(summary), `summary phải là đáp án thật: ${JSON.stringify(summary.slice(0, 80))}`);
  return `stale-answer rescue → ${summary.slice(0, 32)}…`;
}

/** Scenario 2: model vẫn trả lời rác sau khi được nhắc ⇒ run THẤT BẠI, cứu đáp án cũ. */
async function degenerateAfterRetryFails(workdir) {
  const events = [];
  const { agent } = makeAgent(
    workdir,
    [
      { content: "Đây là daily report đã viết lại: ticket 3813 đang tích hợp backend, epic 4167 xong review UI, epic 4166 đang điều tra phía UI." },
      { content: "Dưới" },
      { content: "Dưới" },
    ],
    events,
  );
  await agent.run("viết lại các dòng daily report cho chuyên nghiệp");
  const result = await agent.runTurn("cho tôi câu trả lời?");
  const rules = events.filter((e) => e.type === "guardrail").map((e) => `${e.rule}:${e.action}`);
  ok(result.success === false, `không được báo success với đáp án "Dưới" (rules=${rules.join(",")})`);
  ok(/daily report/.test(result.summary ?? ""), `summary phải cứu đáp án đầy đủ: ${JSON.stringify(result.summary)}`);
  return "second hit → success:false + rescued answer";
}

/** Scenario 3: finish_reason=length ⇒ nói TIẾP, không nhận câu cụt làm kết quả. */
async function lengthContinuation(workdir) {
  const events = [];
  const calls = [];
  const { agent } = makeAgent(
    workdir,
    [
      { content: "Dưới đây là các tính năng: signals, effect, và", stopReason: "length" },
      { content: "…tiếp theo là @if/@for control flow cùng deferred templates." },
    ],
    events,
    calls,
  );
  const result = await agent.run(REQUEST);
  ok(calls.length === 2, `phải gọi lại LLM để nói tiếp (calls=${calls.length})`);
  ok(
    calls[1].some((m) => /cut off|output-token limit/i.test(m.content)),
    "phải có instruction tiếp tục sau đáp án bị cắt",
  );
  ok(/deferred templates/.test(result.summary ?? ""), `summary phải là đáp án đầy đủ: ${JSON.stringify(result.summary)}`);
  return "finish_reason=length → continuation";
}

/** Scenario 4: lượt chat hợp lệ (marker CHAT_DONE) KHÔNG bị guardrail chắn. */
async function validChatTurnUntouched(workdir) {
  const events = [];
  const { agent } = makeAgent(workdir, [{ content: "Mình là Scoder, agent lập trình chạy trong repo của bạn." }, { content: `Còn gì bạn cần nữa không?${CHAT_DONE_MARKER}` }], events);
  const r1 = await agent.run("bạn là ai");
  ok(r1.success && /Scoder/.test(r1.summary ?? ""), `lượt chat hợp lệ phải kết thúc sạch: ${JSON.stringify(r1.summary)}`);
  const r2 = await agent.runTurn("cảm ơn bạn");
  ok(!events.some((e) => e.type === "guardrail" && e.rule === "stale-answer"), "không được báo động giả với câu trả lời hợp lệ");
  ok(r2.success, `marker chat-done phải kết thúc được lượt: ${JSON.stringify(r2.summary)}`);
  return "no false positives";
}

export default {
  name: "degenerate final answer is never confirmed",
  async run() {
    const workdir = mkdtempSync(join(tmpdir(), "scoder-eval-stale-"));
    try {
      // 6 file KHÁC nhau: tool call trùng lặp bị doom-loop chặn trước bước fold.
      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(workdir, `notes${i}.md`), `# Ghi chú ${i}\nAngular ${i}: ${"chi tiết ".repeat(12)}\n`);
      }
      const cfg = join(workdir, "rc.json");
      process.env.SCODER_CONFIG = cfg;
      writeFileSync(cfg, JSON.stringify({}));

      const notes = [];
      notes.push(await staleGoalEcho(workdir));
      notes.push(await degenerateAfterRetryFails(workdir));
      notes.push(await lengthContinuation(workdir));
      notes.push(await validChatTurnUntouched(workdir));
      return { notes: notes.join(" | ") };
    } finally {
      delete process.env.SCODER_CONFIG;
      rmSync(workdir, { recursive: true, force: true });
    }
  },
};
