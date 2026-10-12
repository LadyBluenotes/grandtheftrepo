import {
  type CheckpointId,
  type LearningDeclaredMode,
  type LearningError,
  type ProjectId,
  type ReviewOutcome,
  type ReviewVerdict,
  ReviewVerdictError,
  type ReviewVerdictInput,
  type ReviewVerdictResult,
  type ReviewVerdictsInput,
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
import * as CorrectionStore from "../learning/CorrectionStore.ts";

interface Row {
  readonly id: string;
  readonly project_id: ProjectId;
  readonly reviewed_thread_id: ThreadId;
  readonly reviewer_thread_id: ThreadId;
  readonly checkpoint_id: CheckpointId;
  readonly outcome: ReviewOutcome;
  readonly failure_mode: LearningDeclaredMode | null;
  readonly summary: string;
  readonly correction_id: number | null;
  readonly created_at: string;
  readonly invalidated_at: string | null;
}

const toVerdict = (row: Row): ReviewVerdict => ({
  id: row.id,
  projectId: row.project_id,
  reviewedThreadId: row.reviewed_thread_id,
  reviewerThreadId: row.reviewer_thread_id,
  checkpointId: row.checkpoint_id,
  outcome: row.outcome,
  failureMode: row.failure_mode,
  summary: row.summary,
  correctionId: row.correction_id,
  createdAt: row.created_at,
  invalidatedAt: row.invalidated_at,
});

/**
 * One verdict per reviewer thread and checkpoint, so the pair is the id. Deriving it, rather than
 * drawing a random one, is what lets a retry after a crash between the correction and the row land
 * on the same correction source key. Each part is encoded so no two pairs share an id.
 */
const verdictIdOf = (reviewerThreadId: ThreadId, checkpointId: CheckpointId) =>
  `${encodeURIComponent(reviewerThreadId)}:${encodeURIComponent(checkpointId)}`;

const invalid = (message: string) => new ReviewVerdictError({ code: "invalid", message });

const alreadyReviewed = () =>
  new ReviewVerdictError({
    code: "conflict",
    message: "This thread already reviewed this checkpoint",
  });

export class VerdictStore extends Context.Service<
  VerdictStore,
  {
    /**
     * Stores `reviewerThreadId`'s verdict on a checkpoint of `input.threadId`. A `changes_requested`
     * verdict first records its correction (source key `verdict:<id>`, so a repeat finds the same
     * one), then the row that points at it; the correction lives in the learning plugin's database,
     * so the two cannot share a transaction. The same payload again answers with the stored result
     * and adds nothing; a different one is refused. So is a call that finds a correction left by an
     * earlier call that stopped before its row, unless it declares that correction's mode.
     */
    readonly record: (
      reviewerThreadId: ThreadId,
      input: ReviewVerdictInput,
    ) => Effect.Effect<ReviewVerdictResult, ReviewVerdictError, CorrectionStore.CorrectionStore>;
    /** The verdicts given on one thread's work, oldest first. */
    readonly list: (
      input: ReviewVerdictsInput,
    ) => Effect.Effect<ReadonlyArray<ReviewVerdict>, ReviewVerdictError>;
  }
>()("t3/plugins/review/VerdictStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const io = (cause: SqlError.SqlError | Orchestrator.OrchestratorV2Error) =>
    Effect.logWarning("review: a read or write failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new ReviewVerdictError({
            code: "io",
            message: "The verdict could not be read or written.",
          }),
        ),
      ),
    );

  const fromLearning = (error: LearningError) =>
    new ReviewVerdictError({ code: error.code, message: error.message });

  const find = (id: string) =>
    Effect.map(sql<Row>`SELECT * FROM review_verdicts WHERE id = ${id}`, (rows) => rows[0]);

  /** The reviewed thread's project, and the checkpoint if it is a ready one of that thread. */
  const readCheckpoint = Effect.fn("VerdictStore.readCheckpoint")(function* (
    threadId: ThreadId,
    checkpointId: CheckpointId,
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.catch(io));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new ReviewVerdictError({
        code: "not_found",
        message: `Thread ${threadId} was not found.`,
      });
    }
    const { checkpoints } = yield* threads
      .getThreadRecords(threadId, ["checkpoints"])
      .pipe(Effect.catch(io));
    // Checkpoints a fork inherits can carry the source thread's id, so ownership is checked on the record.
    const ready = checkpoints.some(
      (checkpoint) =>
        checkpoint.id === checkpointId &&
        checkpoint.threadId === threadId &&
        checkpoint.status === "ready",
    );
    if (!ready) {
      return yield* invalid(
        `Checkpoint ${checkpointId} is not a ready checkpoint of thread ${threadId}`,
      );
    }
    return shell.projectId;
  });

  const record: VerdictStore["Service"]["record"] = (reviewerThreadId, input) =>
    Effect.gen(function* () {
      const failureMode = input.failureMode ?? null;
      if (input.outcome === "changes_requested" && failureMode === null) {
        return yield* invalid("changes_requested needs a failureMode");
      }
      if (input.outcome === "approve" && failureMode !== null) {
        return yield* invalid("approve cannot carry a failureMode");
      }
      if (reviewerThreadId === input.threadId) {
        return yield* invalid("A thread cannot review its own work");
      }

      const id = verdictIdOf(reviewerThreadId, input.checkpointId);
      /** The stored verdict is the answer to the same payload, and a conflict for any other. */
      const settle = (row: Row) =>
        row.reviewed_thread_id === input.threadId &&
        row.outcome === input.outcome &&
        row.failure_mode === failureMode &&
        row.summary === input.summary
          ? Effect.succeed({ verdictId: row.id, correctionId: row.correction_id })
          : Effect.fail(alreadyReviewed());

      const existing = yield* find(id);
      if (existing !== undefined) return yield* settle(existing);

      const projectId = yield* readCheckpoint(input.threadId, input.checkpointId);
      const corrections = yield* CorrectionStore.CorrectionStore;
      const sourceKey = `verdict:${id}`;
      // A correction with no row is an earlier call's that stopped between the two writes. Only the
      // same verdict may finish it; `record` below then answers with that stored correction.
      const leftover = yield* corrections
        .findBySourceKey("review_verdict", sourceKey)
        .pipe(Effect.mapError(fromLearning));
      if (
        leftover !== undefined &&
        (failureMode === null || leftover.declaredMode !== failureMode)
      ) {
        return yield* alreadyReviewed();
      }
      const correction =
        failureMode === null
          ? null
          : yield* corrections
              .record({
                threadId: input.threadId,
                failureKind: "review_verdict",
                declaredMode: failureMode,
                description: input.summary,
                sourceEventIds: [],
                sourceKey,
              })
              .pipe(Effect.mapError(fromLearning));
      const at = DateTime.formatIso(yield* DateTime.now);
      // A concurrent identical call may have inserted first; its row is the one settled below.
      yield* sql`INSERT INTO review_verdicts
        (id, project_id, reviewed_thread_id, reviewer_thread_id, checkpoint_id, outcome,
         failure_mode, summary, correction_id, created_at)
        VALUES (${id}, ${projectId}, ${input.threadId}, ${reviewerThreadId}, ${input.checkpointId},
         ${input.outcome}, ${failureMode}, ${input.summary}, ${correction?.id ?? null}, ${at})
        ON CONFLICT (id) DO NOTHING`;
      return yield* settle((yield* find(id))!);
    }).pipe(Effect.catchTags({ SqlError: io }));

  const list: VerdictStore["Service"]["list"] = ({ threadId }) =>
    sql<Row>`SELECT * FROM review_verdicts WHERE reviewed_thread_id = ${threadId}
      ORDER BY created_at, id`.pipe(
      Effect.map((rows) => rows.map(toVerdict)),
      Effect.catchTags({ SqlError: io }),
    );

  return VerdictStore.of({ record, list });
});

export const layer = Layer.effect(VerdictStore, make);
