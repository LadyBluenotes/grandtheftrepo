/** When a measure's move between two windows counts as a regression. */
export interface Threshold {
  /** The least worsening, as a fraction of the previous value, that counts. */
  readonly relative: number;
  /** The fewest samples each window needs before its value is trusted. */
  readonly minSample: number;
}

// Placeholders for maintainers to tune here; nothing changes them at runtime.
const DEFAULT: Threshold = { relative: 0.2, minSample: 10 };
/** Thresholds that replace the default for one measure, by measure name. */
const OVERRIDES: ReadonlyMap<string, Threshold> = new Map();

export const thresholdFor = (measure: string) => OVERRIDES.get(measure) ?? DEFAULT;
