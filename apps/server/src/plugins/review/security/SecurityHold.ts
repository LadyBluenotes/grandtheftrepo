import {
  type CheckpointId,
  type OrchestrationV2Checkpoint,
  type ProjectId,
  ReviewVerdictError,
  type SecurityFinding,
  type SecurityMode,
  type SecurityModeSetting,
  type SecurityPatternId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as Attention from "../../Attention.ts";

export interface FindingRow {
  readonly id: number;
  readonly thread_id: ThreadId;
  readonly checkpoint_id: CheckpointId;
  readonly pattern_id: SecurityPatternId;
  readonly file: string;
  readonly line: number;
  readonly blocking: number;
  readonly correction_id: number | null;
  readonly created_at: string;
  readonly acknowledged_at: string | null;
  readonly ack_reason: string | null;
}

const toFinding = (row: FindingRow): SecurityFinding => ({
  id: row.id,
  threadId: row.thread_id,
  checkpointId: row.checkpoint_id,
  patternId: row.pattern_id,
  file: row.file,
  line: row.line,
  correctionId: row.correction_id,
  createdAt: row.created_at,
  acknowledgedAt: row.acknowledged_at,
  ackReason: row.ack_reason,
});

/** The `security_hold` flag on one thread, raised by the scan and the sweep, cleared by `ack`. */
export const flagKey = (threadId: string) =>
  ({ pluginId: "review", threadId, kind: "security_hold" }) as const;
export const RESUME_ACTION = { label: "Open thread", target: "thread" } as const;

export const holdText = (open: number) =>
  `Security hold: ${open} ${open === 1 ? "finding needs" : "findings need"} acknowledgement.`;

/** A project's saved mode, or null when none is saved. */
export const savedModeOf = (sql: SqlClient.SqlClient, projectId: ProjectId) =>
  Effect.map(
    sql<{ readonly mode: SecurityMode }>`SELECT mode FROM security_mode
      WHERE project_id = ${projectId}`,
    ([row]): SecurityMode | null => row?.mode ?? null,
  );

/** A project's mode: `warn` until one is saved. */
export const modeOf = (sql: SqlClient.SqlClient, projectId: ProjectId) =>
  Effect.map(savedModeOf(sql, projectId), (mode) => mode ?? "warn");

/**
 * The open findings holding the thread: every unacknowledged one, once any of them was recorded
 * while the project was in `block`; otherwise 0, and the thread has no hold.
 */
export const holdOf = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.map(
    sql<{ readonly open: number; readonly held: number | null }>`
      SELECT COUNT(*) AS open, MAX(blocking) AS held FROM security_finding
      WHERE thread_id = ${threadId} AND acknowledged_at IS NULL`,
    ([row]) => (row?.held === 1 ? row.open : 0),
  );

/**
 * Whether a review of `checkpoint` must wait for the security scan: only in a `block` project, and
 * only while the scan has not handled the checkpoint. A checkpoint captured before the scan began
 * never will be, so it does not wait.
 */
export const scanPending = (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
  checkpoint: Pick<OrchestrationV2Checkpoint, "id" | "capturedAt">,
) =>
  Effect.gen(function* () {
    if ((yield* modeOf(sql, projectId)) !== "block") return false;
    const [row] = yield* sql<{ readonly scanned: number; readonly since: string | null }>`
      SELECT EXISTS (SELECT 1 FROM security_scan WHERE checkpoint_id = ${checkpoint.id}) AS scanned,
        (SELECT since FROM security_scan_since WHERE id = 1) AS since`;
    // Strictly after: a checkpoint captured in the same millisecond the cursor was sampled may be
    // one the reactor skipped.
    return (
      row?.scanned === 0 &&
      row.since !== null &&
      DateTime.formatIso(checkpoint.capturedAt) > row.since
    );
  });

/**
 * Refuses a review step on `threadId` while, in a `block` project, the scan of `checkpoint` is still
 * to come (`scan_pending`), and then while the thread is held (`gated`). The scan writes its row
 * and its findings in one transaction, so asking whether it is done before asking for a hold means
 * a scan that commits between the two is seen by the second.
 */
export const securityGate = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly checkpoint: Pick<OrchestrationV2Checkpoint, "id" | "capturedAt">;
  },
) =>
  Effect.gen(function* () {
    if (yield* scanPending(sql, input.projectId, input.checkpoint)) {
      return yield* new ReviewVerdictError({
        code: "scan_pending",
        message:
          "The security scan of this thread's latest checkpoint has not finished. Ask again shortly.",
      });
    }
    const held = yield* holdOf(sql, input.threadId);
    if (held > 0) {
      return yield* new ReviewVerdictError({
        code: "gated",
        message: `${holdText(held)} Call review_security_ack with a reason.`,
      });
    }
  });

