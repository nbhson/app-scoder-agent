/**
 * T5: vim-motion cho Input — mode normal/insert, word motions.
 * Module thuần (test được); Input chỉ wire keymap.
 */

export type VimMode = "insert" | "normal";

/** w — đầu từ kế tiếp (vim: skip word chars rồi skip whitespace). */
export function wordForward(s: string, i: number): number {
  while (i < s.length && /\S/.test(s[i])) i++;
  while (i < s.length && /\s/.test(s[i])) i++;
  return Math.min(i, s.length);
}

/** b — đầu từ trước. */
export function wordBack(s: string, i: number): number {
  i--;
  while (i > 0 && /\s/.test(s[i])) i--;
  while (i > 0 && /\S/.test(s[i - 1])) i--;
  return Math.max(0, i);
}

/** e — cuối từ hiện tại/kế tiếp. */
export function wordEnd(s: string, i: number): number {
  i++;
  while (i < s.length - 1 && /\s/.test(s[i])) i++;
  while (i < s.length - 1 && /\S/.test(s[i + 1])) i++;
  return Math.min(i, Math.max(0, s.length - 1));
}

export interface VimResult {
  value: string;
  cursor: number;
  mode: VimMode;
  /** true nếu key không phải vim motion — caller xử lý tiếp. */
  unhandled: boolean;
}

/** Áp dụng một phím normal-mode. Trả về unhandled=true khi không phải motion. */
export function applyNormalKey(value: string, cursor: number, input: string): VimResult {
  const ok = (v: string, c: number, mode: VimMode = "normal"): VimResult => ({ value: v, cursor: c, mode, unhandled: false });
  switch (input) {
    case "h":
      return ok(value, Math.max(0, cursor - 1));
    case "l":
      return ok(value, Math.min(value.length, cursor + 1));
    case "w":
      return ok(value, wordForward(value, cursor));
    case "b":
      return ok(value, wordBack(value, cursor));
    case "e":
      return ok(value, wordEnd(value, cursor));
    case "0":
      return ok(value, 0);
    case "$":
      return ok(value, value.length);
    case "x":
      return cursor < value.length ? ok(value.slice(0, cursor) + value.slice(cursor + 1), cursor) : ok(value, cursor);
    case "i":
      return ok(value, cursor, "insert");
    case "a":
      return ok(value, Math.min(value.length, cursor + 1), "insert");
    case "A":
      return ok(value, value.length, "insert");
    default:
      return { value, cursor, mode: "normal", unhandled: true };
  }
}
