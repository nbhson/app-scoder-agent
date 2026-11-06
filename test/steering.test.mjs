/**
 * I5: SteeringInbox module — FIFO batch drain, steer giữa tool chạy không rơi.
 * Chạy: node --test test/steering.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SteeringInbox } from "../dist/session/steering.js";

describe("SteeringInbox (I5)", () => {
  it("FIFO drain nguyên batch", () => {
    const b = new SteeringInbox();
    b.steer("first");
    b.steer("second");
    b.queue("third");
    const out = b.drain();
    assert.deepEqual(out.map((x) => x.text), ["first", "second", "third"]);
    assert.equal(b.size, 0);
    assert.deepEqual(b.drain(), []);
  });

  it("text rỗng/chỉ whitespace bị bỏ qua", () => {
    const b = new SteeringInbox();
    b.steer("   ");
    b.queue("");
    assert.equal(b.size, 0);
  });

  it("steer giữa 'tool chạy' (không drain) → message giữ nguyên tới boundary", () => {
    const b = new SteeringInbox();
    b.steer("during tool");
    // mô phỏng: runLoop chưa tới boundary — inbox vẫn giữ
    assert.equal(b.size, 1);
    // boundary → drain đủ, không mất
    assert.deepEqual(b.drain().map((x) => x.text), ["during tool"]);
  });

  it("mode steer/queue được phân biệt trong batch", () => {
    const b = new SteeringInbox();
    b.steer("s");
    b.queue("q");
    const out = b.drain();
    assert.deepEqual(out.map((x) => x.mode), ["steer", "queue"]);
  });

  it("clear() bỏ hết", () => {
    const b = new SteeringInbox();
    b.steer("x");
    b.clear();
    assert.equal(b.size, 0);
  });
});
