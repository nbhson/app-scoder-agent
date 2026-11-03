/**
 * T5: mouse wheel (SGR 1006) — parse từ stdin raw chunk.
 * Module thuần; TuiApp attach listener qua useStdin().
 */

/** `\x1b[<64;x;yM` = wheel up, `\x1b[<65;...` = wheel down (SGR mode). */
export function parseWheel(chunk: string): "up" | "down" | null {
  // eslint-disable-next-line no-control-regex -- matching the ESC control sequence is the whole point here
  const m = /\x1b\[<(\d+);\d+;\d+[Mm]/.exec(chunk);
  if (!m) return null;
  const btn = Number(m[1]);
  if (btn === 64) return "up";
  if (btn === 65) return "down";
  return null;
}

/** Bật/tắt mouse tracking (SGR 1000 + 1006) — chỉ khi alt-screen TTY. */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";
