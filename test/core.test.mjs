/**
 * Unit tests cho diff.js, retry.js, context.js — core utilities.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unifiedDiff, diffCounts } from "../dist/workspace/diff.js";
import { withRetry, isRetryableStatus, isRetryableNetworkError, NonRetryableError } from "../dist/llm/retry.js";
import {
  trimHistory,
  summariseOutput,
  claimsCompletion,
  expandMentions,
  historyPressure,
  MAX_HISTORY_TOKENS,
  PRUNED_TOOL_RESULT,
  TRIM_RECOVERY_FRACTION,
  historyTokenBudget,
} from "../dist/context/context.js";

// ── diff ────────────────────────────────────────────────────────────────────

describe("unifiedDiff", () => {
  it("nội dung giống nhau -> diff rỗng", () => {
    const r = unifiedDiff("a.txt", "hello\n", "hello\n");
    assert.equal(r.text, "");
    assert.equal(r.added, 0);
    assert.equal(r.removed, 0);
  });

  it("file mới -> toàn bộ là additions", () => {
    const r = unifiedDiff("new.txt", null, "a\nb\n");
    assert.equal(r.added, 2);
    assert.equal(r.removed, 0);
    assert.match(r.text, /\+\+\+ b\/new\.txt/);
    assert.match(r.text, /^\+a$/m);
  });

  it("thay đổi 1 dòng -> +1 -1 với context 3 dòng", () => {
    const oldC = "l1\nl2\nl3\nl4\nl5\n";
    const newC = "l1\nl2-changed\nl3\nl4\nl5\n";
    const r = unifiedDiff("f.ts", oldC, newC);
    assert.equal(r.added, 1);
    assert.equal(r.removed, 1);
    assert.match(r.text, /@@/);
    assert.match(r.text, /^\+l2-changed$/m);
    assert.match(r.text, /^-l2$/m);
  });

  it("diff lớn (>120 dòng render) -> truncated + summary", () => {
    const oldC = Array.from({ length: 300 }, (_, i) => `old ${i}`).join("\n");
    const newC = Array.from({ length: 300 }, (_, i) => `new ${i}`).join("\n");
    const r = unifiedDiff("big.txt", oldC, newC);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length < 20_000, "render bị cap");
    assert.match(r.text, /diff truncated/);
  });

  it("header format chuẩn unified diff", () => {
    const r = unifiedDiff("src/x.ts", "a\n", "b\n");
    assert.match(r.text, /^--- a\/src\/x\.ts\n\+\+\+ b\/src\/x\.ts\n/);
  });
});

describe("diffCounts", () => {
  it("đếm chính xác added/removed", () => {
    const c = diffCounts("a\nb\nc\n", "a\nx\ny\nc\n");
    assert.equal(c.added, 2);
    assert.equal(c.removed, 1);
  });
  it("file lớn -> trả counts thô không crash", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `${i}`).join("\n");
    const c = diffCounts(big, big + "x");
    assert.equal(c.added, 3000);
    assert.equal(c.removed, 3000);
  });
});

// ── retry ───────────────────────────────────────────────────────────────────

describe("isRetryableStatus / isRetryableNetworkError", () => {
  it("429/5xx retryable, 4xx khác không", () => {
    for (const s of [429, 500, 502, 503, 504]) assert.ok(isRetryableStatus(s));
    for (const s of [400, 401, 403, 404, 422]) assert.ok(!isRetryableStatus(s));
  });
  it("network errors retryable", () => {
    assert.ok(isRetryableNetworkError(new Error("fetch failed")));
    assert.ok(isRetryableNetworkError(new Error("socket hang up")));
    assert.ok(!isRetryableNetworkError(new Error("invalid json")));
  });
});

describe("withRetry", () => {
  it("thành công ngay -> không retry", async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls++; return "ok"; });
    assert.equal(r, "ok");
    assert.equal(calls, 1);
  });

  it("retry lỗi 500 rồi thành công", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 3) { const e = new Error("boom"); e.status = 500; throw e; }
        return "done";
      },
      { baseDelayMs: 1 },
    );
    assert.equal(r, "done");
    assert.equal(calls, 3);
  });

  it("4xx (trừ 429) fail ngay, không retry", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        const e = new Error("unauthorized"); e.status = 401; throw e;
      }),
      /unauthorized/,
    );
    assert.equal(calls, 1, "không retry 401");
  });

  it("hết retries -> throw lỗi cuối", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => { calls++; const e = new Error("still down"); e.status = 503; throw e; },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    );
    assert.equal(calls, 3); // 1 lần đầu + 2 retries (maxRetries: 2)
  });

  it("Retry-After header được tôn trọng (delay = giá trị header)", async () => {
    let calls = 0;
    const delays = [];
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) { const e = new Error("rate"); e.status = 429; e.retryAfterMs = 5; throw e; }
        return "ok";
      },
      { baseDelayMs: 9999 },
      (_a, delayMs) => { delays.push(delayMs); },
    );
    assert.equal(delays[0], 5, "delay = Retry-After (5ms), không phải exponential 9999ms");
  });

  it("H-09: mặc định ≤4 attempts (5 calls total)", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; const e = new Error("down"); e.status = 503; throw e; }, { baseDelayMs: 1 }),
    );
    assert.equal(calls, 5, "1 lần đầu + 4 retries");
  });

  it("H-09: delay cap ở maxDelayMs (30s mặc định)", async () => {
    let calls = 0;
    const delays = [];
    await assert.rejects(
      withRetry(
        async () => { calls++; const e = new Error("down"); e.status = 503; throw e; },
        { maxRetries: 3, baseDelayMs: 10_000, maxDelayMs: 12_000 },
        (_a, delayMs) => { delays.push(delayMs); },
      ),
    );
    assert.ok(
      delays[0] >= 10_000 && delays[0] <= 10_500 && delays[1] === 12_000 && delays[2] === 12_000,
      `delays capped at maxDelayMs (got ${delays.join(",")})`,
    );
  });
});

// ── context ─────────────────────────────────────────────────────────────────

describe("trimHistory", () => {
  it("giữ system prompt + cắt bớt history cũ", () => {
    const msgs = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `u${i}` })),
    ];
    const out = trimHistory(msgs);
    assert.equal(out[0].role, "system");
    assert.ok(out.length <= 120);
    assert.equal(out[out.length - 1].content, "u199", "message cuối phải được giữ");
  });
  it("không trim khi dưới giới hạn", () => {
    const msgs = [{ role: "user", content: "hi" }];
    assert.equal(trimHistory(msgs).length, 1);
  });
  it("ngân sách token: drop nguyên turn cũ (không mồ côi tool result)", async () => {
    const turn = (i, withTool = true) => [
      { role: "user", content: `task ${i}` },
      ...(withTool
        ? [
            { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
            { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(60_000) },
            { role: "assistant", content: `done ${i}` },
          ]
        : []),
    ];
    const msgs = [
      { role: "system", content: "sys" },
      ...turn(1), ...turn(2), ...turn(3), ...turn(4),
      { role: "user", content: "final question" },
    ];
    const out = trimHistory(msgs);
    // I-10: token-accurate budget — mỗi turn 60k chars ≫ budget nên chỉ turn
    // cuối sống; assert theo token count (x64 repeated chars nén ~ x tokens).
    const { estimateTokens } = await import("../dist/context/compaction.js");
    assert.ok(estimateTokens(out) < 90_000, `budget respected (tokens=${estimateTokens(out)})`);
    // mọi assistant tool_calls vẫn có tool result đi kèm
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (m.role === "assistant" && m.tool_calls?.length) {
        const ids = m.tool_calls.map((t) => t.id);
        const hasAll = out.slice(i + 1).some((t) => t.role === "tool" && ids.includes(t.tool_call_id));
        assert.ok(hasAll, `tool_calls ${ids.join(",")} không bị mồ côi`);
      }
    }
    assert.equal(out[out.length - 1].content, "final question");
  });
  it("custom token budget (compaction-aware trim) is respected", async () => {
    const msgs = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `u${i}-` + "word ".repeat(80) })),
    ];
    const out = trimHistory(msgs, 2_000);
    const { estimateTokens } = await import("../dist/context/compaction.js");
    assert.ok(out.length < msgs.length, "phải cắt bớt");
    assert.ok(estimateTokens(out) < 2_500, `custom budget respected (tokens=${estimateTokens(out)})`);
    assert.equal(out[out.length - 1].content, msgs[msgs.length - 1].content, "message cuối giữ nguyên");
  });
  it("historyTokenBudget scales with the context window (95%) và giữ legacy cap", () => {
    assert.equal(MAX_HISTORY_TOKENS, 90_000);
    assert.equal(historyTokenBudget(128_000), 121_600);
    assert.ok(historyTokenBudget(128_000) > 128_000 * 0.8, "trim phải chạy sau compaction (80%)");
    assert.equal(historyTokenBudget(1_000), 2_000, "floor 2k");
  });
  it("prune tool result cũ giữ nội dung gần đây", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "t" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "tool", tool_call_id: `c${i}`, content: `r${i}` + "y".repeat(300) })),
    ];
    // P0-1: prune CHỈ xảy ra khi history vượt ngân sách — dưới ngân sách thì
    // history phải được giữ nguyên từng byte (KV-cache prefix ổn định).
    assert.equal(trimHistory(msgs), msgs, "dưới ngân sách: không sửa gì (identity)");
    const out = trimHistory(msgs, 2_000);
    const toolMsgs = out.filter((m) => m.role === "tool");
    const pruned = toolMsgs.filter((m) => m.content === PRUNED_TOOL_RESULT);
    assert.ok(pruned.length > 0, "phải prune tool cũ");
    assert.equal(toolMsgs[toolMsgs.length - 1].content.startsWith("r29"), true, "tool mới nhất giữ nguyên");
    assert.equal(out.length, msgs.length, "prune nội dung, không xoá message");
  });
  it("P0-1: history một task (không có message user thứ hai) vẫn bỏ được block cũ", () => {
    const turn = (i) => [
      { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, name: "read_file", arguments: "{}" }] },
      { role: "tool", tool_call_id: `c${i}`, content: "z".repeat(20_000) },
      { role: "assistant", content: `note ${i}` },
    ];
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "task" }, ...turn(1), ...turn(2), ...turn(3), ...turn(4)];
    const out = trimHistory(msgs, 4_000);
    assert.ok(out.length < msgs.length, `phải bỏ được block cũ ( còn ${out.length}/${msgs.length})`);
    assert.equal(out[0].role, "system");
    // không assistant nào có tool_calls bị cắt mất tool result của nó
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (m.role === "assistant" && m.tool_calls?.length) {
        const ids = m.tool_calls.map((t) => t.id);
        assert.ok(
          out.slice(i + 1).some((t) => t.role === "tool" && ids.includes(t.tool_call_id)),
          `tool_calls ${ids.join(",")} không bị mồ côi`,
        );
      }
    }
    assert.equal(out[out.length - 1].content, "note 4", "block cuối giữ nguyên");
  });
  it("P0-1: TRIM_RECOVERY_FRACTION — cắt sâu để thưa số lần trim", () => {
    const msgs = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `u${i}-` + "word ".repeat(40) })),
    ];
    const out = trimHistory(msgs, 2_000);
    assert.ok(out.length < msgs.length, "phải cắt");
    assert.equal(historyPressure(out, 2_000).over, false, "sau trim phải dưới ngân sách");
    // Hysteresis: cắt tới 70% ngân sách => gọi lại KHÔNG đổi gì thêm. Đây chính
    // là tính chất cần có để prefix KV-cache ổn định giữa nhiều bước.
    assert.equal(TRIM_RECOVERY_FRACTION, 0.7);
    assert.equal(trimHistory(out, 2_000), out, "trim lại lần hai phải là no-op (identity)");
  });
});

describe("historyPressure", () => {
  it("under budget: không tokenize, over=false", () => {
    const msgs = [{ role: "user", content: "short" }];
    const p = historyPressure(msgs, 10_000);
    assert.equal(p.over, false);
    assert.equal(p.budget, 10_000);
  });
  it("vượt budget theo token thật -> over=true", () => {
    // 4000 ký tự 'a' lặp -> số token nhỏ hơn số ký tự: budget 1000 vẫn over
    const msgs = [{ role: "user", content: "alpha beta gamma ".repeat(200) }];
    assert.equal(historyPressure(msgs, 100_000).over, false);
    assert.equal(historyPressure(msgs, 100).over, true);
  });
  it("tool_calls shape OpenAI (function.arguments) không làm crash", () => {
    const msgs = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
    ];
    assert.equal(historyPressure(msgs, 10).over, false);
  });
});

describe("summariseOutput", () => {
  it("output ngắn -> giữ nguyên", () => {
    assert.equal(summariseOutput("short"), "short");
  });
  it("output dài -> truncate + giữ đầu/cuối", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const s = summariseOutput(long, 500);
    assert.ok(s.length <= 600);
    assert.match(s, /lines omitted/);
    assert.match(s, /line 199/);
  });
});

describe("claimsCompletion", () => {
  it("khớp cụm hoàn thành rõ ràng", () => {
    for (const t of [
      "Task is complete.",
      "The task is now completed.",
      "task done",
      "All done.",
      "The work is finished.",
      "WORK IS COMPLETE",
    ]) {
      assert.equal(claimsCompletion(t), true, `phải khớp: "${t}"`);
    }
  });

  it("KHÔNG khớp từ đơn lẻ xuất hiện trong câu thường (BUG-24 regression)", () => {
    for (const t of [
      "I'm not done yet — still working on it.",
      "Reading package.json before editing.",
      "The task description mentions testing.",
      "done with this file, moving on to the next one",
      "Finished reading src/index.ts.",
      "Here is the list of files I checked.",
    ]) {
      assert.equal(claimsCompletion(t), false, `không được khớp: "${t}"`);
    }
  });
});

// ── expandMentions (@file mention) ──────────────────────────────────────────

describe("expandMentions", () => {
  const workdir = mkdtempSync(join(tmpdir(), "scoder-mention-"));
  it("không có @ -> giữ nguyên task", () => {
    assert.equal(expandMentions("fix the bug", workdir), "fix the bug");
  });
  it("email không bị hiểu là mention", () => {
    assert.equal(expandMentions("mail me at bob@example.com about the bug", workdir), "mail me at bob@example.com about the bug");
  });
  it("@file tồn tại -> nội dung được inject, token bị remove", () => {
    writeFileSync(join(workdir, "a.ts"), "export const x = 1;\n");
    const r = expandMentions("fix @a.ts please", workdir);
    assert.ok(r.includes("fix please"), `token phải bị remove: ${r}`);
    assert.ok(r.includes("@a.ts:\nexport const x = 1;"), `nội dung phải được inject: ${r}`);
  });
  it("@path không tồn tại -> note rõ ràng, không crash", () => {
    const r = expandMentions("check @nope.ts", workdir);
    assert.match(r, /@nope\.ts: not found/);
  });
  it("@dir -> liệt kê entries", () => {
    mkdirSync(join(workdir, "sub"));
    writeFileSync(join(workdir, "sub", "f.js"), "x");
    const r = expandMentions("look at @sub", workdir);
    assert.match(r, /@sub\/ \(directory\)/);
    assert.ok(r.includes("f.js"));
  });
  it("path escape workdir -> bị chặn", () => {
    const r = expandMentions('see @"../outside.ts"', workdir);
    assert.match(r, /escapes working directory/);
  });
});
