import type { TelemetryMeasuresResult } from "@t3tools/contracts";

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
import { scopeStability } from "./scope_stability.ts";
import { supervisionBurden } from "./supervision_burden.ts";
import { timeToAcceptedOutcome } from "./time_to_accepted_outcome.ts";

/** Every measure, in the order issue #1 lists them. */
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
];

export const computeMeasures = (input: MeasureInput): TelemetryMeasuresResult =>
  measures.map((measure) => measure(input));
