import type { LearningOwnerKind, LearningPromotion, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The fifth failed attempt gives up; each earlier one waits this long before the next. */
const MAX_ATTEMPTS = 5;
const RETRY_DELAY = { hours: 6 };

interface Row {
  readonly id: number;
  readonly item_id: number;
  readonly project_id: ProjectId;
  readonly failure_mode: string;
  readonly owner_kind: LearningOwnerKind;
  readonly state: LearningPromotion["state"];
  readonly attempts: number;
  readonly next_attempt_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const toPromotion = (row: Row): LearningPromotion => ({
  id: row.id,
  itemId: row.item_id,
  projectId: row.project_id,
  failureMode: row.failure_mode,
  ownerKind: row.owner_kind,
  state: row.state,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** An item's promotions, oldest first. */
export const forItem = (itemId: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<Row>`SELECT * FROM learning_promotions WHERE item_id = ${itemId} ORDER BY id`,
  ).pipe(Effect.map((rows) => rows.map(toPromotion)));

/**
 * Up to `limit` candidate items that need a record or were already handed over, with the state of
 * the promotion for their owner kind: null when there is none, `delivered` when there is. The
 * record is keyed by project, failure mode and owner kind, so a repeat finds the old one. One
 * whose record is pending or failed is left out; the record carries it from there.
 */
export const candidates = (limit: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly id: number;
      readonly project_id: ProjectId;
      readonly failure_mode: string;
      readonly owner_kind: LearningOwnerKind;
      readonly promotion_state: "delivered" | null;
    }>`SELECT i.id, i.project_id, i.failure_mode, i.owner_kind, p.state AS promotion_state
      FROM learning_items i
      LEFT JOIN learning_promotions p ON p.project_id = i.project_id
        AND p.failure_mode = i.failure_mode AND p.owner_kind = i.owner_kind
      WHERE i.state = 'candidate' AND (p.state IS NULL OR p.state = 'delivered')
      ORDER BY i.id
      LIMIT ${limit}`,
  );

/** Opens the pending record for a candidate; one that is already there is left alone. */
export const open = (
  item: {
    readonly id: number;
    readonly project_id: ProjectId;
    readonly failure_mode: string;
    readonly owner_kind: LearningOwnerKind;
  },
  now: DateTime.Utc,
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const at = DateTime.formatIso(now);
    return sql`INSERT INTO learning_promotions
      (item_id, project_id, failure_mode, owner_kind, state, attempts, created_at, updated_at)
      VALUES (${item.id}, ${item.project_id}, ${item.failure_mode}, ${item.owner_kind}, 'pending', 0,
        ${at}, ${at})
      ON CONFLICT (project_id, failure_mode, owner_kind) DO NOTHING`;
  }).pipe(Effect.asVoid);

/**
 * Marks a candidate whose owner kind was handed this lesson as promoted, only while `ownerKind`,
 * the one the caller saw, is still its owner kind. One a person moved meanwhile stays a candidate
 * for its new owner kind.
 */
export const markPromoted = (itemId: number, ownerKind: LearningOwnerKind, now: DateTime.Utc) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (
      sql,
    ) => sql`UPDATE learning_items SET state = 'promoted', updated_at = ${DateTime.formatIso(now)}
      WHERE id = ${itemId} AND state = 'candidate' AND owner_kind = ${ownerKind}`,
  ).pipe(Effect.asVoid);

/**
 * Up to `limit` pending promotions for `ownerKinds` whose time has come and whose item still wants
 * them: a candidate with the same owner kind. One a person closed or moved to another owner kind
 * waits. The earliest due go first; one never attempted is due from the start.
 */
export const due = (
  now: DateTime.Utc,
  ownerKinds: ReadonlyArray<LearningOwnerKind>,
  limit: number,
) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<Row>`SELECT p.* FROM learning_promotions p
      JOIN learning_items i ON i.id = p.item_id
      WHERE p.state = 'pending' AND p.owner_kind IN ${sql.in(ownerKinds)}
        AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ${DateTime.formatIso(now)})
        AND i.state = 'candidate' AND i.owner_kind = p.owner_kind
      ORDER BY p.next_attempt_at, p.id
      LIMIT ${limit}`,
  ).pipe(Effect.map((rows) => rows.map(toPromotion)));

/**
 * The promoter took it: the record is delivered and the item promoted, together, unless a person
 * moved the item to another owner kind while it was being handed over.
 */
export const deliver = (promotion: LearningPromotion, now: DateTime.Utc) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const at = DateTime.formatIso(now);
        yield* sql`UPDATE learning_promotions
          SET state = 'delivered', next_attempt_at = NULL, updated_at = ${at}
          WHERE id = ${promotion.id}`;
        yield* markPromoted(promotion.itemId, promotion.ownerKind, now);
      }),
    ),
  );

/** Counts a failed attempt and answers with the record's new state, `failed` on the last one. */
export const fail = (promotion: LearningPromotion, message: string, now: DateTime.Utc) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const attempts = promotion.attempts + 1;
    const state = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    const next = state === "failed" ? null : DateTime.formatIso(DateTime.add(now, RETRY_DELAY));
    return sql`UPDATE learning_promotions
      SET state = ${state}, attempts = ${attempts}, next_attempt_at = ${next},
        last_error = ${message}, updated_at = ${DateTime.formatIso(now)}
      WHERE id = ${promotion.id}`.pipe(Effect.as(state));
  });
