import { type Measure, type Spec, unavailable } from "./input.ts";

const spec = {
  measure: "context_efficiency",
  unit: "tokens",
  direction: "lower_is_better",
  provenance: [],
} as const satisfies Spec;

/**
 * Output tokens per turn and cached-input share, split by routing tier. The split is the
 * measure, so a whole-window figure would answer a different question.
 */
export const contextEfficiency: Measure = () =>
  unavailable(
    spec,
    "This measure is split by routing tier, and the routing plugin does not record which tier ran a turn until #19.",
  );
