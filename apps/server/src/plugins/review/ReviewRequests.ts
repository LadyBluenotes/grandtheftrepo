import {
  type CheckpointId,
  type OrchestrationV2Checkpoint,
  type ReviewRequest,
  ReviewVerdictError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { holdOf, holdText, SCAN_PENDING_MESSAGE, scanPending } from "./security/SecurityHold.ts";

export interface RequestRow {
  readonly id: number;
  readonly thread_id: ThreadId;
  readonly checkpoint_id: CheckpointId;
  readonly status: ReviewRequest["status"];
  readonly requested_by: string;
  readonly requested_at: string;
  readonly stale_at: string | null;
  readonly superseded_by: number | null;
}

const toRequest = (row: RequestRow): ReviewRequest => ({
  id: row.id,
  threadId: row.thread_id,
  checkpointId: row.checkpoint_id,
  status: row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  staleAt: row.stale_at,
  supersededBy: row.superseded_by,
});

const capturedOrder = (a: OrchestrationV2Checkpoint, b: OrchestrationV2Checkpoint) =>
  DateTime.toEpochMillis(a.capturedAt) - DateTime.toEpochMillis(b.capturedAt) ||
  a.ordinalWithinScope - b.ordinalWithinScope;

/**
 * The thread's latest checkpoint: its ready one captured last in its root scope. Null when the
 * thread is gone, undefined when it has none yet. Checkpoints a fork inherits can carry the source
 * thread's id, so ownership is read from the record.
 */
export const latestCheckpoint = Effect.fn("ReviewRequests.latestCheckpoint")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  threadId: ThreadId,
) {
  const shell = yield* threads.getThreadShell(threadId);
  if (shell === null || shell.deletedAt !== null) return null;
  const { checkpoints, checkpointScopes } = yield* threads.getThreadRecords(threadId, [
    "checkpoints",
    "checkpointScopes",
  ]);
  const roots = new Set(
    checkpointScopes.filter((scope) => scope.kind === "root_run").map((scope) => scope.id),
  );
  let latest: OrchestrationV2Checkpoint | undefined;
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.threadId === threadId &&
      checkpoint.status === "ready" &&
      roots.has(checkpoint.scopeId) &&
      (latest === undefined || capturedOrder(checkpoint, latest) > 0)
    ) {
      latest = checkpoint;
    }
  }
  return latest;
});

/** The thread's open and answered requests, newest first. */
export const standing = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<RequestRow & { readonly status: "open" | "answered" }>`SELECT * FROM review_request
    WHERE thread_id = ${threadId} AND status IN ('open', 'answered')
    ORDER BY requested_at DESC, id DESC`;

/**
 * Whether a verdict already names the checkpoint, which answers a request made there at once: the
 * reviewer gave it before anyone asked, and cannot give the same thread's verdict twice.
 */
export const hasVerdict = (sql: SqlClient.SqlClient, threadId: ThreadId, checkpointId: string) =>
  Effect.map(
    sql<{ readonly found: number }>`SELECT 1 AS found FROM review_verdicts
      WHERE reviewed_thread_id = ${threadId} AND checkpoint_id = ${checkpointId}
        AND invalidated_at IS NULL
      LIMIT 1`,
    (rows) => rows.length > 0,
  );

export const insert = (
  sql: SqlClient.SqlClient,
  request: {
    readonly threadId: ThreadId;
    readonly checkpointId: CheckpointId;
    readonly status: "open" | "answered";
    readonly requestedBy: string;
    readonly requestedAt: string;
  },
) =>
  Effect.map(
    sql<RequestRow>`INSERT INTO review_request
      (thread_id, checkpoint_id, status, requested_by, requested_at)
      VALUES (${request.threadId}, ${request.checkpointId}, ${request.status},
       ${request.requestedBy}, ${request.requestedAt})
      RETURNING *`,
    (rows) => rows[0]!,
  );

export class ReviewRequests extends Context.Service<
  ReviewRequests,
  {
    /**
     * Asks for a review of the thread's latest checkpoint. Asking again at the same checkpoint
     * answers with the request already standing there. A request at a checkpoint a verdict
     * already names is answered from the start. Refused while the thread has a security hold,
     * and in a `block` project until the security scan has handled the latest checkpoint.
     */
    readonly request: (input: {
      readonly threadId: ThreadId;
      readonly requestedBy: string;
    }) => Effect.Effect<ReviewRequest, ReviewVerdictError>;
    /** The requests made for one thread, newest first. */
    readonly list: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<ReviewRequest>, ReviewVerdictError>;
  }
>()("t3/plugins/review/ReviewRequests") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const io = (cause: SqlError.SqlError | Orchestrator.OrchestratorV2Error) =>
    Effect.logWarning("review: a request read or write failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new ReviewVerdictError({
            code: "io",
            message: "The review request could not be read or written.",
          }),
        ),
      ),
    );

  const request: ReviewRequests["Service"]["request"] = ({ threadId, requestedBy }) =>
    Effect.gen(function* () {
      const latest = yield* latestCheckpoint(threads, threadId).pipe(Effect.catch(io));
      if (latest === null) {
        return yield* new ReviewVerdictError({
          code: "not_found",
          message: `Thread ${threadId} was not found.`,
        });
      }
      if (latest === undefined) {
        return yield* new ReviewVerdictError({
          code: "invalid",
          message: "This thread has no checkpoint to review yet.",
        });
      }
      const held = yield* holdOf(sql, threadId);
      if (held > 0) {
        return yield* new ReviewVerdictError({
          code: "gated",
          message: `${holdText(held)} Call review_security_ack with a reason.`,
        });
      }
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.catch(io));
      if (shell !== null && (yield* scanPending(sql, shell.projectId, latest))) {
        return yield* new ReviewVerdictError({
          code: "scan_pending",
          message: SCAN_PENDING_MESSAGE,
        });
      }
      const requestedAt = DateTime.formatIso(yield* DateTime.now);
      const row = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = (yield* standing(sql, threadId)).find(
            (row) => row.checkpoint_id === latest.id,
          );
          if (current !== undefined) return current;
          const answered = yield* hasVerdict(sql, threadId, latest.id);
          return yield* insert(sql, {
            threadId,
            checkpointId: latest.id,
            status: answered ? "answered" : "open",
            requestedBy,
            requestedAt,
          });
        }),
      );
      return toRequest(row);
    }).pipe(Effect.catchTags({ SqlError: io }));

  const list: ReviewRequests["Service"]["list"] = ({ threadId }) =>
    sql<RequestRow>`SELECT * FROM review_request WHERE thread_id = ${threadId}
      ORDER BY requested_at DESC, id DESC`.pipe(
      Effect.map((rows) => rows.map(toRequest)),
      Effect.catchTags({ SqlError: io }),
    );

  return ReviewRequests.of({ request, list });
});

export const layer = Layer.effect(ReviewRequests, make);
