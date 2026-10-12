import { type Measure, type Spec, unavailable } from "./input.ts";

const spec = {
  measure: "first_review_acceptance",
  unit: "ratio",
  direction: "higher_is_better",
  provenance: [],
} as const satisfies Spec;

/** Of threads that were reviewed, how many passed on the first review. */
export const firstReviewAcceptance: Measure = () =>
  unavailable(spec, "Review verdicts come from the review plugin (#4), which is not built yet.");
