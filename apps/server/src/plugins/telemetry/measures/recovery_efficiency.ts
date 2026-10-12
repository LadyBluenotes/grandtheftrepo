import { type Measure, ok, type Spec, unavailable, windowRuns } from "./input.ts";

const spec = {
  measure: "recovery_efficiency",
  unit: "ratio",
  direction: "higher_is_better",
  provenance: ["run.id", "run.threadId", "run.ordinal", "run.status", "run.startedAt"],
} as const satisfies Spec;

/**
 * Failed runs that started in the window whose thread's next run completed, over those failed
 * runs. shortcut: a run retried in place (`prepared-run.retry`) keeps only its last status, so a
 * failure it recovered from is not seen; latch the failure on the row if that retry matters.
 */
export const recoveryEfficiency: Measure = (input) => {
  const failed = windowRuns(input).filter((run) => run.status === "failed");
  if (failed.length === 0) return unavailable(spec, "No run in the window failed.");
  const recovered = failed.filter((run) => {
    const [next] = input.runs
      .filter((later) => later.thread_id === run.thread_id && later.ordinal > run.ordinal)
      .toSorted((a, b) => a.ordinal - b.ordinal);
    return next?.status === "completed";
  }).length;
  return ok(spec, recovered / failed.length, failed.length);
};
