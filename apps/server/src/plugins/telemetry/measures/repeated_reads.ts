import {
  callsByRun,
  editPath,
  type Measure,
  ok,
  readPath,
  type Spec,
  TOOL_CALL_PROVENANCE,
  unavailable,
  windowRuns,
} from "./input.ts";

const spec = {
  measure: "repeated_reads",
  unit: "ratio",
  direction: "lower_is_better",
  provenance: TOOL_CALL_PROVENANCE,
} as const satisfies Spec;

/**
 * Within one run, reads of a path already read with no edit of it in between, over all reads in
 * runs that started in the window. An edit of a path resets its count.
 */
export const repeatedReads: Measure = (input) => {
  const byRun = callsByRun(input.toolCalls);
  let reads = 0;
  let repeats = 0;
  let runs = 0;
  for (const run of windowRuns(input)) {
    const seen = new Set<string>();
    const readsBefore = reads;
    for (const call of byRun.get(run.run_id) ?? []) {
      const edited = editPath(call);
      if (edited !== null) seen.delete(edited);
      const read = readPath(call);
      if (read === null) continue;
      reads += 1;
      if (seen.has(read)) repeats += 1;
      seen.add(read);
    }
    if (reads > readsBefore) runs += 1;
  }
  if (reads === 0) return unavailable(spec, "No run in the window read a file.");
  return ok(spec, repeats / reads, runs);
};