/**
 * A project's security mode, a thread's findings, and the acknowledgement that clears a hold. The
 * scan writes the findings; `ReviewRequests.request` refuses while `holdOf` counts any.
 */
export class SecurityHold extends Context.Service<
  SecurityHold,
  {
    readonly getMode: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<SecurityModeSetting, ReviewVerdictError>;
    /**
     * Applies to the turns scanned after it, which are those that end after it unless a failed scan
     * is retried; a hold already open stays until it is acknowledged.
     */
    readonly setMode: (
      input: SecurityModeSetting,
    ) => Effect.Effect<SecurityModeSetting, ReviewVerdictError>;
    /** The thread's findings, oldest first. */
    readonly findings: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<SecurityFinding>, ReviewVerdictError>;
    /**
     * Acknowledges every open finding on the thread with the reason and clears the hold and its
     * flag; answers with the findings it acknowledged. Refuses an empty reason, and a thread with
     * no hold.
     */
    readonly ack: (input: {
      readonly threadId: ThreadId;
      readonly reason: string;
    }) => Effect.Effect<ReadonlyArray<SecurityFinding>, ReviewVerdictError>;
  }
>()("t3/plugins/review/security/SecurityHold") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attention = yield* Attention.Attention;

  const io = (cause: SqlError.SqlError) =>
    Effect.logWarning("review: a security read or write failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new ReviewVerdictError({
            code: "io",
            message: "The security findings could not be read or written.",
          }),
        ),
      ),
    );

  const getMode: SecurityHold["Service"]["getMode"] = ({ projectId }) =>
    modeOf(sql, projectId).pipe(
      Effect.map((mode) => ({ projectId, mode })),
      Effect.catchTags({ SqlError: io }),
    );

  const setMode: SecurityHold["Service"]["setMode"] = ({ projectId, mode }) =>
    sql`INSERT INTO security_mode (project_id, mode) VALUES (${projectId}, ${mode})
      ON CONFLICT (project_id) DO UPDATE SET mode = excluded.mode`.pipe(
      Effect.as({ projectId, mode }),
      Effect.catchTags({ SqlError: io }),
    );

  const findings: SecurityHold["Service"]["findings"] = ({ threadId }) =>
    sql<FindingRow>`SELECT * FROM security_finding WHERE thread_id = ${threadId}
      ORDER BY id`.pipe(
      Effect.map((rows) => rows.map(toFinding)),
      Effect.catchTags({ SqlError: io }),
    );

  const ack: SecurityHold["Service"]["ack"] = ({ threadId, reason }) =>
    Effect.gen(function* () {
      const given = reason.trim();
      if (given === "") {
        return yield* new ReviewVerdictError({ code: "invalid", message: "A reason is required." });
      }
      const at = DateTime.formatIso(yield* DateTime.now);
      const acknowledged = yield* sql.withTransaction(
        Effect.gen(function* () {
          if ((yield* holdOf(sql, threadId)) === 0) return undefined;
          return yield* sql<FindingRow>`UPDATE security_finding
            SET acknowledged_at = ${at}, ack_reason = ${given}
            WHERE thread_id = ${threadId} AND acknowledged_at IS NULL
            RETURNING *`;
        }),
      );
      if (acknowledged === undefined) {
        return yield* new ReviewVerdictError({
          code: "conflict",
          message: "There is no security hold on this thread.",
        });
      }
      // The flag lives in the host's file. Should this write fail, the security sweep clears it on
      // its next tick, so the acknowledgement still stands.
      yield* attention
        .clear(flagKey(threadId))
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("review: could not clear a security hold flag", { cause }),
          ),
        );
      return acknowledged.map(toFinding).toSorted((a, b) => a.id - b.id);
    }).pipe(Effect.catchTags({ SqlError: io }));

  return SecurityHold.of({ getMode, setMode, findings, ack });
});

export const layer = Layer.effect(SecurityHold, make);
