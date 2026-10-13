import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { hasVerdict, insert, latestCheckpoint, standing } from "./ReviewRequests.ts";
import { holdOf, scanPending } from "./security/SecurityHold.ts";

const PLUGIN_ID = "review";
const FLAG_KIND = "stale_review";
const RESUME_ACTION = { label: "Open thread", target: "thread" } as const;
/** Threads one tick examines; the next tick continues after the last, so none waits forever. */
const BATCH_SIZE = 100;

const flagText = (checkpointId: string) => `Review of checkpoint ${checkpointId} is out of date`;

/**
 * Builds the invalidation sweep. A thread's open and answered requests describe its latest
 * checkpoint; once the thread has moved to another, each of them is marked stale, for good, and
 * superseded by the request standing at the latest checkpoint, opened here when there is none. A
 * thread under a security hold is left as it is until the hold is acknowledged, and in a `block`
 * project until the security scan has handled its latest checkpoint, since `ReviewRequests.request`
 * would refuse the request this opens; `ReviewGate` already treats its request as out of date
 * meanwhile.
 * The thread's verdicts on the superseded checkpoints are marked invalidated with them, all in one
 * transaction. A thread whose superseding request waits for a verdict keeps one `stale_review`
 * flag naming the newest stale checkpoint; the flag clears once that request is answered. Each
 * tick reconciles the flags of its batch and of every thread with a flag open against the rows,
 * so a write lost between the two databases is repaired by the time the thread's batch comes
 * round. On state it already reconciled it writes nothing. A dry run counts what it would do and
 * writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const attention = yield* Attention.Attention;
  // The thread id the next batch starts after; empty starts from the first.
  const cursor = yield* Ref.make("");

  /**
   * The flag text a thread's rows call for: the newest stale request one of its open requests
   * superseded, or undefined when no superseding request waits.
   */
  const flagFor = (threadId: string) =>
    Effect.map(
      sql<{ readonly checkpoint_id: string }>`SELECT checkpoint_id FROM review_request
        WHERE superseded_by IN (
          SELECT id FROM review_request WHERE thread_id = ${threadId} AND status = 'open'
        )
        ORDER BY requested_at DESC, id DESC LIMIT 1`,
      ([row]) => (row === undefined ? undefined : flagText(row.checkpoint_id)),
    );

  const run = Effect.fn("ReviewInvalidationSweep.run")(function* (input: {
    readonly dryRun: boolean;
  }) {
    const after = yield* Ref.get(cursor);
    const batch = yield* sql<{ readonly thread_id: ThreadId }>`
      SELECT DISTINCT thread_id FROM review_request
      WHERE status IN ('open', 'answered') AND thread_id > ${after}
      ORDER BY thread_id LIMIT ${BATCH_SIZE}`;
    yield* Ref.set(cursor, batch.length < BATCH_SIZE ? "" : batch[batch.length - 1]!.thread_id);

    const at = DateTime.formatIso(yield* DateTime.now);
    let superseded = 0;
    // The flag each changed thread would carry, for a dry run, which writes no row to read it from.
    const planned = new Map<string, string | undefined>();
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
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("review: could not read a thread", { threadId, cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      // The scan writes its row and its findings in one transaction, so asking whether it is done
      // before asking for a hold means a scan that commits between the two is seen by the second.
      if (shell === null || (yield* scanPending(sql, shell.projectId, latest))) continue;
      if ((yield* holdOf(sql, threadId)) > 0) continue;
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
      planned.set(threadId, outcome.status === "open" ? flagText(outcome.checkpointId) : undefined);
    }

    // Flags are reconciled for this batch's threads and every thread with an open flag, so a tick
    // reads the flags still standing, never the request history.
    const open = new Map(
      (yield* attention.listOpen({ pluginId: PLUGIN_ID, kind: FLAG_KIND })).map((flag) => [
        flag.threadId,
        flag.text,
      ]),
    );
    let flags = 0;
    let changes = 0;
    for (const threadId of new Set<string>([
      ...batch.map((row) => row.thread_id),
      ...open.keys(),
    ])) {
      const text =
        input.dryRun && planned.has(threadId) ? planned.get(threadId) : yield* flagFor(threadId);
      if (text !== undefined) flags += 1;
      if (text === open.get(threadId)) continue;
      changes += 1;
      if (input.dryRun) continue;
      const key = { pluginId: PLUGIN_ID, threadId, kind: FLAG_KIND } as const;
      yield* text === undefined
        ? attention.clear(key)
        : attention.raise({ ...key, text, resumeAction: RESUME_ACTION });
    }

    return { examined: batch.length, acted: superseded + changes, flags };
  });

  return { plugin: PLUGIN_ID, name: "invalidation", run };
});

/** Registers the sweep with the supervisor; called from the plugin's layer. */
export const register = Effect.gen(function* () {
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  yield* supervisor.register(yield* sweep);
});
