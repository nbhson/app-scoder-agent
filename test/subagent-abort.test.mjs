/**
 * Regression tests: Esc/SIGINT phải dừng được subagent.
 *
 * Hai lỗi từng làm subagent "chạy mãi" sau khi người dùng bấm dừng:
 *  1) abort giữa stream → chatWithStreamInner fallback sang client.chat()
 *     KHÔNG truyền signal (= không thể hủy) — run chỉ quay về sau toàn bộ
 *     request đó (tối đa requestTimeoutMs 120s, cộng withRetry).
 *  2) abort rơi vào khoảng giữa `new Agent(child)` và `child.run()` →
 *     resetRunSignal() xóa cờ aborted → child chạy trọn kịch bản, mà subagent
 *     có maxSteps = ∞ nên không còn gì chặn.
 *  3) parent đã abort mà vẫn spawn child → child không thuộc run nào, không
 *     còn đường hủy.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../dist/agent.js";
import { applyEvent, initialState } from "../dist/tui/state.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scripted client — `turns` là kịch bản từng step; usage đủ lớn để không dính
 *  guardrail token-no-progress (outputTokens < 20 ba step liên tiếp). */
function scripted(turns, counter, { hangOnStream = false, onChat } = {}) {
  let i = 0;
  const result = (t) => {
    counter.v++;
    return {
      message: {
        role: "assistant",
        content: t.content ?? null,
        stop_reason: t.toolCalls?.length ? "tool_calls" : "stop",
        tool_calls: t.toolCalls ?? [],
      },
      usage: { prompt_tokens: 1000, completion_tokens: 60 },
    };
  };
  const next = () => turns[i++] ?? { content: "script exhausted" };
  return {
    model: "m",
    lastPartialToolCalls: [],
    async chat(messages, tools, opts = {}) {
      if (onChat) onChat(opts.signal);
      if (opts.signal?.aborted) throw opts.signal.reason;
      await sleep(5);
      return result(next());
    },
    async *streamChat(messages, tools, opts = {}) {
      if (!hangOnStream) {
        yield { final: result(next()), done: true };
        return;
      }
      // undici: abort giữa body → reader.read() reject bằng chính abort reason
      const signal = opts.signal;
      await new Promise((_, rej) => {
        if (signal?.aborted) return rej(signal.reason);
        signal?.addEventListener("abort", () => rej(signal.reason), { once: true });
      });
      throw signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
    },
  };
}

function agentConfig(workdir, clientFactory, extra = {}) {
  return {
    workdir,
    provider: "openai",
    baseUrl: "http://localhost:1",
    apiKey: "k",
    model: "m",
    maxSteps: 8,
    permissionMode: "auto",
    noSave: true,
    snapshots: false,
    allowSubagents: true,
    stream: false,
    reporter: new Proxy({}, { get: () => () => undefined }),
    clientFactory,
    ...extra,
  };
}

/** Task call làm parent spawn `agent` build với kịch bản N bước list_files. */
function parentSpawnsBuild() {
  return [
    {
      toolCalls: [
        {
          id: "t1",
          name: "task",
          arguments: JSON.stringify({ description: "explore", prompt: "liệt kê các thư mục", agent: "build" }),
        },
      ],
    },
    { content: "parent done" },
  ];
}

function childScript(n) {
  const turns = Array.from({ length: n }, (_, i) => ({
    content: `bước ${i}`,
    toolCalls: [{ id: `c${i}`, name: "list_files", arguments: JSON.stringify({ path: `dir${i}` }) }],
  }));
  turns.push({ content: "child done" });
  return turns;
}

function mkWorkdirs(prefix, n) {
  const workdir = mkdtempSync(join(tmpdir(), prefix));
  for (let i = 0; i < n; i++) mkdirSync(join(workdir, `dir${i}`), { recursive: true });
  return workdir;
}

