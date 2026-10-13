import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { hasVerdict, insert, latestCheckpoint, standing } from "./ReviewRequests.ts";

const PLUGIN_ID = "review";
const FLAG_KIND = "stale_review";
const RESUME_ACTION = { label: "Open thread", target: "thread" } as const;
/** Threads one tick examines; the next tick continues after the last, so none waits forever. */
const BATCH_SIZE = 100;

const flagText = (checkpointId: string) => `Review of checkpoint ${checkpointId} is out of date`;

/**
 * Builds the invalidation sweep. A thread's open and answered requests describe its latest
 * checkpoint; once the thread has moved to another, each of them is marked stale, for good, and
 * superseded by the request standing at the latest checkpoint, opened here when there is none.
 * The thread's verdicts on the superseded checkpoints are marked invalidated with them, all in one
 * transaction. A thread whose superseding request waits for a verdict keeps one `stale_review`
 * flag naming the newest stale checkpoint; the flag clears once that request is answered. Flags
 * are reconciled against the rows every tick, so a write lost between the two databases is
 * repaired by the next. On state it already reconciled it writes nothing. A dry run counts what
 * it would do and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const attention = yield* Attention.Attention;
  // The thread id the next batch starts after; empty starts from the first.
  const cursor = yield* Ref.make("");

  const run = Effect.fn("ReviewInvalidationSweep.run")(function* (input: {
    readonly dryRun: boolean;
  }) {
    // Each thread whose superseding request still waits, to the flag text it should carry.
    const wanted = new Map<string, string>();
    const waiting = yield* sql<{ readonly thread_id: string; readonly checkpoint_id: string }>`
      SELECT stale.thread_id, stale.checkpoint_id
      FROM review_request AS superseding
      JOIN review_request AS stale
        ON stale.thread_id = superseding.thread_id AND stale.superseded_by = superseding.id
      WHERE superseding.status = 'open'
      ORDER BY stale.requested_at, stale.id`;
    for (const row of waiting) wanted.set(row.thread_id, flagText(row.checkpoint_id));

    const after = yield* Ref.get(cursor);
    const batch = yield* sql<{ readonly thread_id: ThreadId }>`
      SELECT DISTINCT thread_id FROM review_request
      WHERE status IN ('open', 'answered') AND thread_id > ${after}
      ORDER BY thread_id LIMIT ${BATCH_SIZE}`;
    yield* Ref.set(cursor, batch.length < BATCH_SIZE ? "" : batch[batch.length - 1]!.thread_id);

    const at = DateTime.formatIso(yield* DateTime.now);
    let superseded = 0;
    for (const { thread_id: threadId } of batch) {
      const latest = yield* latestCheckpoint(threads, threadId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("review: could not read a thread's checkpoints", {
            threadId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (latest === null || latest === undefined) continue;
      const outcome = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* standing(sql, threadId);
          const behind = rows.filter((row) => row.checkpoint_id !== latest.id);
          if (behind.length === 0) return undefined;
          const current = rows.find((row) => row.checkpoint_id === latest.id);
          const status =
            current?.status ??
            ((yield* hasVerdict(sql, threadId, latest.id)) ? "answered" : "open");
          if (!input.dryRun) {
            const next =
              current ??
              (yield* insert(sql, {
                threadId,
                checkpointId: latest.id,
                status,
                requestedBy: "supervisor",
                requestedAt: at,
              }));
            yield* sql`UPDATE review_request
              SET status = 'stale', stale_at = ${at}, superseded_by = ${next.id}
              WHERE id IN ${sql.in(behind.map((row) => row.id))}`;
            yield* sql`UPDATE review_verdicts SET invalidated_at = ${at}
              WHERE reviewed_thread_id = ${threadId}
                AND checkpoint_id IN ${sql.in(behind.map((row) => row.checkpoint_id))}
                AND invalidated_at IS NULL`;
          }
          // `standing` is newest first, so the flag names the checkpoint reviewed last.
          return { count: behind.length, status, checkpointId: behind[0]!.checkpoint_id };
        }),
      );
      if (outcome === undefined) continue;
      superseded += outcome.count;
      if (outcome.status === "open") wanted.set(threadId, flagText(outcome.checkpointId));
      else wanted.delete(threadId);
    }

    const open = yield* attention.listOpen({ pluginId: PLUGIN_ID, kind: FLAG_KIND });
    const gone = open.filter((flag) => !wanted.has(flag.threadId));
    const changed = [...wanted].filter(
      ([threadId, text]) => open.find((flag) => flag.threadId === threadId)?.text !== text,
    );
    if (!input.dryRun) {
      for (const { threadId } of gone) {
        yield* attention.clear({ pluginId: PLUGIN_ID, threadId, kind: FLAG_KIND });
      }
      for (const [threadId, text] of changed) {
        yield* attention.raise({
          pluginId: PLUGIN_ID,
          threadId,
          kind: FLAG_KIND,
          text,
          resumeAction: RESUME_ACTION,
        });
      }
    }

    return {
      examined: batch.length,
      acted: superseded + gone.length + changed.length,
      flags: wanted.size,
    };
  });

  return { plugin: PLUGIN_ID, name: "invalidation", run };
});

/** Registers the sweep with the supervisor; called from the plugin's layer. */
export const register = Effect.gen(function* () {
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  yield* supervisor.register(yield* sweep);
});
