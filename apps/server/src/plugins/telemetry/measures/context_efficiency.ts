import { type Measure, ok, type Spec, unavailable, windowRuns } from "./input.ts";

const spec = {
  measure: "context_efficiency",
  unit: "tokens",
  direction: "lower_is_better",
  provenance: [
    "run.id",
    "run.startedAt",
    "run.providerInstanceId",
    "run.modelSelection.model",
    "provider-turn.updated.runId",
    "providerTurn.tokenUsage.outputTokens",
  ],
} as const satisfies Spec;

/**
 * Output tokens per provider turn, over the turns of runs that started in the window on one
 * routing tier's model. Tiers run models that answer at different lengths by design, so a figure
 * across tiers would answer a different question: without a tier it is unavailable. A turn whose
 * provider did not report output tokens is left out.
 */
export const contextEfficiency: Measure = (input) => {
  const { tier } = input;
  if (tier === undefined) {
    return unavailable(spec, "This measure is per routing tier; ask for it with a tier.");
  }
  const runs = new Set(windowRuns(input).map((run) => run.run_id));
  let turns = 0;
  let counted = 0;
  let tokens = 0;
  for (const turn of input.turnUsage) {
    if (turn.run_id === null || !runs.has(turn.run_id)) continue;
    turns += 1;
    if (turn.output_tokens === null) continue;
    counted += 1;
    tokens += turn.output_tokens;
  }
  if (counted === 0) {
    return unavailable(
      spec,
      turns === 0
        ? `No turn on the ${tier} tier's model in the window reported token usage.`
        : `No turn on the ${tier} tier's model in the window reported output tokens.`,
    );
  }
  return ok(
    spec,
    tokens / counted,
    counted,
    counted === turns
      ? null
      : `${turns - counted} of ${turns} turns were left out: their provider did not report output tokens.`,
  );
};
