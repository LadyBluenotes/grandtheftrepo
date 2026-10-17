import {
  ACCEPTED_PROVENANCE,
  acceptedOutcomes,
  type Measure,
  ok,
  type Spec,
  unavailable,
  windowRuns,
} from "./input.ts";

const spec = {
  measure: "delegation_overhead",
  unit: "tokens",
  direction: "lower_is_better",
  provenance: [
    ...ACCEPTED_PROVENANCE,
    "run.id",
    "run.threadId",
    "run.startedAt",
    "provider-turn.updated.runId",
    "providerTurn.tokenUsage.inputTokens",
    "providerTurn.tokenUsage.outputTokens",
  ],
} as const satisfies Spec;

/**
 * Input plus output tokens of the child tasks of the accepted outcomes in the window, per accepted
 * outcome. Every accepted outcome is in the denominator, delegating or not, so an outcome that
 * delegated nothing counts as zero and a window with no delegation at all is a real zero. Like
 * `cost_per_accepted_outcome`, it counts the turns of runs that started in the window, not an
 * outcome's whole spend. A fork is not a child task. A child turn missing either count is left
 * out, and when every child turn is, the value is unavailable.
 */
export const delegationOverhead: Measure = (input) => {
  const outcomes = acceptedOutcomes(input);
  if (outcomes.length === 0) return unavailable(spec, "No accepted outcome in the window.");
  const parents = new Set(outcomes.map((thread) => thread.thread_id));
  const childIds = new Set(
    input.threads
      .filter((thread) => thread.parent_thread_id !== null && parents.has(thread.parent_thread_id))
      .map((thread) => thread.thread_id),
  );
  const childRuns = new Set(
    windowRuns(input)
      .filter((run) => childIds.has(run.thread_id))
      .map((run) => run.run_id),
  );
  let turns = 0;
  let counted = 0;
  let tokens = 0;
  for (const turn of input.turnUsage) {
    if (turn.run_id === null || !childRuns.has(turn.run_id)) continue;
    turns += 1;
    if (turn.input_tokens === null || turn.output_tokens === null) continue;
    counted += 1;
    tokens += turn.input_tokens + turn.output_tokens;
  }
  if (turns > 0 && counted === 0) {
    return unavailable(
      spec,
      "No child task of an accepted outcome reported input and output token counts for a run in the window.",
    );
  }
  return ok(
    spec,
    tokens / outcomes.length,
    outcomes.length,
    counted === turns
      ? null
      : `${turns - counted} of ${turns} child turns were left out: their provider did not report input and output counts.`,
  );
};
