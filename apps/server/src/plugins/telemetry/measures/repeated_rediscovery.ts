import {
  callsByRun,
  editPath,
  inWindow,
  type Measure,
  ok,
  readPath,
  type RunRow,
  type Spec,
  TOOL_CALL_PROVENANCE,
  unavailable,
} from "./input.ts";

const spec = {
  measure: "repeated_rediscovery",
  unit: "ratio",
  direction: "lower_is_better",
  provenance: [...TOOL_CALL_PROVENANCE, "run.threadId", "run.ordinal"],
} as const satisfies Spec;

/**
 * Paths a later run of a thread read that an earlier run of the same thread had already read,
 * over the paths later runs read, for later runs that started in the window. Each path counts
 * once per run. An edit of a path since the earlier read means the file changed, so reading it
 * again is not a rediscovery.
 */
export const repeatedRediscovery: Measure = (input) => {
  const byRun = callsByRun(input.toolCalls);
  const byThread = new Map<string, RunRow[]>();
  for (const run of input.runs) {
    const list = byThread.get(run.thread_id);
    if (list === undefined) byThread.set(run.thread_id, [run]);
    else list.push(run);
  }
  let paths = 0;
  let rediscovered = 0;
  let runs = 0;
  for (const threadRuns of byThread.values()) {
    // Paths earlier runs read and nothing has edited since.
    const known = new Set<string>();
    for (const [index, run] of threadRuns.toSorted((a, b) => a.ordinal - b.ordinal).entries()) {
      const counts = index > 0 && inWindow(input, run.started_at);
      const readHere = new Set<string>();
      const lastRead = new Set<string>();
      for (const call of byRun.get(run.run_id) ?? []) {
        const edited = editPath(call);
        if (edited !== null) {
          known.delete(edited);
          lastRead.delete(edited);
        }
        const read = readPath(call);
        if (read === null) continue;
        if (counts && !readHere.has(read)) {
          paths += 1;
          if (known.has(read)) rediscovered += 1;
        }
        readHere.add(read);
        lastRead.add(read);
      }
      if (counts && readHere.size > 0) runs += 1;
      for (const path of lastRead) known.add(path);
    }
  }
  if (paths === 0) return unavailable(spec, "No later run of a thread in the window read a file.");
  return ok(spec, rediscovered / paths, runs);
};
