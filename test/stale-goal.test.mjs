/**
 * Integration test cho ba lỗi ghi trong ~/.scoder/sessions (2026-11-27):
 *
 *  F1 — working-memory `goal` không đổi theo lượt: session mở đầu bằng "chào",
 *       run 7 bước vẫn inject "goal: chào" ⇒ model chào lại thay vì trả lời
 *       (20261127-104714-602d, 20261127-105851-7fb8).
 *  F2 — run KẾT THÚC bằng chính câu chào đó với success:true.
 *  F3 — đáp án bị cắt vì hết token output (finish_reason=length) vẫn được nhận
 *       làm đáp án cuối (20261127-103715-f250: "Dưới", outputTokens 3).
 *
 * Chạy: npm run build && node --test test/stale-goal.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../dist/agent.js";
import { emptyWorkingMemory, memoryFromMessages, setMemoryGoal, isSyntheticUserBlock } from "../dist/context/memory.js";

let workdir;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "stalegoal-"));
  // 6 file KHÁC nhau: tool call giống hệt nhau sẽ bị doom-loop/no-new-information
  // chặn trước khi tới bước fold ledger (bước 6) — kịch bản phải vượt qua rule đó.
  for (let i = 1; i <= 6; i++) {
    writeFileSync(join(workdir, `notes${i}.md`), `# Ghi chú ${i}\nAngular feature group ${i}: ${"chi tiết ".repeat(12)}\n`);
  }
  process.env.SCODER_CONFIG = join(workdir, "rc.json");
  writeFileSync(process.env.SCODER_CONFIG, JSON.stringify({}));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  delete process.env.SCODER_CONFIG;
});

const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args ?? {}) } });

/** Mock client: trả tuần tự `turns`, ghi lại messages của MỖI lượt gọi. */
function mkAgent(turns, overrides = {}) {
  const calls = [];
  const client = class {
    lastPartialToolCalls = [];
    get model() {
      return "scripted/mock";
    }
    constructor() {
      this.idx = 0;
    }
    next(messages) {
      calls.push(messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" })));
      const t = turns[this.idx++] ?? { content: "Xong rồi." };
      const toolCalls = t.toolCalls?.map((x) => ({ id: x.id, name: x.function.name, arguments: x.function.arguments }));
      return {
        message: {
          role: "assistant",
          content: t.content ?? null,
          stop_reason: t.stopReason ?? (toolCalls ? "tool_calls" : "stop"),
          tool_calls: toolCalls,
        },
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      };
    }
    async chat(messages) {
      return this.next(messages);
    }
    async *streamChat(messages) {
      const r = this.next(messages);
      yield { final: r, done: true };
    }
  };
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
    clientFactory: () => new client(),
    ...overrides,
  });
  return { agent, calls };
}

const SIX_READS = Array.from({ length: 6 }, (_, i) => ({ toolCalls: [tc(`r${i}`, "read_file", { path: `notes${i + 1}.md` })] }));
const GREETING = "Chào bạn! 👋 Nếu bạn cần giúp gì với code hoặc dự án, cứ nói nhé.";
const GOAL_REQUEST = "liệt kê những tính năng mới nhất của Angular mà dự án này có thể dùng";
const memoryBlocks = (calls) => calls.flat().filter((m) => m.role === "user" && m.content.startsWith("[working memory"));

describe("F1 — working memory phải theo yêu cầu CỦA LƯỢT HIỆN TẠI", () => {
  it("goal đổi sang request mới ở lượt tiếp theo của cùng session", async () => {
    const { agent, calls } = mkAgent([
      { content: GREETING }, // run 1 — lượt chat
      ...SIX_READS, // run 2 — 6 bước tool, fold ledger ở bước 7
      { content: "Dự án dùng Angular; nên bật signals, effect và @if control flow." },
    ]);
    await agent.run("chào");
    await agent.runTurn(GOAL_REQUEST);

    const blocks = memoryBlocks(calls);
    assert.ok(blocks.length >= 1, `loop phải fold ledger vào hội thoại (llm calls=${calls.length})`);
    for (const b of blocks) {
      const goal = (b.content.match(/^goal: (.*)$/m) || [])[1] ?? "";
      assert.match(goal, /Angular/i, `goal phải là yêu cầu hiện tại: "${goal}"`);
      assert.ok(!/^ch[àa]o$/i.test(goal.trim()), `goal vẫn là câu chào của lượt đầu: "${goal}"`);
    }
  });

  it("block ledger tự nhận là context, không phải request mới", async () => {
    const { agent, calls } = mkAgent([...SIX_READS, { content: "Tóm tắt: dự án Angular dùng signals, effect và control flow mới." }]);
    await agent.run(GOAL_REQUEST);
    const block = memoryBlocks(calls)[0];
    assert.ok(block, "phải có block working memory");
    assert.match(block.content, /not a new user request/i);
  });

  it("goal luôn là MỘT dòng — model không đọc nhầm field khác", () => {
    const mem = emptyWorkingMemory("làm báo cáo\nvới nhiều dòng\nrất dài");
    assert.ok(!mem.goal.includes("\n"), `goal nhiều dòng: ${JSON.stringify(mem.goal)}`);
  });

  it("task dài quá trần: giữ ĐUÔI (yêu cầu mới nhất), không giữ đầu", () => {
    const long = `${"nội dung cũ ".repeat(60)}\n${GOAL_REQUEST}`;
    const mem = emptyWorkingMemory(long);
    assert.ok(mem.goal.endsWith(GOAL_REQUEST), `goal phải giữ request cuối: …${mem.goal.slice(-60)}`);
  });

  it("lượt follow-up ngắn vẫn giữ ngữ cảnh request cũ", () => {
    const mem = emptyWorkingMemory("viết lại các dòng daily report cho chuyên nghiệp");
    setMemoryGoal(mem, "cho tôi câu trả lời?");
    assert.match(mem.goal, /^cho tôi câu trả lời\?/);
    assert.match(mem.goal, /daily report/, `goal phải giữ request cũ: "${mem.goal}"`);
  });

  it("scan history bỏ qua block harness (REPO MAP / ledger / reminder)", () => {
    const mem = memoryFromMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "[Context — repository map as of session start] REPO MAP — auto-generated" },
      { role: "user", content: "[working memory — decisions & state preserved across compaction]\ngoal: cũ" },
      { role: "user", content: "<system-reminder>Step budget nearly exhausted</system-reminder>" },
      { role: "user", content: "chào" },
      { role: "assistant", content: GREETING },
      { role: "user", content: "sửa bug parser trong src/parser.ts" },
    ]);
    assert.equal(mem.goal, "sửa bug parser trong src/parser.ts");
    assert.equal(isSyntheticUserBlock("[Context — repository map]"), true);
    assert.equal(isSyntheticUserBlock("sửa bug parser"), false);
  });
});

