import {
  type LearningItem,
  type LearningItemDetail,
  type LearningItemsInput,
  type LearningItemsSetDispositionInput,
  LearningError,
  type LearningOwnerKind,
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
  reason: row.reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

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
     * A person sets the owner kind or closes and reopens the item. `promoted` comes only from
     * delivery and `candidate` only from the owner kind, so neither is accepted.
     */
    readonly setDisposition: (
      input: LearningItemsSetDispositionInput,
    ) => Effect.Effect<LearningItem, LearningError>;
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
          // disposition and nothing has been handed over.
          yield* sql`INSERT INTO learning_items
            (project_id, failure_mode, occurrences, state, owner_kind, disposition_by, reason,
             created_at, updated_at)
            VALUES (${projectId}, ${failureMode}, 0, ${rule.state}, ${rule.ownerKind}, 'rule',
             ${rule.reason}, ${at}, ${at})
            ON CONFLICT (project_id, failure_mode) DO UPDATE SET
              owner_kind = excluded.owner_kind, state = excluded.state, reason = excluded.reason
            WHERE learning_items.disposition_by = 'rule'
              AND learning_items.state IN ('open', 'candidate')`;
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
      };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTags({ SqlError: io }));

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
      // A promoted item stays promoted until it is closed or handed to another owner kind.
      const next = closed
        ? "closed"
        : item.state === "promoted" && owner === item.owner_kind
          ? "promoted"
          : routedState(owner);
      const at = DateTime.formatIso(yield* DateTime.now);
      const [updated] = yield* sql<Row>`UPDATE learning_items
        SET owner_kind = ${owner}, state = ${next}, disposition_by = 'person',
          reason = 'Set by a person.', updated_at = ${at}
        WHERE id = ${id}
        RETURNING *`;
      return toItem(updated!);
    }).pipe(Effect.catchTags({ SqlError: io }));

  return ItemStore.of({ strengthen, list, get, setDisposition });
});

export const layer = Layer.effect(ItemStore, make);
