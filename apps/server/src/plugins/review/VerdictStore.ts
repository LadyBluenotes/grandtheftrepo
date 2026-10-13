import {
  PONYTAIL_RUNG_IDS,
  PonytailRungId,
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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import { securityGate } from "./security/SecurityHold.ts";

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

const isRungId = Schema.is(PonytailRungId);

/**
 * What a summary names after `rung:`: the text up to the first space, without the `:`, `,`, `;` or
 * `.` a reviewer may put after it. Undefined when the summary does not start with `rung:`.
 */
const rungNamed = (summary: string) => /^rung:(\S*)/.exec(summary)?.[1]?.replace(/[:;,.]+$/, "");

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
     * earlier call that stopped before its row, unless it declares that correction's mode. The row
     * answers the thread's request open at the same checkpoint, and answering one that superseded a
     * stale request clears the thread's `stale_review` flag.
     */
    readonly record: (
      reviewerThreadId: ThreadId,
      input: ReviewVerdictInput,
    ) => Effect.Effect<ReviewVerdictResult, ReviewVerdictError, CorrectionStore.CorrectionStore>;
    /** The verdicts given on one thread's work, oldest first. */
    readonly list: (
      input: ReviewVerdictsInput,
    ) => Effect.Effect<ReadonlyArray<ReviewVerdict>, ReviewVerdictError>;
    /**
     * A project's verdicts given in `[from, to)`, oldest first, ties by id. One query for every
     * thread of a window, which `list` would take one call per thread to answer. The instants are
     * the normalized ISO strings the rows hold, so they compare as text. Internal: it has no
     * gateway method.
     */
    readonly listWindow: (input: {
      readonly projectId: ProjectId;
      readonly from: string;
      readonly to: string;
    }) => Effect.Effect<ReadonlyArray<ReviewVerdict>, ReviewVerdictError>;
  }
>()("t3/plugins/review/VerdictStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const attention = yield* Attention.Attention;
  // The checks, the correction and the verdict row span two databases, so callers for the same
  // checkpoint are serialized here rather than by a transaction.
  const recordLock = yield* Semaphore.make(1);

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

  /** The reviewed thread's project and the checkpoint, when it is a ready one of that thread. */
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
    const checkpoint = checkpoints.find(
      (candidate) =>
        candidate.id === checkpointId &&
        candidate.threadId === threadId &&
        candidate.status === "ready",
    );
    if (checkpoint === undefined) {
      return yield* invalid(
        `Checkpoint ${checkpointId} is not a ready checkpoint of thread ${threadId}`,
      );
    }
    return { projectId: shell.projectId, checkpoint };
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

      // Only new writes are held to the ladder's shape: a verdict stored before it existed still
      // answers its own retry. The reviewer judges the rung; code checks only that it is named.
      const rung = failureMode === "convention" ? rungNamed(input.summary) : undefined;
      if (rung !== undefined && !isRungId(rung)) {
        return yield* invalid(`Unknown rung "${rung}". Rungs: ${PONYTAIL_RUNG_IDS.join(", ")}.`);
      }

      const { projectId, checkpoint } = yield* readCheckpoint(input.threadId, input.checkpointId);
      // A thread held by the security scan takes no verdict until the hold is acknowledged, as it
      // takes no review request, since an approval could otherwise answer one opened earlier.
      yield* securityGate(sql, { threadId: input.threadId, projectId, checkpoint });
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
      const answeredSuperseding = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A concurrent identical call may have inserted first; its row is the one settled below.
          yield* sql`INSERT INTO review_verdicts
            (id, project_id, reviewed_thread_id, reviewer_thread_id, checkpoint_id, outcome,
             failure_mode, summary, correction_id, created_at)
            VALUES (${id}, ${projectId}, ${input.threadId}, ${reviewerThreadId},
             ${input.checkpointId}, ${input.outcome}, ${failureMode}, ${input.summary},
             ${correction?.id ?? null}, ${at})
            ON CONFLICT (id) DO NOTHING`;
          // The verdict answers the request open at its checkpoint, and no other.
          const answered = yield* sql<{ readonly id: number }>`UPDATE review_request
            SET status = 'answered'
            WHERE thread_id = ${input.threadId} AND checkpoint_id = ${input.checkpointId}
              AND status = 'open'
            RETURNING id`;
          if (answered.length === 0) return false;
          const superseded = yield* sql`SELECT 1 FROM review_request
            WHERE thread_id = ${input.threadId}
              AND superseded_by IN ${sql.in(answered.map((row) => row.id))}
            LIMIT 1`;
          return superseded.length > 0;
        }),
      );
      if (answeredSuperseding) {
        // The flag lives in the host's file. Should this write fail, the invalidation sweep
        // clears it on its next tick, so the verdict still stands.
        yield* attention
          .clear({ pluginId: "review", threadId: input.threadId, kind: "stale_review" })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("review: could not clear a stale review flag", { cause }),
            ),
          );
      }
      return yield* settle((yield* find(id))!);
    }).pipe(recordLock.withPermits(1), Effect.catchTags({ SqlError: io }));

  const list: VerdictStore["Service"]["list"] = ({ threadId }) =>
    sql<Row>`SELECT * FROM review_verdicts WHERE reviewed_thread_id = ${threadId}
      ORDER BY created_at, id`.pipe(
      Effect.map((rows) => rows.map(toVerdict)),
      Effect.catchTags({ SqlError: io }),
    );

  const listWindow: VerdictStore["Service"]["listWindow"] = ({ projectId, from, to }) =>
    sql<Row>`SELECT * FROM review_verdicts
      WHERE project_id = ${projectId} AND created_at >= ${from} AND created_at < ${to}
      ORDER BY created_at, id`.pipe(
      Effect.map((rows) => rows.map(toVerdict)),
      Effect.catchTags({ SqlError: io }),
    );

  return VerdictStore.of({ record, list, listWindow });
});

export const layer = Layer.effect(VerdictStore, make);
