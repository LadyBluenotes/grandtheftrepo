import type {
  LearningItem,
  LearningOwnerKind,
  LearningPromotion,
  LearningPromotionOutcome,
  LearningPromotionReview,
  LearningReviewVerdict,
  ProjectId,
} from "@t3tools/contracts";
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
  readonly proposed_by: string;
  readonly attempts: number;
  readonly next_attempt_at: string | null;
  readonly last_error: string | null;
  readonly delivered_at: string | null;
  readonly adopted_at: string | null;
  readonly rolled_back_at: string | null;
  readonly rolled_back_by: string | null;
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
  proposedBy: row.proposed_by,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  deliveredAt: row.delivered_at,
  adoptedAt: row.adopted_at,
  rolledBackAt: row.rolled_back_at,
  rolledBackBy: row.rolled_back_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** One promotion by id, or undefined. */
export const byId = (id: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<Row>`SELECT * FROM learning_promotions WHERE id = ${id}`,
  ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toPromotion(rows[0]))));

/** An item's promotions, oldest first. */
export const forItem = (itemId: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<Row>`SELECT * FROM learning_promotions WHERE item_id = ${itemId} ORDER BY id`,
  ).pipe(Effect.map((rows) => rows.map(toPromotion)));

/** The verdicts on an item's promotions, oldest first. */
export const reviewsForItem = (itemId: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly id: number;
      readonly promotion_id: number;
      readonly verdict: LearningReviewVerdict;
      readonly reviewer: string;
      readonly note: string | null;
      readonly created_at: string;
    }>`SELECT r.* FROM promotion_reviews r
      JOIN learning_promotions p ON p.id = r.promotion_id
      WHERE p.item_id = ${itemId}
      ORDER BY r.id`,
  ).pipe(
    Effect.map((rows) =>
      rows.map((row): LearningPromotionReview => ({
        id: row.id,
        promotionId: row.promotion_id,
        verdict: row.verdict,
        reviewer: row.reviewer,
        note: row.note,
        createdAt: row.created_at,
      })),
    ),
  );

/** The outcome sweep's verdicts on an item's promotions, by promotion. */
export const outcomesForItem = (itemId: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly promotion_id: number;
      readonly verdict: LearningPromotionOutcome["verdict"];
      readonly judged_at: string;
    }>`SELECT o.promotion_id, o.verdict, o.judged_at FROM promotion_outcome o
      JOIN learning_promotions p ON p.id = o.promotion_id
      WHERE p.item_id = ${itemId}
      ORDER BY o.promotion_id`,
  ).pipe(
    Effect.map((rows) =>
      rows.map((row): LearningPromotionOutcome => ({
        promotionId: row.promotion_id,
        verdict: row.verdict,
        judgedAt: row.judged_at,
      })),
    ),
  );

/**
 * A project's promotions handed over in `[from, to)` to one of `ownerKinds`, oldest first,
 * whatever their review made of them since.
 */
export const deliveredIn = (input: {
  readonly projectId: ProjectId;
  readonly ownerKinds: ReadonlyArray<LearningOwnerKind>;
  readonly from: string;
  readonly to: string;
}) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    input.ownerKinds.length === 0
      ? Effect.succeed([])
      : sql<Row>`SELECT * FROM learning_promotions
          WHERE project_id = ${input.projectId} AND delivered_at IS NOT NULL
            AND owner_kind IN ${sql.in(input.ownerKinds)}
            AND delivered_at >= ${input.from} AND delivered_at < ${input.to}
          ORDER BY delivered_at, id`,
  ).pipe(Effect.map((rows) => rows.map(toPromotion)));

/**
 * Up to `limit` candidate items that need a record or whose record was already adopted, with the
 * state of the promotion for their owner kind: null when there is none, `adopted` when there is.
 * The record is keyed by project, failure mode and owner kind, so a repeat finds the old one. One
 * whose record is on its way, or was rejected, rolled back or gave up, is left out; the record
 * carries it from there.
 */
export const candidates = (limit: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly id: number;
      readonly project_id: ProjectId;
      readonly failure_mode: string;
      readonly owner_kind: LearningOwnerKind;
      readonly disposition_by: LearningItem["dispositionBy"];
      readonly promotion_state: "adopted" | null;
    }>`SELECT i.id, i.project_id, i.failure_mode, i.owner_kind, i.disposition_by,
        p.state AS promotion_state
      FROM learning_items i
      LEFT JOIN learning_promotions p ON p.project_id = i.project_id
        AND p.failure_mode = i.failure_mode AND p.owner_kind = i.owner_kind
      WHERE i.state = 'candidate' AND (p.state IS NULL OR p.state = 'adopted')
      ORDER BY i.id
      LIMIT ${limit}`,
  );

/**
 * Opens the proposed record for a candidate; one that is already there is left alone. Whoever
 * picked the owner kind proposes it: a person (`user`), or the rules (`supervisor`).
 */
export const open = (
  item: {
    readonly id: number;
    readonly project_id: ProjectId;
    readonly failure_mode: string;
    readonly owner_kind: LearningOwnerKind;
    readonly disposition_by: LearningItem["dispositionBy"];
  },
  now: DateTime.Utc,
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const at = DateTime.formatIso(now);
    const proposedBy = item.disposition_by === "person" ? "user" : "supervisor";
    return sql`INSERT INTO learning_promotions
      (item_id, project_id, failure_mode, owner_kind, state, proposed_by, attempts, created_at,
        updated_at)
      VALUES (${item.id}, ${item.project_id}, ${item.failure_mode}, ${item.owner_kind}, 'proposed',
        ${proposedBy}, 0, ${at}, ${at})
      ON CONFLICT (project_id, failure_mode, owner_kind) DO NOTHING`;
  }).pipe(Effect.asVoid);

