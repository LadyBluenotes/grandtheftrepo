import {
  type LearningItem,
  type LearningItemDetail,
  type LearningItemsInput,
  type LearningItemsSetDispositionInput,
  LearningError,
  type LearningOwnerKind,
  type LearningPromotion,
  type LearningPromotionReviewInput,
  type LearningPromotionRollBackInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { route, routedState } from "../classify.ts";
import * as PromotionStore from "../PromotionStore.ts";
import { redact } from "../redact.ts";

interface Row {
  readonly id: number;
  readonly project_id: ProjectId;
  readonly failure_mode: string;
  readonly occurrences: number;
  readonly state: LearningItem["state"];
  readonly owner_kind: LearningOwnerKind | null;
  readonly disposition_by: LearningItem["dispositionBy"];
  readonly disposition_at: string | null;
  readonly reason: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const toItem = (row: Row): LearningItem => ({
  id: row.id,
  projectId: row.project_id,
  failureMode: row.failure_mode,
  occurrences: row.occurrences,
  state: row.state,
  ownerKind: row.owner_kind,
  dispositionBy: row.disposition_by,
  dispositionAt: row.disposition_at,
  reason: row.reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** When a project first handed a failure mode over: its earliest promotion's delivery. */
export interface ItemDelivery {
  readonly failureMode: string;
  /** An ISO instant. */
  readonly deliveredAt: string;
}

/**
 * Learning items: one per recurring failure mode per project, routed to an owner kind by rules on
 * the mode alone, or by a person, whose choice no rule overwrites.
 */
export class ItemStore extends Context.Service<
  ItemStore,
  {
    /**
     * Opens the project's item for `failureMode`, or adds one piece of evidence to it. The same
     * `evidenceKey` again changes nothing. The summary is redacted and bounded. Every producer of
     * items comes through here.
     */
    readonly strengthen: (
      projectId: ProjectId,
      failureMode: string,
      evidenceKey: string,
      summary: string,
    ) => Effect.Effect<LearningItem, LearningError>;
    /** A project's items, most recently updated first. */
    readonly list: (
      input: LearningItemsInput,
    ) => Effect.Effect<ReadonlyArray<LearningItem>, LearningError>;
    /** One item with its evidence and promotions, oldest first. */
    readonly get: (id: number) => Effect.Effect<LearningItemDetail, LearningError>;
    /**
     * For each failure mode a project has handed over, when its earliest promotion's draft was
     * delivered, by failure mode. One query over the promotion records, whatever state the item
     * or its review is in now: a person closing or moving an item does not undo its handover.
     * Internal: it has no gateway method.
     */
    readonly deliveredAt: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ItemDelivery>, LearningError>;
    /**
     * A project's promotions whose draft was delivered in `[from, to)` to one of `ownerKinds`,
     * oldest first, for reports. Internal: it has no gateway method.
     */
    readonly deliveredIn: (input: {
      readonly projectId: ProjectId;
      readonly ownerKinds: ReadonlyArray<LearningOwnerKind>;
      readonly from: string;
      readonly to: string;
    }) => Effect.Effect<ReadonlyArray<LearningPromotion>, LearningError>;
    /**
     * A person sets the owner kind or closes and reopens the item. `promoted` comes only from
     * adoption and `candidate` only from the owner kind, so neither is accepted. An owner kind
     * whose handover review rejected or that was rolled back gets nothing more: the item is open.
     */
    readonly setDisposition: (
      input: LearningItemsSetDispositionInput,
    ) => Effect.Effect<LearningItem, LearningError>;
    /**
     * `reviewer`'s verdict on a promotion in review: `user` for a person on a client,
     * `thread:<id>` for an agent. The promotion's proposer is refused, as is a promotion not in
     * review. `adopt` adopts it and promotes its item, and is refused while the item is not a
     * candidate for its owner kind; `reject` rejects it and reopens its item; `revise` keeps it in
     * review for another verdict.
     */
    readonly reviewPromotion: (
      input: LearningPromotionReviewInput,
      reviewer: string,
    ) => Effect.Effect<LearningPromotion, LearningError>;
    /** `actor` undoes an adopted promotion, which reopens its item. */
    readonly rollBackPromotion: (
      input: LearningPromotionRollBackInput,
      actor: string,
    ) => Effect.Effect<LearningPromotion, LearningError>;
  }
>()("t3/plugins/learning/items/ItemStore") {}

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
  const notFound = (id: number) =>
    new LearningError({ code: "not_found", message: `No learning item ${id}.` });
  const row = (id: number) =>
    sql<Row>`SELECT * FROM learning_items WHERE id = ${id}`.pipe(Effect.map((rows) => rows[0]));

  const strengthen: ItemStore["Service"]["strengthen"] = (
    projectId,
    failureMode,
    evidenceKey,
    summary,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          const rule = route(failureMode);
          // The rules route a new item, and route it again only while they still own its
          // disposition, nothing has been adopted, and no review turned a handover down.
          yield* sql`INSERT INTO learning_items
            (project_id, failure_mode, occurrences, state, owner_kind, disposition_by, reason,
             created_at, updated_at)
            VALUES (${projectId}, ${failureMode}, 0, ${rule.state}, ${rule.ownerKind}, 'rule',
             ${rule.reason}, ${at}, ${at})
            ON CONFLICT (project_id, failure_mode) DO UPDATE SET
              owner_kind = excluded.owner_kind, state = excluded.state, reason = excluded.reason
            WHERE learning_items.disposition_by = 'rule'
              AND learning_items.state IN ('open', 'candidate')
              AND NOT EXISTS (SELECT 1 FROM learning_promotions p
                WHERE p.item_id = learning_items.id AND p.state IN ('rejected', 'rolled_back'))`;
          const [item] = yield* sql<Row>`SELECT * FROM learning_items
            WHERE project_id = ${projectId} AND failure_mode = ${failureMode}`;
          const added = yield* sql`INSERT INTO learning_item_evidence
            (item_id, evidence_key, summary, created_at)
            VALUES (${item!.id}, ${evidenceKey}, ${redact(summary)}, ${at})
            ON CONFLICT (item_id, evidence_key) DO NOTHING
            RETURNING evidence_key`;
          if (added.length === 0) return toItem(item!);
          const [updated] = yield* sql<Row>`UPDATE learning_items
            SET occurrences = (SELECT COUNT(*) FROM learning_item_evidence WHERE item_id = ${item!.id}),
              updated_at = ${at}
            WHERE id = ${item!.id}
            RETURNING *`;
          return toItem(updated!);
        }),
      )
      .pipe(Effect.catchTags({ SqlError: io }));

  const list: ItemStore["Service"]["list"] = ({ projectId, state }) =>
    sql<Row>`SELECT * FROM learning_items
      WHERE project_id = ${projectId} ${state === undefined ? sql`` : sql`AND state = ${state}`}
      ORDER BY updated_at DESC, id DESC`.pipe(
      Effect.map((rows) => rows.map(toItem)),
      Effect.catchTags({ SqlError: io }),
    );

  const get: ItemStore["Service"]["get"] = (id) =>
    Effect.gen(function* () {
      const item = yield* row(id);
      if (item === undefined) return yield* notFound(id);
      const evidence = yield* sql<{
        readonly evidence_key: string;
        readonly summary: string;
        readonly created_at: string;
      }>`SELECT evidence_key, summary, created_at FROM learning_item_evidence
        WHERE item_id = ${id} ORDER BY created_at, rowid`;
      return {
        item: toItem(item),
        evidence: evidence.map((e) => ({
          evidenceKey: e.evidence_key,
          summary: e.summary,
          createdAt: e.created_at,
        })),
        promotions: yield* PromotionStore.forItem(id),
        reviews: yield* PromotionStore.reviewsForItem(id),
        outcomes: yield* PromotionStore.outcomesForItem(id),
      };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTags({ SqlError: io }));

  const deliveredAt: ItemStore["Service"]["deliveredAt"] = (projectId) =>
    sql<{
      readonly failure_mode: string;
      readonly delivered_at: string;
    }>`SELECT failure_mode, MIN(delivered_at) AS delivered_at FROM learning_promotions
      WHERE project_id = ${projectId} AND delivered_at IS NOT NULL
      GROUP BY failure_mode
      ORDER BY failure_mode`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ failureMode: row.failure_mode, deliveredAt: row.delivered_at })),
      ),
      Effect.catchTags({ SqlError: io }),
    );

  const deliveredIn: ItemStore["Service"]["deliveredIn"] = (input) =>
    PromotionStore.deliveredIn(input).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({ SqlError: io }),
    );

  const setDisposition: ItemStore["Service"]["setDisposition"] = ({ id, ownerKind, state }) =>
    Effect.gen(function* () {
      if (state === "promoted" || state === "candidate") {
        return yield* new LearningError({
          code: "invalid",
          message:
            state === "promoted"
              ? "State promoted is set by promotion"
              : "State candidate is set by the owner kind",
        });
      }
      const item = yield* row(id);
      if (item === undefined) return yield* notFound(id);
      const owner = ownerKind === undefined ? item.owner_kind : ownerKind;
      const closed = state === undefined ? item.state === "closed" : state === "closed";
      const turnedDown =
        owner === null
          ? false
          : (yield* sql<{ readonly state: string }>`SELECT state FROM learning_promotions
              WHERE project_id = ${item.project_id} AND failure_mode = ${item.failure_mode}
                AND owner_kind = ${owner}`).some(
              (record) => record.state === "rejected" || record.state === "rolled_back",
            );
      // A promoted item stays promoted until it is closed or handed to another owner kind.
      const next = closed
        ? "closed"
        : item.state === "promoted" && owner === item.owner_kind
          ? "promoted"
          : turnedDown
            ? "open"
            : routedState(owner);
      const at = DateTime.formatIso(yield* DateTime.now);
      const [updated] = yield* sql<Row>`UPDATE learning_items
        SET owner_kind = ${owner}, state = ${next}, disposition_by = 'person',
          disposition_at = ${at}, reason = 'Set by a person.', updated_at = ${at}
        WHERE id = ${id}
        RETURNING *`;
      return toItem(updated!);
    }).pipe(Effect.catchTags({ SqlError: io }));

  const promotion = (id: number) =>
    Effect.flatMap(PromotionStore.byId(id), (found) =>
      found === undefined
        ? Effect.fail(new LearningError({ code: "not_found", message: `No promotion ${id}.` }))
        : Effect.succeed(found),
    );
  const notIn = (found: LearningPromotion, wanted: string) =>
    new LearningError({
      code: "invalid",
      message: `Promotion ${found.id} is ${found.state.replaceAll("_", " ")}; only ${wanted}.`,
    });
  // The check and the conditional write share a transaction, so this answers only a write that
  // found the promotion moved anyway.
  const moved = (id: number) =>
    new LearningError({ code: "invalid", message: `Promotion ${id} changed meanwhile.` });

  const reviewPromotion: ItemStore["Service"]["reviewPromotion"] = (
    { promotionId, verdict, note },
    reviewer,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const found = yield* promotion(promotionId);
          if (found.proposedBy === reviewer) {
            return yield* new LearningError({
              code: "invalid",
              message:
                reviewer === "user"
                  ? `A person proposed promotion ${promotionId}, so someone else reviews it, such as an agent with learning_promotion_review.`
                  : `Promotion ${promotionId} was proposed by ${reviewer}, so someone else reviews it.`,
            });
          }
          if (found.state !== "in_review") {
            return yield* notIn(found, "one in review takes a verdict");
          }
          // An item a person closed or moved meanwhile no longer wants this handover; reopening
          // it with the same owner kind puts the handover back up for review.
          const item = yield* row(found.itemId);
          if (
            verdict === "adopt" &&
            (item?.state !== "candidate" || item.owner_kind !== found.ownerKind)
          ) {
            return yield* new LearningError({
              code: "invalid",
              message: `Promotion ${promotionId}'s item no longer waits for it; reopen the item with that owner kind to adopt it.`,
            });
          }
          const reviewed = yield* PromotionStore.review(
            found,
            { verdict, reviewer, note: note === undefined ? null : redact(note) },
            yield* DateTime.now,
          );
          return reviewed ?? (yield* moved(promotionId));
        }),
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTags({ SqlError: io }));

  const rollBackPromotion: ItemStore["Service"]["rollBackPromotion"] = ({ promotionId }, actor) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const found = yield* promotion(promotionId);
          if (found.state !== "adopted") return yield* notIn(found, "an adopted one rolls back");
          const rolledBack = yield* PromotionStore.rollBack(found, actor, yield* DateTime.now);
          return rolledBack ?? (yield* moved(promotionId));
        }),
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTags({ SqlError: io }));

  return ItemStore.of({
    strengthen,
    list,
    get,
    deliveredAt,
    deliveredIn,
    setDisposition,
    reviewPromotion,
    rollBackPromotion,
  });
});

export const layer = Layer.effect(ItemStore, make);
