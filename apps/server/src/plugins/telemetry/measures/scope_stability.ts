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
    "Admission and acceptance criteria come from the tickets plugin (#22), which is not built yet.",
  );
