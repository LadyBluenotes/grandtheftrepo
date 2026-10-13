import { correctionFields } from "../fields.ts";
import {
  ACCEPTED_PROVENANCE,
  acceptedOutcomes,
  inWindow,
  type Measure,
  ok,
  type Spec,
  unavailable,
} from "./input.ts";

const spec = {
  measure: "material_correction_burden",
  unit: "count",
  direction: "lower_is_better",
  provenance: [...ACCEPTED_PROVENANCE, "learning.correction.createdAt"],
} as const satisfies Spec;

/** Corrections the learning plugin recorded in the window, per accepted outcome in it. */
export const materialCorrectionBurden: Measure = (input) => {
  if (input.corrections === undefined) {
    return unavailable(spec, "Corrections come from the learning plugin, which is not running.");
  }
  const outcomes = acceptedOutcomes(input).length;
  if (outcomes === 0) return unavailable(spec, "No accepted outcome in the window.");
  // The learning plugin lists `to` inclusively; the window excludes it.
  const corrections = input.corrections.filter((correction) =>
    inWindow(input, correctionFields(correction)["learning.correction.createdAt"]),
  ).length;
  return ok(spec, corrections / outcomes, outcomes);
};