describe("subagent abort (Esc/SIGINT)", () => {
  it("abort giữa stream của subagent → KHÔNG phát request non-streaming mới", async () => {
    const workdir = mkWorkdirs("sub-abort-stream-", 2);
    const pC = { v: 0 };
    const cC = { v: 0 };
    let childChatWithoutSignal = false;
    let childChatCalls = 0;
    let n = 0;
    const a = new Agent(
      agentConfig(
        workdir,
        () =>
          ++n === 1
            ? scripted(parentSpawnsBuild(), pC)
            : scripted(childScript(2), cC, {
                hangOnStream: true, // child luôn kẹt trong stream cho tới khi bị abort
                onChat: (signal) => {
                  childChatCalls++;
                  if (!signal) childChatWithoutSignal = true;
                },
              }),
        { stream: true },
      ),
    );
    let aborted = false;
    a.onEvent = (ev) => {
      if (aborted || ev.type !== "agent_start") return;
      aborted = true;
      // child đã vào loop (đang stream) rồi mới bấm ESC — qua macrotask để
      // chắc chắn resetRunSignal() của child đã chạy
      setTimeout(() => a.abort(), 20);
    };
    const res = await a.run("spawn rồi dừng");
    assert.equal(childChatCalls, 0, "aborted stream phải dừng lại, không fallback sang chat()");
    assert.equal(childChatWithoutSignal, false, "mọi fallback chat() phải mang AbortSignal");
    assert.match(res.summary ?? "", /interrupted/i, "run kết thúc như một lệnh dừng");
    rmSync(workdir, { recursive: true, force: true });
  });

  it("abort ngay khi subagent vừa được spawn → child không chạy trọn kịch bản", async () => {
    const workdir = mkWorkdirs("sub-abort-early-", 10);
    const pC = { v: 0 };
    const cC = { v: 0 };
    const CHILD_TURNS = 10;
    let n = 0;
    const a = new Agent(
      agentConfig(
        workdir,
        () => (++n === 1 ? scripted(parentSpawnsBuild(), pC) : scripted(childScript(CHILD_TURNS), cC)),
      ),
    );
    const ends = [];
    a.onEvent = (ev) => {
      if (ev.type === "agent_end") ends.push(ev);
      if (ev.type === "agent_start") a.abort(); // đồng bộ, ngay trong window cũ
    };
    const res = await a.run("spawn rồi dừng sớm");
    assert.ok(cC.v <= 1, `child phải dừng gần như ngay (gọi ${cC.v}/${CHILD_TURNS} LLM call)`);
    assert.equal(ends.length, 1, "cha nhận đúng một agent_end cho child");
    assert.equal(ends[0].ok, false, "child kết thúc với trạng thái failed");
    assert.match(ends[0].summary, /interrupted/i, "summary của child là lệnh dừng, không phải 'child done'");
    assert.match(res.summary ?? "", /interrupted/i);
    rmSync(workdir, { recursive: true, force: true });
  });

  it("baseline: không abort thì child chạy hết kịch bản (không đổi hành vi)", async () => {
    const workdir = mkWorkdirs("sub-abort-none-", 10);
    const pC = { v: 0 };
    const cC = { v: 0 };
    let n = 0;
    const a = new Agent(
      agentConfig(
        workdir,
        () => (++n === 1 ? scripted(parentSpawnsBuild(), pC) : scripted(childScript(10), cC)),
      ),
    );
    const res = await a.run("chạy bình thường");
    assert.equal(cC.v, 11, "child hoàn thành 10 bước + 1 bước chốt");
    assert.equal(res.success, true);
    rmSync(workdir, { recursive: true, force: true });
  });

  it("parent đã abort trước lúc spawn → task trả lỗi, không tạo child", async () => {
    const workdir = mkWorkdirs("sub-abort-nospan-", 4);
    const pC = { v: 0 };
    const cC = { v: 0 };
    let clients = 0;
    const a = new Agent(
      agentConfig(
        workdir,
        () => (++clients === 1 ? scripted(parentSpawnsBuild(), pC) : scripted(childScript(4), cC)),
      ),
    );
    a.onEvent = (ev) => {
      // tool_call của `task` được emit TRƯỚC khi runner chạy → abort rơi đúng
      // khoảng "cha đã dừng, child chưa spawn"
      if (ev.type === "tool_call" && ev.name === "task") a.abort();
    };
    const res = await a.run("spawn sau khi dừng");
    assert.equal(clients, 1, "không được dựng Agent con khi run đã abort");
    const toolMsg = a.messages.find((m) => m.role === "tool" && m.name === "task");
    assert.match(String(toolMsg?.content ?? ""), /not spawned/, "model nhận lý do rõ ràng");
    assert.match(res.summary ?? "", /interrupted/i);
    rmSync(workdir, { recursive: true, force: true });
  });
});

describe("subagent rows in the TUI never stay ◐ after the run ends", () => {
  it("finish mà không có agent_end → running chuyển thành failed", () => {
    const start = applyEvent(initialState(), {
      type: "run_start", task: "t", model: "m", provider: "p", workdir: "/w", buildCmd: "b", permission: "auto",
    });
    const s = applyEvent(start, { type: "agent_start", id: "c1", parentId: "p1", name: "build", description: "explore", model: "m" });
    assert.equal(s.subagents[0].status, "running");
    const done = applyEvent(s, { type: "finish", success: false, steps: 1, summary: "Agent stopped: interrupted by user (SIGINT)" });
    assert.equal(done.subagents[0].status, "failed", "row không được kẹt ở running mãi");
    assert.match(done.subagents[0].summary ?? "", /subagent stopped/);
  });

  it("agent_end vẫn là nguồn chuẩn khi child kịp báo về", () => {
    const start = applyEvent(initialState(), {
      type: "run_start", task: "t", model: "m", provider: "p", workdir: "/w", buildCmd: "b", permission: "auto",
    });
    let s = applyEvent(start, { type: "agent_start", id: "c1", parentId: "p1", name: "build", description: "explore", model: "m" });
    s = applyEvent(s, { type: "agent_end", id: "c1", ok: true, steps: 4, summary: "child done" });
    s = applyEvent(s, { type: "finish", success: true, steps: 5, summary: "ok" });
    assert.equal(s.subagents[0].status, "ok", "finish không được ghi đè kết quả đã báo cáo đúng");
  });
});