describe("F2 — không kết thúc run bằng câu chào cũ sau khi đã làm việc", () => {
  it("echo nguyên văn câu chào ở lượt cuối ⇒ guardrail bắt, run phải trả đáp án thật", async () => {
    const events = [];
    const { agent } = mkAgent([
      { content: GREETING },
      ...SIX_READS,
      { content: GREETING }, // model lạc hướng vì "goal: chào"
      { content: "Angular mới có signals ổn định, effect(), @if/@for và deferred templates." },
    ]);
    agent.onEvent = (ev) => events.push(ev);
    await agent.run("chào");
    const res = await agent.runTurn(GOAL_REQUEST);

    const stale = events.find((e) => e.type === "guardrail" && e.rule === "stale-answer");
    assert.ok(stale, `phải có can thiệp stale-answer (events=${events.filter((e) => e.type === "guardrail").map((e) => e.rule).join(",")})`);
    assert.equal(stale.action, "inject");
    assert.ok(!new RegExp(`^${GREETING.slice(0, 20)}`).test((res.summary ?? "").trim()), `summary không được là câu chào cũ: ${JSON.stringify(res.summary)}`);
    assert.match(res.summary ?? "", /signals/i);
  });

  it("model vẫn cụt sau khi được nhắc ⇒ run báo THẤT BẠI, không xác nhận rác", async () => {
    const { agent } = mkAgent([
      {
        content:
          "Đây là các dòng daily report đã viết lại chuyên nghiệp hơn cho từng ticket của bạn: ticket 3813 đang tích hợp " +
          "với backend, epic 4167 và 3838 đã xong review UI, epic 4166 đang được điều tra từ phía UI.",
      }, // run 1 — đáp án đầy đủ
      { content: "Dưới" }, // run 2 — model trả lời cụt (1 llm call, đúng log thật)
      { content: "Dưới" }, // vẫn thế sau khi được nhắc
    ]);
    await agent.run("viết lại các dòng daily report cho chuyên nghiệp");
    const res = await agent.runTurn("cho tôi câu trả lời?");
    assert.equal(res.success, false, `không được báo success với đáp án "Dưới": ${JSON.stringify(res.summary)}`);
    assert.match(res.summary ?? "", /daily report/, "summary phải cứu đáp án đầy đủ gần nhất");
  });
});

describe("F3 — tôn trọng finish_reason", () => {
  it("stop_reason=length (hết token output) ⇒ continue, không nhận đáp án cụt", async () => {
    const { agent, calls } = mkAgent([
      { content: "Dưới đây là các tính năng: signals, effect, và", stopReason: "length" },
      { content: "…tiếp theo là @if/@for control flow cùng deferred templates trong Angular." },
    ]);
    const res = await agent.run(GOAL_REQUEST);
    assert.equal(calls.length, 2, "phải gọi lại LLM để nói tiếp thay vì dừng ở câu cụt");
    const cont = calls[1].find((m) => /cut off|output-token limit/i.test(m.content));
    assert.ok(cont, "phải có instruction tiếp tục sau đáp án bị cắt");
    assert.match(res.summary ?? "", /deferred templates/, `summary phải là đáp án đầy đủ: ${res.summary}`);
  });

  it("stop_reason=stop bình thường ⇒ không bị coi là cắt", async () => {
    const { agent, calls } = mkAgent([{ content: "Dự án dùng Angular. Signals đã ổn định, có thêm @if control flow nhé." }]);
    await agent.run(GOAL_REQUEST);
    assert.equal(calls.length, 1);
  });
});