/**
 * Marks a candidate whose owner kind adopted this lesson as promoted, only while `ownerKind`, the
 * one the caller saw, is still its owner kind. One a person moved meanwhile stays a candidate for
 * its new owner kind.
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
 * Up to `limit` proposed promotions for `ownerKinds` whose time has come and whose item still wants
 * them: a candidate with the same owner kind. One a person closed or moved to another owner kind
 * waits. The earliest due go first; one never attempted is due from when it was created, so a
 * backlog of new records cannot keep a retry waiting.
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
      WHERE p.state = 'proposed' AND p.owner_kind IN ${sql.in(ownerKinds)}
        AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ${DateTime.formatIso(now)})
        AND i.state = 'candidate' AND i.owner_kind = p.owner_kind
      ORDER BY COALESCE(p.next_attempt_at, p.created_at), p.id
      LIMIT ${limit}`,
  ).pipe(Effect.map((rows) => rows.map(toPromotion)));

/** The promoter wrote the draft: the record is in review from now. Its item stays a candidate. */
export const deliver = (promotion: LearningPromotion, now: DateTime.Utc) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const at = DateTime.formatIso(now);
    return sql`UPDATE learning_promotions
      SET state = 'in_review', delivered_at = ${at}, next_attempt_at = NULL, updated_at = ${at}
      WHERE id = ${promotion.id} AND state = 'proposed'`;
  }).pipe(Effect.asVoid);

/** Counts a failed attempt and answers with the record's new state, `failed` on the last one. */
export const fail = (promotion: LearningPromotion, message: string, now: DateTime.Utc) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const attempts = promotion.attempts + 1;
    const state = attempts >= MAX_ATTEMPTS ? "failed" : "proposed";
    const next = state === "failed" ? null : DateTime.formatIso(DateTime.add(now, RETRY_DELAY));
    return sql`UPDATE learning_promotions
      SET state = ${state}, attempts = ${attempts}, next_attempt_at = ${next},
        last_error = ${message}, updated_at = ${DateTime.formatIso(now)}
      WHERE id = ${promotion.id}`.pipe(Effect.as(state));
  });

const spaced = (name: string) => name.replaceAll("_", " ");

/**
 * Reopens the item of a promotion that review turned down or that was rolled back, with why, while
 * the item is still with that owner kind and in one of `from`. The rules route it no more.
 */
const reopenItem = (
  promotion: LearningPromotion,
  reason: string,
  from: ReadonlyArray<LearningItem["state"]>,
  now: DateTime.Utc,
) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`UPDATE learning_items
      SET state = 'open', reason = ${reason}, updated_at = ${DateTime.formatIso(now)}
      WHERE id = ${promotion.itemId} AND owner_kind = ${promotion.ownerKind}
        AND state IN ${sql.in(from)}`,
  ).pipe(Effect.asVoid);

/**
 * Stores a verdict on a promotion in review and applies it: `adopt` adopts it and promotes its
 * item, `reject` rejects it and reopens its item, `revise` leaves both as they are. Answers with
 * the promotion, or undefined when it was no longer in review. Run it in a transaction; the
 * caller has checked the reviewer.
 */
export const review = (
  promotion: LearningPromotion,
  input: {
    readonly verdict: LearningReviewVerdict;
    readonly reviewer: string;
    readonly note: string | null;
  },
  now: DateTime.Utc,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = DateTime.formatIso(now);
    const next = { adopt: "adopted", reject: "rejected", revise: "in_review" }[input.verdict];
    const [updated] = yield* sql<Row>`UPDATE learning_promotions
      SET state = ${next}, updated_at = ${at},
        adopted_at = ${input.verdict === "adopt" ? at : null}
      WHERE id = ${promotion.id} AND state = 'in_review'
      RETURNING *`;
    if (updated === undefined) return undefined;
    yield* sql`INSERT INTO promotion_reviews (promotion_id, verdict, reviewer, note, created_at)
      VALUES (${promotion.id}, ${input.verdict}, ${input.reviewer}, ${input.note}, ${at})`;
    if (input.verdict === "adopt") yield* markPromoted(promotion.itemId, promotion.ownerKind, now);
    if (input.verdict === "reject") {
      yield* reopenItem(
        promotion,
        `The ${spaced(promotion.ownerKind)} handover was rejected.`,
        ["candidate"],
        now,
      );
    }
    return toPromotion(updated);
  });

/**
 * Undoes an adopted promotion and reopens its item, whatever state the item is in, while the item
 * is still with that owner kind; one a person has since handed to another keeps that handover.
 * Answers with the promotion, or undefined when it was not adopted. Run it in a transaction.
 */
export const rollBack = (promotion: LearningPromotion, actor: string, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = DateTime.formatIso(now);
    const [updated] = yield* sql<Row>`UPDATE learning_promotions
      SET state = 'rolled_back', rolled_back_at = ${at}, rolled_back_by = ${actor},
        updated_at = ${at}
      WHERE id = ${promotion.id} AND state = 'adopted'
      RETURNING *`;
    if (updated === undefined) return undefined;
    yield* reopenItem(
      promotion,
      `The ${spaced(promotion.ownerKind)} handover was rolled back.`,
      ["open", "candidate", "promoted", "closed"],
      now,
    );
    return toPromotion(updated);
  });
