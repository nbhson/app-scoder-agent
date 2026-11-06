/** Scroll viewport metrics + mouse wheel (SGR 1006) wiring for the TUI. */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useBoxMetrics, useStdin, type DOMElement } from "ink";
import { parseWheel, MOUSE_ENABLE, MOUSE_DISABLE } from "../mouse.js";

export function useScrollMetrics(setScrollOffset: Dispatch<SetStateAction<number>>) {
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
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const wheelScroll = useCallback((dir: "up" | "down") => {
    setScrollOffset((o) => Math.max(0, o + (dir === "up" ? 3 : -3)));
  }, []);
  useEffect(() => {
    if (process.stdout.isTTY !== true || !isRawModeSupported) return;
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
    };
  }, [stdin, setRawMode, isRawModeSupported, wheelScroll]);
  return { viewportRef, contentRef, viewport, content, viewportRowsRef };
}
