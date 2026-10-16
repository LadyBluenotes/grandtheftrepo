import { priceUsage } from "../../../usage/usagePricing.ts";
import {
  ACCEPTED_PROVENANCE,
  acceptedOutcomes,
  type Measure,
  type MeasureInput,
  ok,
  type Spec,
  type TurnUsageRow,
  unavailable,
  windowRuns,
} from "./input.ts";

const spec = {
  measure: "cost_per_accepted_outcome",
  unit: "usd",
  direction: "lower_is_better",
  provenance: [
    ...ACCEPTED_PROVENANCE,
    "run.id",
    "run.startedAt",
    "run.modelSelection.model",
    "provider-turn.updated.runId",
    "providerTurn.tokenUsage.inputTokens",
    "providerTurn.tokenUsage.cachedInputTokens",
    "providerTurn.tokenUsage.outputTokens",
  ],
} as const satisfies Spec;

/**
 * One turn's cost at list rates, as the Usage page prices a record, or null when it cannot be
 * priced. Input includes cached input on every provider that reports both. Cache writes are not
 * reported, so they price as plain input, and every turn prices at standard speed.
 */
const turnCost = (pricing: MeasureInput["pricing"], model: string, turn: TurnUsageRow) => {
  if (
    turn.input_tokens === null ||
    turn.cached_input_tokens === null ||
    turn.output_tokens === null
  ) {
    return null;
  }
  const priced = priceUsage(
    pricing.rates,
    {
      model: pricing.aliases.get(model) ?? model,
      totals: {
        uncachedInputTokens: Math.max(0, turn.input_tokens - turn.cached_input_tokens),
        cachedInputTokens: turn.cached_input_tokens,
        cacheCreationTokens: 0,
        outputTokens: turn.output_tokens,
        reasoningTokens: 0,
      },
      speed: "standard",
      reportedCostUsd: null,
    },
    pricing.overrides,
  );
  return priced.costSource === "unpriced" ? null : priced.costUsd;
};

/** What every turn of a run that started in the window cost, per accepted outcome in it. */
export const costPerAcceptedOutcome: Measure = (input) => {
  const outcomes = acceptedOutcomes(input).length;
  if (outcomes === 0) return unavailable(spec, "No accepted outcome in the window.");
  const models = new Map(windowRuns(input).map((run) => [run.run_id, run.model]));
  let turns = 0;
  let priced = 0;
  let total = 0;
  for (const turn of input.turnUsage) {
    const model = turn.run_id === null ? undefined : models.get(turn.run_id);
    if (model === undefined) continue;
    turns += 1;
    const cost = turnCost(input.pricing, model, turn);
    if (cost === null) continue;
    priced += 1;
    total += cost;
  }
  if (priced === 0) {
    return unavailable(
      spec,
      turns === 0
        ? "No turn in the window reported token usage."
        : "No turn in the window could be priced: none has input, cached-input and output counts and a model with a known rate.",
    );
  }
  return ok(
    spec,
    total / outcomes,
    outcomes,
    priced === turns
      ? null
      : `${turns - priced} of ${turns} turns in the window were left out: their provider did not report every token count, or their model has no known rate.`,
  );
};
