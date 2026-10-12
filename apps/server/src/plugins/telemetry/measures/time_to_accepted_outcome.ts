import {
  ACCEPTED_PROVENANCE,
  acceptedOutcomes,
  type Measure,
  ok,
  seconds,
  type Spec,
  unavailable,
} from "./input.ts";

const spec = {
  measure: "time_to_accepted_outcome",
  unit: "seconds",
  direction: "lower_is_better",
  provenance: [...ACCEPTED_PROVENANCE, "thread.createdAt"],
} as const satisfies Spec;

/** Mean seconds from a thread's creation, its first turn, to its latest settlement. */
export const timeToAcceptedOutcome: Measure = (input) => {
  const outcomes = acceptedOutcomes(input);
  if (outcomes.length === 0) return unavailable(spec, "No accepted outcome in the window.");
  const total = outcomes.reduce(
    (sum, thread) => sum + seconds(thread.created_at, thread.settled_at),
    0,
  );
  return ok(spec, total / outcomes.length, outcomes.length);
};
