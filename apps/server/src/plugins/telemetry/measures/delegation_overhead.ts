import {
  ACCEPTED_PROVENANCE,
  acceptedOutcomes,
  type Measure,
  ok,
  type Spec,
  unavailable,
} from "./input.ts";

const spec = {
  measure: "delegation_overhead",
  unit: "tokens",
  direction: "lower_is_better",
  provenance: [
    ...ACCEPTED_PROVENANCE,
    "provider-turn.updated.threadId",
    "providerTurn.tokenUsage.inputTokens",
    "providerTurn.tokenUsage.outputTokens",
  ],
} as const satisfies Spec;

/**
 * Input plus output tokens of the child tasks of each accepted outcome that delegated one, per
 * such outcome. A fork is not a child task. A child turn missing either count is left out.
 */
export const delegationOverhead: Measure = (input) => {
  const parents = new Set(acceptedOutcomes(input).map((thread) => thread.thread_id));
  const children = input.threads.filter(
    (thread) => thread.parent_thread_id !== null && parents.has(thread.parent_thread_id),
  );
  const childIds = new Set(children.map((thread) => thread.thread_id));
  const delegating = new Set(children.map((thread) => thread.parent_thread_id));
  if (delegating.size === 0) {
    return unavailable(spec, "No accepted outcome in the window delegated a child task.");
  }
  let turns = 0;
  let counted = 0;
  let tokens = 0;
  for (const turn of input.turnUsage) {
    if (!childIds.has(turn.thread_id)) continue;
    turns += 1;
    if (turn.input_tokens === null || turn.output_tokens === null) continue;
    counted += 1;
    tokens += turn.input_tokens + turn.output_tokens;
  }
  if (counted === 0) {
    return unavailable(spec, "No child task of an accepted outcome reported token usage.");
  }
  return ok(
    spec,
    tokens / delegating.size,
    delegating.size,
    counted === turns
      ? null
      : `${turns - counted} of ${turns} child turns were left out: their provider did not report input and output counts.`,
  );
};
