/** When a measure's move between two windows counts as a regression. */
export interface Threshold {
  /** The least worsening, as a fraction of the previous value, that counts. */
  readonly relative: number;
  /** The fewest samples each window needs before its value is trusted. */
  readonly minSample: number;
}

// Placeholders for maintainers to tune here; nothing changes them at runtime.
const DEFAULT: Threshold = { relative: 0.2, minSample: 10 };
/**
 * Entries that replace the default for one measure, by measure name. `null` means the measure is
 * not compared: a volume grows with activity, so a project that simply does more work is not a
 * regression. The per-call, per-turn and share measures are compared as usual.
 */
const OVERRIDES: ReadonlyMap<string, Threshold | null> = new Map([
  ["tool_output_total", null],
  ["extraction_candidates", null],
]);

/** The threshold a measure's move is judged by, or null when the measure is not compared. */
export const thresholdFor = (measure: string) => {
  const override = OVERRIDES.get(measure);
  return override === undefined ? DEFAULT : override;
};
