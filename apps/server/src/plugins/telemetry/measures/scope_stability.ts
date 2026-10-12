import { type Measure, type Spec, unavailable } from "./input.ts";

const spec = {
  measure: "scope_stability",
  unit: "ratio",
  direction: "lower_is_better",
  provenance: [],
} as const satisfies Spec;

/** Threads whose acceptance criteria were amended after admission, over admitted threads. */
export const scopeStability: Measure = () =>
  unavailable(
    spec,
    "The kanban plugin (#22) does not record admission or acceptance-criteria amendments yet; #28 adds that record.",
  );
