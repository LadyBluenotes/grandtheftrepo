import type {
  RoutingAdherence,
  RoutingEntry,
  RoutingObservedDetail,
  RoutingTier,
  ThreadId,
} from "@t3tools/contracts";

/** A `routing_recommended` row. */
export interface Recommended {
  readonly id: number;
  /** The recommendation's instant, from `DateTime.formatIso`, so instants sort as strings. */
  readonly at: string;
  readonly threadId: ThreadId;
  readonly tier: RoutingTier;
  /** Null when the tier resolved to nothing: that launch inherited a model, so there is nothing to compare. */
  readonly entry: RoutingEntry | null;
}

/** A `routing_observed` row: what the recommended thread's first run used. */
export interface Observed {
  readonly recommendationId: number;
  readonly detail: RoutingObservedDetail;
}

const DEFAULT_MINIMUM_SAMPLE = 5;

const provenance = ["routing_recommended", "run.providerInstanceId", "run.modelSelection.model"];

/**
 * An answer without a value: `missingReason` says why, and `sampleSize` is how many observations
 * the window had. Also what the service answers when the rows may be incomplete.
 */
export const unavailableAdherence = (
  missingReason: string,
  sampleSize = 0,
  mismatches: RoutingAdherence["mismatches"] = [],
) =>
  ({
    measure: {
      measure: "routing_adherence",
      state: "unavailable",
      value: null,
      unit: "ratio",
      direction: "higher_is_better",
      sampleSize,
      missingReason,
      provenance,
    },
    mismatches,
  }) satisfies RoutingAdherence;

/**
 * The share of observed recommendations whose first run used the recommended provider instance and
 * model. A recommendation counts when it falls in `[from, to)` by its own time, names a model, and
 * has an observation; one whose thread has not run yet is left out until it does. Below
 * `minimumSample` observations the measure is `unavailable`. Every mismatch in the window is
 * listed either way, in the order the recommendations arrive.
 */
export const adherence = (
  input: {
    readonly recommended: ReadonlyArray<Recommended>;
    readonly observed: ReadonlyArray<Observed>;
    /** ISO instants from `DateTime.formatIso`. */
    readonly from: string;
    readonly to: string;
  },
  minimumSample = DEFAULT_MINIMUM_SAMPLE,
) => {
  const details = new Map(input.observed.map((row) => [row.recommendationId, row.detail]));
  const counted = input.recommended.flatMap((row) => {
    const detail = details.get(row.id);
    return row.entry === null || detail === undefined || row.at < input.from || row.at >= input.to
      ? []
      : [{ row, entry: row.entry, detail }];
  });
  const sampleSize = counted.length;
  const mismatches = counted.flatMap(({ row, entry, detail }) =>
    detail.matched
      ? []
      : [
          {
            threadId: row.threadId,
            tier: row.tier,
            recommended: entry,
            observed: detail.observed,
            at: row.at,
            flag: detail.flag,
          },
        ],
  );

  if (sampleSize === 0 || sampleSize < minimumSample) {
    return unavailableAdherence(
      `Needs at least ${minimumSample} observed launches in this window; found ${sampleSize}.`,
      sampleSize,
      mismatches,
    );
  }
  const matched = counted.filter(({ detail }) => detail.matched).length;
  return {
    measure: {
      measure: "routing_adherence",
      state: "ok",
      value: matched / sampleSize,
      unit: "ratio",
      direction: "higher_is_better",
      sampleSize,
      missingReason: null,
      provenance,
    },
    mismatches,
  } satisfies RoutingAdherence;
};
