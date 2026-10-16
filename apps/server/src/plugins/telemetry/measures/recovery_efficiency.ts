import { type Measure, ok, type RunRow, type Spec, unavailable, windowRuns } from "./input.ts";

const spec = {
  measure: "recovery_efficiency",
  unit: "ratio",
  direction: "higher_is_better",
  provenance: ["run.id", "run.threadId", "run.ordinal", "run.status", "run.startedAt"],
} as const satisfies Spec;

/** Each run's successor in its thread, by run id; a thread's last run has none. */
const successors = (runs: ReadonlyArray<RunRow>) => {
  const byThread = new Map<string, RunRow[]>();
  for (const run of runs) {
    const group = byThread.get(run.thread_id);
    if (group === undefined) byThread.set(run.thread_id, [run]);
    else group.push(run);
  }
  const next = new Map<string, RunRow>();
  for (const group of byThread.values()) {
    group.sort((a, b) => a.ordinal - b.ordinal);
    for (const [index, run] of group.entries()) {
      const following = group[index + 1];
      if (following !== undefined) next.set(run.run_id, following);
    }
  }
  return next;
};

/**
 * Failed runs that started in the window whose thread's next run completed, over those failed
 * runs. The next run in the thread is the proxy for a retry because the log keeps no link from a
 * new run to the failed one it retries (`restartContinuationOfRunId` links only to a run a restart
 * cancelled). The failed run is the sample, so its next run counts wherever it started, after `to`
 * included. shortcut: a run retried in place (`prepared-run.retry`) keeps only its last status, so
 * a failure it recovered from is not seen; latch the failure on the row if that retry matters.
 */
export const recoveryEfficiency: Measure = (input) => {
  const failed = windowRuns(input).filter((run) => run.status === "failed");
  if (failed.length === 0) return unavailable(spec, "No run in the window failed.");
  const next = successors(input.runs);
  const recovered = failed.filter((run) => next.get(run.run_id)?.status === "completed").length;
  return ok(spec, recovered / failed.length, failed.length);
};
