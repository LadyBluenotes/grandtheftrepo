import type { TelemetryMeasure } from "@t3tools/contracts";
import type { Threshold } from "./thresholds.ts";

const format = (value: number, unit: TelemetryMeasure["unit"]) =>
  unit === "ratio" || unit === "usd" ? value.toFixed(2) : String(Math.round(value));

/**
 * The summary of the regression one measure shows from `previous` to `current`, such as
 * `context_efficiency 1200 → 1700 (+42%)`, or null when there is none. Worsening is the relative
 * move in the measure's bad direction; a regression is worsening at or above the threshold. The
 * windows cannot say when either is unavailable or under the minimum sample, or the previous
 * value is null or 0, and that is no regression either. The percentage is the raw move, so a
 * `higher_is_better` regression reads as a drop.
 */
export const compare = (
  previous: TelemetryMeasure,
  current: TelemetryMeasure,
  { relative, minSample }: Threshold,
) => {
  if (previous.state === "unavailable" || current.state === "unavailable") return null;
  if (previous.sampleSize < minSample || current.sampleSize < minSample) return null;
  if (previous.value === null || previous.value === 0 || current.value === null) return null;
  const change = (current.value - previous.value) / previous.value;
  const worsening = current.direction === "higher_is_better" ? -change : change;
  if (worsening < relative) return null;
  const percent = Math.round(change * 100);
  const from = format(previous.value, current.unit);
  const to = format(current.value, current.unit);
  return `${current.measure} ${from} → ${to} (${percent < 0 ? "" : "+"}${percent}%)`;
};
