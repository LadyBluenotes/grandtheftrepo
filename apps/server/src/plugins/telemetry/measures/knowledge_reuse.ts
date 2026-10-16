import { KNOWLEDGE_DIRECTORY } from "@t3tools/contracts";

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
  measure: "knowledge_reuse",
  unit: "ratio",
  direction: "higher_is_better",
  provenance: TOOL_CALL_PROVENANCE,
} as const satisfies Spec;

const IN_KNOWLEDGE_DIRECTORY = `/${KNOWLEDGE_DIRECTORY}/`;

/**
 * Whether a path is under a knowledge directory, absolute or relative to the project, with either
 * kind of separator. The directory must be a whole path segment, not the end of one.
 */
const isKnowledgePath = (path: string) =>
  `/${path.replaceAll("\\", "/")}`.includes(IN_KNOWLEDGE_DIRECTORY);

/**
 * Of the runs that started in the window and edited a file, the share that read a path under the
 * knowledge directory before the first edit, by the calls' order. A read after the first edit does
 * not count, and a run with no edit is not in the sample. It says whether the index block in the
 * instruction files is doing its job, so a project with no accepted page has no answer. Reads of
 * the instruction files themselves leave no tool call, and a subagent's calls belong to no run.
 */
export const knowledgeReuse: Measure = (input) => {
  if (input.knowledgePages === undefined) {
    return unavailable(
      spec,
      "Knowledge pages come from the knowledge plugin, which is not running.",
    );
  }
  if (input.knowledgePages === 0) {
    return unavailable(spec, "The project has no knowledge page yet.");
  }
  const byRun = callsByRun(input.toolCalls);
  let editing = 0;
  let reusing = 0;
  for (const run of windowRuns(input)) {
    const calls = byRun.get(run.run_id) ?? [];
    const firstEdit = calls.findIndex((call) => editPath(call) !== null);
    if (firstEdit === -1) continue;
    editing += 1;
    const reads = calls.slice(0, firstEdit).map(readPath);
    if (reads.some((path) => path !== null && isKnowledgePath(path))) reusing += 1;
  }
  if (editing === 0) return unavailable(spec, "No run in the window edited a file.");
  return ok(spec, reusing / editing, editing);
};
