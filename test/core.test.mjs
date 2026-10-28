/**
 * Unit tests cho diff.js, retry.js, context.js — core utilities.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff, diffCounts } from "../dist/diff.js";
import { withRetry, isRetryableStatus, isRetryableNetworkError, NonRetryableError } from "../dist/retry.js";
import { trimHistory, summariseOutput, claimsCompletion } from "../dist/context.js";

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
