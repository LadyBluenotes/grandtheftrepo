import type { TelemetryMeasure, TelemetryMeasuresResult } from "@t3tools/contracts";

import { contextEfficiency } from "./context_efficiency.ts";
import { costPerAcceptedOutcome } from "./cost_per_accepted_outcome.ts";
import { delegationOverhead } from "./delegation_overhead.ts";
import { firstReviewAcceptance } from "./first_review_acceptance.ts";
import type { MeasureInput } from "./input.ts";
import { knowledgeReuse } from "./knowledge_reuse.ts";
import { knownErrorRecurrence } from "./known_error_recurrence.ts";
import { materialCorrectionBurden } from "./material_correction_burden.ts";
import { recoveryEfficiency } from "./recovery_efficiency.ts";
import { repeatedFailedApproaches } from "./repeated_failed_approaches.ts";
import { repeatedReads } from "./repeated_reads.ts";
import { repeatedRediscovery } from "./repeated_rediscovery.ts";
import { CANDIDATES, deterministicWorkShare, extractionCandidates, SHARE } from "./repeatedWork.ts";
import { scopeStability } from "./scope_stability.ts";
import { supervisionBurden } from "./supervision_burden.ts";
import { timeToAcceptedOutcome } from "./time_to_accepted_outcome.ts";
import { MAX_PER_CALL, TOTAL, toolOutputMaxPerCall, toolOutputTotal } from "./toolOutput.ts";

/** Every measure, in the order issue #1 lists them, then the tool output and repeated work ones. */
const measures = [
  firstReviewAcceptance,
  materialCorrectionBurden,
  knownErrorRecurrence,
  timeToAcceptedOutcome,
  costPerAcceptedOutcome,
  contextEfficiency,
  knowledgeReuse,
  delegationOverhead,
  repeatedReads,
  repeatedRediscovery,
  repeatedFailedApproaches,
  scopeStability,
  recoveryEfficiency,
  supervisionBurden,
  toolOutputTotal,
  toolOutputMaxPerCall,
  deterministicWorkShare,
  extractionCandidates,
];

/**
 * Measures that read no routing tier: they look at what a project's tool calls do, whatever model
 * ran them, and count a provider's subagent's calls, which no tier claims. A budget on one still
 * names a tier, because a budget needs one, so the sweep asks for these without it and the budget
 * judges every run.
 */
export const TIER_INDEPENDENT_MEASURES: ReadonlySet<string> = new Set([
  TOTAL,
  MAX_PER_CALL,
  SHARE,
  CANDIDATES,
]);

export const computeMeasures = (input: MeasureInput): TelemetryMeasuresResult =>
  measures.map((measure) => measure(input));

const NO_ROWS: MeasureInput = {
  from: "",
  to: "",
  tier: undefined,
  projectDirectory: null,
  threads: [],
  runs: [],
  toolCalls: [],
  turnUsage: [],
  corrections: undefined,
  deliveries: undefined,
  verdicts: undefined,
  knowledgePages: undefined,
  pricing: { rates: new Map(), overrides: new Map(), aliases: new Map() },
};

/** Every measure without a value, all for one reason: for when no row can be trusted yet. */
export const unavailableMeasures = (missingReason: string): TelemetryMeasuresResult =>
  // A run over no rows gives each measure's name, unit, direction and provenance.
  computeMeasures(NO_ROWS).map((measure): TelemetryMeasure => ({
    ...measure,
    state: "unavailable",
    value: null,
    sampleSize: 0,
    missingReason,
  }));

/**
 * Whether `result` is `unavailableMeasures`' answer, every measure unavailable for one reason:
 * nothing was measured, so asking again later may answer.
 */
export const unmeasured = (result: TelemetryMeasuresResult) =>
  result.every(
    (measure) =>
      measure.state === "unavailable" && measure.missingReason === result[0]?.missingReason,
  );

/** Every measure's name, which a budget must name one of. */
export const MEASURE_NAMES: ReadonlySet<string> = new Set(
  computeMeasures(NO_ROWS).map((measure) => measure.measure),
);
