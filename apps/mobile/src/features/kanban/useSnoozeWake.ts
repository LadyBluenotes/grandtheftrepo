import { useEffect, type Dispatch, type SetStateAction } from "react";

// setTimeout takes a signed 32-bit delay and fires at once beyond it.
const MAX_TIMEOUT_MS = 2_147_483_647;
// Past the wake time, so the redraw sees the snooze as over.
const WAKE_MARGIN_MS = 50;

/** How long to wait for `wakeAt`, clamped to what a timer can hold; null for a malformed time. */
export function snoozeWakeDelayMs(wakeAt: string, nowMs: number): number | null {
  const wakeAtMs = Date.parse(wakeAt);
  if (Number.isNaN(wakeAtMs)) return null;
  return Math.min(Math.max(0, wakeAtMs - nowMs) + WAKE_MARGIN_MS, MAX_TIMEOUT_MS);
}

/**
 * Bumps `tick` once `nextWakeAt` passes, so a screen that read the clock while computing its rows
 * computes them again. One timeout, armed for the earliest wake and re-armed whenever it changes
 * or fires: the thread lists on Home and in the sidebar do the same. A wake further out than a
 * timer can hold fires early with the same `nextWakeAt`, and `tick` re-arms it.
 */
export function useSnoozeWake(
  nextWakeAt: string | null,
  tick: number,
  setTick: Dispatch<SetStateAction<number>>,
) {
  useEffect(() => {
    if (nextWakeAt === null) return;
    const delayMs = snoozeWakeDelayMs(nextWakeAt, Date.now());
    if (delayMs === null) return;
    const id = setTimeout(() => setTick((current) => current + 1), delayMs);
    return () => clearTimeout(id);
  }, [nextWakeAt, tick, setTick]);
}
