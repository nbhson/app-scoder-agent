/** Scroll viewport metrics + mouse wheel (SGR 1006) wiring for the TUI.
 * P1-8: contentRef giờ đo CỬA SỔ item đã mount (không phải cả transcript) —
 * chi phí đo O(window) nên vẫn rẻ; số đo thật dùng cho follow-bottom chính
 * xác, ước lượng (transcriptWindow) chỉ dùng khi scroll lên trên.
 * mouseEnabled=false (select mode, Ctrl+O): nhả mouse tracking để terminal
 * cho tô đen kéo chuột + copy thường — wheel scroll tắt, dùng PgUp/PgDn. */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useBoxMetrics, useStdin, type DOMElement } from "ink";
import { parseWheel, MOUSE_ENABLE, MOUSE_DISABLE } from "../mouse.js";

export function useScrollMetrics(
  setScrollOffset: Dispatch<SetStateAction<number>>,
  mouseEnabled = true,
) {
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const viewportRowsRef = useRef<number | null>(null);
  useEffect(() => {
    viewportRowsRef.current = viewport.clientHeight || null;
  }, [viewport.clientHeight]);
  // T5: mouse wheel scroll (SGR 1006) — raw stdin listener; Ink's useInput
  // drops unrepresentable CSI sequences, so wheel events must be read here.
  // Only in alt-screen TTY (mouse tracking sequences corrupt plain pipes).
  // Select mode (mouseEnabled=false): MOUSE_DISABLE → native terminal drag
  // selection/copy returns; setRawMode calls stay balanced across toggles.
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const wheelScroll = useCallback((dir: "up" | "down") => {
    setScrollOffset((o) => Math.max(0, o + (dir === "up" ? 3 : -3)));
  }, []);
  useEffect(() => {
    if (process.stdout.isTTY !== true || !isRawModeSupported) return;
    if (!mouseEnabled) {
      process.stdout.write(MOUSE_DISABLE);
      return;
    }
    process.stdout.write(MOUSE_ENABLE);
    setRawMode(true);
    const onData = (chunk: Buffer | string) => {
      const dir = parseWheel(String(chunk));
      if (dir) wheelScroll(dir);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      process.stdout.write(MOUSE_DISABLE);
      setRawMode(false);
    };
  }, [stdin, setRawMode, isRawModeSupported, wheelScroll, mouseEnabled]);
  return { viewportRef, viewport, contentRef, content, viewportRowsRef };
}
