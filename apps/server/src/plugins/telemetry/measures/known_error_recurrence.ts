import { correctionFields } from "../fields.ts";
import { inWindow, type Measure, ok, type Spec, unavailable } from "./input.ts";

const spec = {
  measure: "known_error_recurrence",
  unit: "ratio",
  direction: "lower_is_better",
  provenance: [
    "learning.correction.createdAt",
    "learning.correction.declaredMode",
    "learning.item.failureMode",
    "learning.promotion.updatedAt",
  ],
} as const satisfies Spec;

/**
 * Of the window's corrections with a declared failure mode, the share whose mode the project's
 * learning item had already handed over, strictly before the correction was made.
 */
export const knownErrorRecurrence: Measure = (input) => {
  const { corrections, promotedItems } = input;
  if (corrections === undefined || promotedItems === undefined) {
    return unavailable(
      spec,
      "Corrections and learning items come from the learning plugin, which is not running.",
    );
  }
  const declared = corrections.flatMap((correction) => {
    const fields = correctionFields(correction);
    const mode = fields["learning.correction.declaredMode"];
    const at = fields["learning.correction.createdAt"];
    // The learning plugin lists `to` inclusively; the window excludes it.
    return mode !== null && inWindow(input, at) ? [{ mode, at }] : [];
  });
  if (declared.length === 0) {
    return unavailable(spec, "No correction with a declared failure mode in the window.");
  }
  const recurred = declared.filter(({ mode, at }) =>
    promotedItems.some((item) => item.failureMode === mode && item.promotedAt < at),
  );
  return ok(spec, recurred.length / declared.length, declared.length);
};
