import { useEffect, useState } from "react";

/** Burst length / cadence shared by every ROUTER-style pulse (P2.3). */
export const PULSE_FRAMES = 6;
export const PULSE_MS = 110;

/**
 * Phase D packet cadence: one burst of frames 0..PULSE_FRAMES-1 (~0.7 s at
 * 110 ms) every time `ts` changes to a non-null value, then -1 = at rest.
 * No idle timer ever runs. `SCODER_ANIM=0` / `SCODER_NO_MOTION=1` (CI, weak
 * machines, reduced-motion) → permanently -1 with no timer at all.
 *
 * Extracted from the ROUTER tab (`useRoutePulse`) so diagram focus pulses
 * (FlowchartView packet) share the exact same behaviour and contract.
 */
export function usePulse(ts: number | null | undefined): number {
  const [frame, setFrame] = useState(-1);
  useEffect(() => {
    if (ts == null || process.env.SCODER_ANIM === "0" || process.env.SCODER_NO_MOTION === "1") {
      setFrame(-1);
      return;
    }
    setFrame(0);
    let f = 0;
    const id = setInterval(() => {
      f += 1;
      if (f >= PULSE_FRAMES) setFrame(-1);
      else setFrame(f);
    }, PULSE_MS);
    return () => clearInterval(id);
  }, [ts]);
  return frame;
}
