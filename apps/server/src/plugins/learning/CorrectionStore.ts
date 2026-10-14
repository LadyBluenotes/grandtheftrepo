import {
  EventId,
  LEARNING_PROVIDER_FAILURE_KINDS,
  type LearningCorrection,
  type LearningCorrectionDeclareInput,
  type LearningCorrectionsInput,
  type LearningDeclaredMode,
  LearningError,
  type LearningFailureKind,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { rememberThread, threadFacts } from "./producers/threads.ts";
import { redact } from "./redact.ts";

/** A correction to store. The description is redacted and bounded on the way in. */
export interface NewCorrection {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly failureKind: LearningFailureKind;
  readonly declaredMode?: LearningDeclaredMode | undefined;
  readonly description: string;
  readonly sourceEventIds: ReadonlyArray<EventId>;
  /** Unique with `failureKind`: the same pair again stores nothing. Null for a row nothing replays. */
  readonly sourceKey: string | null;
  /** When the source event happened, which dates the row; without one the row is dated now. */
  readonly occurredAt?: DateTime.Utc | undefined;
}

interface Row {
  readonly id: number;
  readonly project_id: ProjectId;
  readonly thread_id: ThreadId;
  readonly failure_kind: LearningFailureKind;
  readonly cause_class: string;
  readonly declared_mode: LearningDeclaredMode | null;
  readonly description: string;
  readonly source_event_ids: string;
  readonly source_key: string | null;
  readonly classified_at: string | null;
  readonly classification_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const EventIdsJson = Schema.fromJsonString(Schema.Array(EventId));
const decodeEventIds = Schema.decodeUnknownSync(EventIdsJson);
const encodeEventIds = Schema.encodeSync(EventIdsJson);

const toCorrection = (row: Row): LearningCorrection => ({
  id: row.id,
  projectId: row.project_id,
  threadId: row.thread_id,
  failureKind: row.failure_kind,
  causeClass: row.cause_class,
  declaredMode: row.declared_mode,
  description: row.description,
  sourceEventIds: decodeEventIds(row.source_event_ids),
  sourceKey: row.source_key,
  classifiedAt: row.classified_at,
  classificationReason: row.classification_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Stores one correction unless `(failureKind, sourceKey)` is already there, and answers with
 * the stored row either way. Producers call it inside the reactor's transaction; `record`
 * wraps it for everything else.
 */
export const insert = Effect.fn("CorrectionStore.insert")(function* (input: NewCorrection) {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(input.occurredAt ?? (yield* DateTime.now));
  const inserted = yield* sql<{ readonly id: number }>`INSERT INTO corrections
    (project_id, thread_id, failure_kind, cause_class, declared_mode, description,
     source_event_ids, source_key, created_at, updated_at)
    VALUES (${input.projectId}, ${input.threadId}, ${input.failureKind}, 'unclassified',
     ${input.declaredMode ?? null}, ${redact(input.description)},
     ${encodeEventIds(input.sourceEventIds)}, ${input.sourceKey}, ${at}, ${at})
    ON CONFLICT (failure_kind, source_key) DO NOTHING
    RETURNING id`;
  const id = inserted[0]?.id;
  const rows =
    id === undefined
      ? yield* sql<Row>`SELECT * FROM corrections
          WHERE failure_kind = ${input.failureKind} AND source_key = ${input.sourceKey}`
      : yield* sql<Row>`SELECT * FROM corrections WHERE id = ${id}`;
  return toCorrection(rows[0]!);
});

/**
 * How many of a project's corrections declare `mode`, created in `[from, to)`, the instants ISO
 * strings. The outcome sweep counts recurrences with it; it has no gateway method.
 */
export const countDeclared = (input: {
  readonly projectId: ProjectId;
  readonly mode: string;
  readonly from: string;
  readonly to: string;
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM corrections
      WHERE project_id = ${input.projectId} AND declared_mode = ${input.mode}
        AND created_at >= ${input.from} AND created_at < ${input.to}`,
  ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));

/**
 * Per project, how many corrections the classify sweep left `unclassified` that are no provider
 * failure, created at or before `before`, an ISO instant. One the sweep has not read yet is left
 * out, since it may still get a mode. The unclassified sweep flags them; it has no gateway method.
 */
export const countUnclassified = (before: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly project_id: ProjectId; readonly n: number }>`
      SELECT project_id, COUNT(*) AS n FROM corrections
      WHERE classified_at IS NOT NULL AND cause_class = 'unclassified'
        AND failure_kind NOT IN ${sql.in([...LEARNING_PROVIDER_FAILURE_KINDS])}
        AND created_at <= ${before}
      GROUP BY project_id ORDER BY project_id`,
  );

export class CorrectionStore extends Context.Service<
  CorrectionStore,
  {
    /**
     * Stores a correction on a thread the plugin has seen; the same `(failureKind, sourceKey)`
     * again answers with the existing row. The project defaults to the thread's and must match it.
     */
    readonly record: (
      input: Omit<NewCorrection, "projectId"> & { readonly projectId?: ProjectId | undefined },
    ) => Effect.Effect<LearningCorrection, LearningError>;
    /**
     * Stores a correction for a caller that has checked the thread's project against the core's
     * thread shell, as a kanban ticket's reopen does. A thread the reactor has not replayed yet is
     * remembered under that project rather than refused, so a correction is not lost to projection
     * lag; the caller's check is what keeps it from landing in another project.
     */
    readonly recordForProject: (
      input: NewCorrection,
    ) => Effect.Effect<LearningCorrection, LearningError>;
    /** A project's corrections created between `from` and `to`, inclusive, oldest first. */
    readonly list: (
      input: LearningCorrectionsInput,
    ) => Effect.Effect<ReadonlyArray<LearningCorrection>, LearningError>;
    readonly get: (id: number) => Effect.Effect<LearningCorrection, LearningError>;
    /**
     * Declares the review failure mode of a correction that has none and marks it unread, so the next classify
     * sweep makes it evidence on that mode's item. A provider failure, or a correction that already
     * declares a mode, is refused.
     */
    readonly declare: (
      input: LearningCorrectionDeclareInput,
    ) => Effect.Effect<LearningCorrection, LearningError>;
    /** The correction stored under `(failureKind, sourceKey)`, or undefined when there is none. */
    readonly findBySourceKey: (
      failureKind: LearningFailureKind,
      sourceKey: string,
    ) => Effect.Effect<LearningCorrection | undefined, LearningError>;
  }
>()("t3/plugins/learning/CorrectionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const io = (cause: SqlError.SqlError) =>
    Effect.logWarning("learning: database operation failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new LearningError({
            code: "io",
            message: "The learning database could not be read or written.",
          }),
        ),
      ),
    );

  const record: CorrectionStore["Service"]["record"] = ({ projectId, ...input }) =>
    Effect.gen(function* () {
      const thread = yield* threadFacts(input.threadId);
      if (thread === undefined) {
        return yield* new LearningError({
          code: "not_found",
          message: `Thread "${input.threadId}" is unknown to the learning plugin.`,
        });
      }
      if (projectId !== undefined && projectId !== thread.project_id) {
        return yield* new LearningError({
          code: "not_found",
          message: `Thread "${input.threadId}" belongs to project "${thread.project_id}".`,
        });
      }
      return yield* insert({ ...input, projectId: thread.project_id });
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTags({ SqlError: io }));

  const recordForProject: CorrectionStore["Service"]["recordForProject"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* threadFacts(input.threadId);
      if (thread === undefined) {
        yield* rememberThread({ id: input.threadId, projectId: input.projectId });
      } else if (thread.project_id !== input.projectId) {
        return yield* new LearningError({
          code: "not_found",
          message: `Thread "${input.threadId}" belongs to project "${thread.project_id}".`,
        });
      }
      return yield* insert(input);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTags({ SqlError: io }));

  const list: CorrectionStore["Service"]["list"] = (input) =>
    sql<Row>`SELECT * FROM corrections
      WHERE project_id = ${input.projectId}
        AND created_at >= ${input.from} AND created_at <= ${input.to}
        ${input.failureKind === undefined ? sql`` : sql`AND failure_kind = ${input.failureKind}`}
      ORDER BY created_at, id`.pipe(
      Effect.map((rows) => rows.map(toCorrection)),
      Effect.catch(io),
    );

  const get: CorrectionStore["Service"]["get"] = (id) =>
    sql<Row>`SELECT * FROM corrections WHERE id = ${id}`.pipe(
      Effect.catch(io),
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row === undefined
          ? Effect.fail(new LearningError({ code: "not_found", message: `No correction ${id}.` }))
          : Effect.succeed(toCorrection(row));
      }),
    );

  const findBySourceKey: CorrectionStore["Service"]["findBySourceKey"] = (failureKind, sourceKey) =>
    sql<Row>`SELECT * FROM corrections
      WHERE failure_kind = ${failureKind} AND source_key = ${sourceKey}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toCorrection(rows[0]))),
      Effect.catch(io),
    );

  const declare: CorrectionStore["Service"]["declare"] = ({ id, declaredMode }) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      const [declared] = yield* sql<Row>`UPDATE corrections
        SET declared_mode = ${declaredMode}, classified_at = NULL, classification_reason = NULL,
          updated_at = ${at}
        WHERE id = ${id} AND declared_mode IS NULL
          AND failure_kind NOT IN ${sql.in([...LEARNING_PROVIDER_FAILURE_KINDS])}
        RETURNING *`.pipe(Effect.catch(io));
      if (declared !== undefined) return toCorrection(declared);
      const current = yield* get(id);
      return yield* new LearningError({
        code: "invalid",
        message: LEARNING_PROVIDER_FAILURE_KINDS.has(current.failureKind)
          ? `Correction ${id} is a provider failure, which says nothing about the work, so it takes no mode.`
          : `Correction ${id} already declares ${current.declaredMode}.`,
      });
    });

  return CorrectionStore.of({ record, recordForProject, list, get, findBySourceKey, declare });
});

export const layer = Layer.effect(CorrectionStore, make);
