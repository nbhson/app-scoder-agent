/**
 * Unit tests cho compaction (H-10).
 * Chạy: node --test test/compaction.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  shouldCompact,
  findCutIndex,
  extractSummaryInput,
  applyCompaction,
  DEFAULT_COMPACTION,
} from "../dist/compaction.js";

function fill(n, role = "user") {
  return Array.from({ length: n }, (_, i) => ({ role, content: `msg-${i}-`.repeat(50) }));
}

describe("estimateTokens", () => {
  it("token-accurate (gpt-tokenizer, I-10) — repeated chars nén tốt", () => {
    const t = estimateTokens([{ role: "user", content: "a".repeat(400) }]);
    // "aaaa…" nén mạnh (~50 tokens); char-heuristic cũ sẽ cho 100.
    assert.ok(t > 0 && t <= 100, `tokens=${t}`);
  });
  it("counts tool_calls arguments too", () => {
    const t = estimateTokens([{ role: "assistant", content: null, tool_calls: [{ id: "1", name: "run_command", arguments: '{"command":"'.concat("x".repeat(396), '"}') }] }]);
    assert.ok(t > 20);
  });
  it("prose tiếng Anh ~4 chars/token", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(10); // 460 chars
    const t = estimateTokens([{ role: "user", content: prose }]);
    assert.ok(t >= 80 && t <= 160, `tokens=${t}`);
  });
});

describe("shouldCompact", () => {
  it("false dưới ngưỡng", () => {
    const msgs = [{ role: "system", content: "s" }, ...fill(10)];
    assert.equal(shouldCompact(msgs, { ...DEFAULT_COMPACTION, contextWindow: 128_000 }), false);
  });
  it("true khi vượt trigger", () => {
    const msgs = [{ role: "system", content: "s" }, ...fill(400)];
    // 400 msgs × ~300 chars = ~120k chars = ~30k tokens; window 32k → 80% = 25.6k
    assert.equal(shouldCompact(msgs, { ...DEFAULT_COMPACTION, contextWindow: 32_000 }), true);
  });
});

describe("findCutIndex", () => {
  it("cut tại user-message boundary (không tách turn)", () => {
    const msgs = [{ role: "system", content: "s" }, { role: "user", content: "u0" }, { role: "assistant", content: "a0" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }];
    const cut = findCutIndex(msgs, { ...DEFAULT_COMPACTION, keep: 0, buffer: 0 });
    assert.ok(cut >= 1, "cut sau system");
    assert.equal(msgs[cut].role, "user", "tail bắt đầu bằng user message");
  });
  it("không tách cặp tool_calls/tool result", () => {
    const msgs = [
      { role: "system", content: "s" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", name: "run_command", arguments: "{}" }] },
      { role: "tool", tool_call_id: "t1", name: "run_command", content: "out" },
      { role: "user", content: "next" },
      { role: "assistant", content: "done" },
    ];
    const cut = findCutIndex(msgs, { ...DEFAULT_COMPACTION, keep: 0, buffer: 0 });
    // tail bắt đầu tại user → assistant tool_calls luôn sau cut hoặc nguyên vẹn
    for (let i = cut; i < msgs.length; i++) {
      if (msgs[i].role === "tool") {
        assert.ok(msgs[i - 1]?.role === "assistant" && !!msgs[i - 1].tool_calls, "tool result có assistant tool_calls liền trước trong tail");
      }
    }
  });
});

describe("extractSummaryInput", () => {
  it("gom task + files + commands", () => {
    const msgs = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: null, tool_calls: [{ id: "t", name: "write_file", arguments: '{"path":"src/a.ts"}' }] },
      { role: "tool", tool_call_id: "t", name: "write_file", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "t2", name: "run_command", arguments: '{"command":"npm test"}' }] },
    ];
    const s = extractSummaryInput("fix the bug", msgs);
    assert.match(s, /Original task: fix the bug/);
    assert.match(s, /src\/a\.ts/);
    assert.match(s, /npm test/);
  });
});

describe("applyCompaction", () => {
  it("giữ system + summary + tail; bỏ phần cũ", () => {
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "old1" }, { role: "assistant", content: "old1-a" }, { role: "user", content: "old2" }, { role: "assistant", content: "old2-a" }, { role: "user", content: "recent" }];
    const out = applyCompaction(msgs, "SUMMARY-TEXT", { ...DEFAULT_COMPACTION, keep: 0, buffer: 0 });
    assert.equal(out[0].content, "sys", "system giữ");
    assert.match(out[1].content, /Session summary \(auto-compact\)/);
    assert.match(out[1].content, /SUMMARY-TEXT/);
    assert.ok(out.length < msgs.length, "compact nhỏ hơn");
    assert.equal(out[out.length - 1].content, "recent", "message gần nhất giữ");
  });
  it("summary chứa task (invariant test spec H-10)", () => {
    const msgs = [{ role: "user", content: "build the thing" }];
    const summary = extractSummaryInput("build the thing", msgs);
    assert.match(summary, /build the thing/);
  });

  it("skeleton tool-call khung được giữ lại (I4)", () => {
    const cfg = { ...DEFAULT_COMPACTION, contextWindow: 2000, keep: 0, buffer: 0 };
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1 ".repeat(100) },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", name: "read_file", arguments: '{"path":"a/' + "x".repeat(300) + '"}' }] },
      { role: "user", content: "ob".repeat(200) },
      { role: "assistant", content: "claim xong" },
    ];
    const out = applyCompaction(msgs, "summary", cfg);
    const skeletons = out.filter((m) => m.tool_calls?.length);
    assert.ok(skeletons.length >= 1, "tool-call khung phải còn");
    const tc = skeletons[0].tool_calls[0];
    assert.ok(tc.arguments.length <= 121, `args phải truncated: ${tc.arguments.length}`);
  });
});
