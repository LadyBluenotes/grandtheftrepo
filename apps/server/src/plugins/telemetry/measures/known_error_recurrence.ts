import { type Measure, type Spec, unavailable } from "./input.ts";

const spec = {
  measure: "known_error_recurrence",
  unit: "ratio",
  direction: "lower_is_better",
  provenance: [],
} as const satisfies Spec;

/** How often a failure mode that already has an adopted fix shows up again. */
export const knownErrorRecurrence: Measure = () =>
  unavailable(
    spec,
    "Adopted fixes come from the learning plugin's learning items (#5), which are not built yet.",
  );
