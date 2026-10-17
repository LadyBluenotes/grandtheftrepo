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
  provenance: [...ACCEPTED_PROVENANCE, "run.threadId", "run.startedAt"],
} as const satisfies Spec;

/**
 * Mean seconds from an accepted outcome's first turn, the earliest start among its thread's runs,
 * to its latest settlement. An outcome none of whose runs started is left out.
 */
export const timeToAcceptedOutcome: Measure = (input) => {
  const outcomes = acceptedOutcomes(input);
  if (outcomes.length === 0) return unavailable(spec, "No accepted outcome in the window.");
  const firstTurn = new Map<string, string>();
  for (const run of input.runs) {
    const earliest = firstTurn.get(run.thread_id);
    if (run.started_at !== null && (earliest === undefined || run.started_at < earliest)) {
      firstTurn.set(run.thread_id, run.started_at);
    }
  }
  let measured = 0;
  let total = 0;
  for (const thread of outcomes) {
    const start = firstTurn.get(thread.thread_id);
    if (start === undefined) continue;
    measured += 1;
    total += seconds(start, thread.settled_at);
  }
  if (measured === 0) {
    return unavailable(spec, "No accepted outcome in the window has a run that started.");
  }
  return ok(
    spec,
    total / measured,
    measured,
    measured === outcomes.length
      ? null
      : `${outcomes.length - measured} of ${outcomes.length} accepted outcomes were left out: none of their runs started.`,
  );
};
