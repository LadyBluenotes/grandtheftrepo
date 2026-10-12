import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";

const PLUGIN_ID = "kanban";
const FLAG_KIND = "two_writers";

/** Runs in these states are active; a `waiting` run still holds its thread's working copy. */
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** What the person should do about a flag: a label and the screen it leads to (shape from #30). */
const encodeResumeAction = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      label: Schema.String,
      target: Schema.Literals(["thread", "board", "settings"]),
    }),
  ),
);
const RESUME_ACTION = encodeResumeAction({ label: "Open thread", target: "thread" });

/**
 * An active run on a thread that is not in plan mode, in a worktree or in the main checkout. A
 * provider's own subagent is part of its parent's run, not a second agent.
 */
const isWriting = (thread: OrchestrationV2ThreadShell) =>
  thread.interactionMode !== "plan" &&
  !isProviderNativeSubagentThread(thread) &&
  ACTIVE_RUN_STATUSES.has(thread.activityRunStatus ?? thread.status);

/** When the writer's current work began; a wake keeps the start of the work it continues. */
const startedAt = (thread: OrchestrationV2ThreadShell) =>
  DateTime.toEpochMillis(
    thread.activityRunStartedAt ?? thread.latestRunRequestedAt ?? thread.createdAt,
  );

const oldestFirst = (left: OrchestrationV2ThreadShell, right: OrchestrationV2ThreadShell) =>
  startedAt(left) - startedAt(right) || left.id.localeCompare(right.id);

const flagText = (writers: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  `${writers.length} threads are writing to this project at once: ${writers
    .map((thread) => `"${thread.title.trim() === "" ? thread.id : thread.title.trim()}"`)
    .join(", ")}.`;

interface OpenFlag {
  readonly id: number;
  readonly thread_id: string;
  readonly text: string;
}

/**
 * Builds the writers sweep. Per project it counts the writing threads; two or more keep one
 * open `two_writers` flag on the oldest writer, with text naming all of them. The text follows
 * the set while the flag is open, and the flag is cleared once at most one writer is left. The
 * sweep only observes: it stops no run and holds no queue, and on state it has already
 * reconciled it writes nothing. Under a dry run it writes nothing at all.
 */
export const sweep = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;

  return Effect.fn("WriterSweep.run")(function* (input: { readonly dryRun: boolean }) {
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });

    const writersByProject = new Map<ProjectId, Array<OrchestrationV2ThreadShell>>();
    for (const thread of snapshot.threads) {
      if (!isWriting(thread)) continue;
      const writers = writersByProject.get(thread.projectId) ?? [];
      writers.push(thread);
      writersByProject.set(thread.projectId, writers);
    }
    // The flag's thread (the oldest writer) to the text it should carry.
    const wanted = new Map<string, string>();
    for (const writers of writersByProject.values()) {
      if (writers.length < 2) continue;
      writers.sort(oldestFirst);
      wanted.set(writers[0]!.id, flagText(writers));
    }

    const open = yield* sql<OpenFlag>`
      SELECT id, thread_id, text FROM attention
      WHERE plugin_id = ${PLUGIN_ID} AND kind = ${FLAG_KIND} AND cleared_at IS NULL
    `;
    const gone = open.filter((flag) => !wanted.has(flag.thread_id));
    const reworded = open.filter(
      (flag) => wanted.has(flag.thread_id) && wanted.get(flag.thread_id) !== flag.text,
    );
    const raised = [...wanted].filter(
      ([threadId]) => !open.some((flag) => flag.thread_id === threadId),
    );
    const changes = gone.length + reworded.length + raised.length;

    if (!input.dryRun && changes > 0) {
      const clearedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const flag of gone) {
            yield* sql`UPDATE attention SET cleared_at = ${clearedAt} WHERE id = ${flag.id}`;
          }
          for (const flag of reworded) {
            yield* sql`
              UPDATE attention SET text = ${wanted.get(flag.thread_id) ?? flag.text}
              WHERE id = ${flag.id}
            `;
          }
          for (const [threadId, text] of raised) {
            yield* sql`
              INSERT INTO attention (plugin_id, thread_id, kind, text, resume_action)
              VALUES (${PLUGIN_ID}, ${threadId}, ${FLAG_KIND}, ${text}, ${RESUME_ACTION})
            `;
          }
        }),
      );
    }

    return {
      examined: snapshot.threads.length,
      acted: input.dryRun ? 0 : changes,
      flags: wanted.size,
    };
  });
});

/** Registers the sweep with the supervisor; called from the plugin's layer. */
export const register = Effect.gen(function* () {
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  const run = yield* sweep;
  yield* supervisor.register({ plugin: PLUGIN_ID, name: "writers", run });
});
