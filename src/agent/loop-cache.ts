/**
 * Cache chống lặp trong một run (loop-breaker tầng thực thi).
 *
 * Doom-loop guardrail chỉ can thiệp SAU khi tool đã chạy xong. Với model hay lặp
 * theo chu kỳ (`read → grep → web_fetch → lặp lại`), chi phí thật nằm ở chỗ tool
 * bị chạy lại mỗi vòng: fetch lại đúng URL, grep lại đúng pattern, đọc lại đúng
 * file. Cache này cắt ngay từ nguồn: lần thứ 2 gọi đúng cùng tool + cùng args thì
 * KHÔNG chạy thật, trả lại kết quả cũ kèm dòng "bạn đã gọi lệnh này rồi" — bằng
 * chứng cụ thể để model thoát loop thay vì cãi lại với chính nó.
 *
 * An toàn:
 *  - chỉ tool read-only được cache (caller lọc qua READONLY_TOOLS);
 *  - mọi tool biến đổi (write/edit/patch/run_command) xoá sạch cache — thế giới
 *    đã đổi thì kết quả đọc cũ không còn đúng nữa;
 *  - chỉ cache kết quả ok; lỗi phải được thử lại thật (error-loop lo việc đó).
 */
import { callSignature } from "./tool-signature.js";

export interface CachedCall {
  ok: boolean;
  output: string;
  /** Bước đã chạy thật lần đầu — trích dẫn lại cho model thấy nó đang lặp. */
  step: number;
}

/** Trần số entry mỗi run (FIFO) — run dài không giữ vô hạn output cũ. */
const MAX_ENTRIES = 64;

export class LoopCallCache {
  private entries = new Map<string, CachedCall>();
  /** Số lần tra trúng — đo mức độ lặp, log ra để debug model hay loop. */
  hits = 0;
  /** Lý do xoá cache gần nhất (quan sát được, không ảnh hưởng hành vi). */
  lastInvalidatedReason = "";

  /** Xoá toàn bộ state — gọi đầu mỗi run (đồng bộ với guardrails.reset()). */
  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.lastInvalidatedReason = "";
  }

  /** Khoá tra theo tool + args đã chuẩn hoá (không phụ thuộc cách model in JSON). */
  keyFor(name: string, rawArgs: string | undefined): string {
    return callSignature(name, rawArgs);
  }

  lookup(key: string): CachedCall | null {
    const hit = this.entries.get(key) ?? null;
    if (hit) this.hits++;
    return hit;
  }

  /** Ghi kết quả run-thật đầu tiên; không ghi đè (lần đầu là bản gốc). */
  record(key: string, step: number, call: { ok: boolean; output: string }): void {
    if (!call.ok) return;
    if (this.entries.has(key)) return;
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { ok: call.ok, output: call.output, step });
  }

  /** Thế giới đổi (tool biến đổi chạy thành công) ⇒ mọi kết quả đọc cũ vô giá trị. */
  invalidate(reason: string): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.lastInvalidatedReason = reason;
  }

  size(): number {
    return this.entries.size;
  }
}
