import {
  callsByRun,
  type Measure,
  ok,
  type Spec,
  TOOL_CALL_PROVENANCE,
  unavailable,
  windowRuns,
} from "./input.ts";

const spec = {
  measure: "repeated_failed_approaches",
  unit: "ratio",
  direction: "lower_is_better",
  provenance: [...TOOL_CALL_PROVENANCE, "turnItem.status"],
} as const satisfies Spec;

/**
 * Failed tool calls that repeat an earlier failed call in the same run with the same tool and
 * path, over the failed calls of runs that started in the window. A call without a path never
 * repeats: nothing says it was the same approach.
 */
export const repeatedFailedApproaches: Measure = (input) => {
  const byRun = callsByRun(input.toolCalls);
  let failed = 0;
  let repeats = 0;
  let runs = 0;
  for (const run of windowRuns(input)) {
    const seen = new Set<string>();
    const failedBefore = failed;
    for (const call of byRun.get(run.run_id) ?? []) {
      if (call.status !== "failed") continue;
      failed += 1;
      if (call.path === null) continue;
      const approach = `${call.tool_name ?? call.item_type}\u0000${call.path}`;
      if (seen.has(approach)) repeats += 1;
      seen.add(approach);
    }
    if (failed > failedBefore) runs += 1;
  }
  if (failed === 0) return unavailable(spec, "No tool call failed in the window.");
  return ok(spec, repeats / failed, runs);
};
