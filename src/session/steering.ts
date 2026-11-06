/**
 * I5: Steering inbox tách module — policy delivery tại safe step boundary
 * (pattern từ opencode session/runner). Thread-safe trong 1 event loop:
 * push từ TUI/serve, drain ở đầu mỗi step của runLoop. Không rơi message:
 * drain nguyên batch (FIFO), steer giữa parallel tool calls chờ tới boundary.
 */
export class SteeringInbox {
  private items: Array<{ mode: "steer" | "queue"; text: string }> = [];

  /** Steer: deliver ở NEXT step boundary (kể cả khi đang chạy tool). */
  steer(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.items.push({ mode: "steer", text: t });
  }

  /** Queue: same inbox — caller phân biệt mode chỉ để log/event. */
  queue(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.items.push({ mode: "queue", text: t });
  }

  /** Drain toàn bộ (FIFO) — một batch cho step boundary này. */
  drain(): Array<{ mode: "steer" | "queue"; text: string }> {
    const out = this.items;
    this.items = [];
    return out;
  }

  get size(): number {
    return this.items.length;
  }

  /** Breakdown for the `queue` event: total pending vs steer-mode count. */
  counts(): { pending: number; steering: number } {
    return { pending: this.items.length, steering: this.items.filter((x) => x.mode === "steer").length };
  }

  clear(): void {
    this.items = [];
  }
}
