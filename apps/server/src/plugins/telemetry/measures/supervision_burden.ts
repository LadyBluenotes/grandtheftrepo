import { type Measure, type Spec, unavailable } from "./input.ts";

const spec = {
  measure: "supervision_burden",
  unit: "count",
  direction: "lower_is_better",
  provenance: [],
} as const satisfies Spec;

/** Attention flags raised per accepted outcome. */
export const supervisionBurden: Measure = () =>
  unavailable(
    spec,
    "The plugin supervisor keeps only its latest tick's flag counts; flag history is not kept yet (#12).",
  );
