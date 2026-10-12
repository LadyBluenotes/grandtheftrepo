import { type Measure, type Spec, unavailable } from "./input.ts";

const spec = {
  measure: "knowledge_reuse",
  unit: "ratio",
  direction: "higher_is_better",
  provenance: [],
} as const satisfies Spec;

/** Share of runs that read a knowledge page before editing. */
export const knowledgeReuse: Measure = () =>
  unavailable(
    spec,
    "Knowledge pages come from the knowledge plugin, which is not built yet, so no read of one is recorded.",
  );
