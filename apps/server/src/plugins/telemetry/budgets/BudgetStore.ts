import {
  type ProjectId,
  RoutingTier,
  type TelemetryBudget,
  type TelemetryBudgetEvent,
  type TelemetryBudgetEventsInput,
  type TelemetryBudgetsInput,
  type TelemetryBudgetsResult,
  type TelemetryBudgetsSetInput,
  TelemetryDirection,
  TelemetryError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { MEASURE_NAMES } from "../measures/index.ts";

interface BudgetRow {
  readonly id: number;
  readonly measure: string;
  readonly tier: RoutingTier;
  readonly threshold: number;
  readonly direction: TelemetryDirection;
  readonly project_id: ProjectId | null;
  readonly min_sample: number;
  readonly enabled: number;
}

interface EventRow {
  readonly id: number;
  readonly budget_id: number;
  readonly project_id: ProjectId;
  readonly kind: TelemetryBudgetEvent["kind"];
  readonly window_from: string;
  readonly window_to: string;
  readonly value: number;
  readonly threshold: number;
  readonly sample_size: number;
  readonly occurred_at: string;
}

const toBudget = (row: BudgetRow): TelemetryBudget => ({
  id: row.id,
  measure: row.measure,
  tier: row.tier,
  threshold: row.threshold,
  direction: row.direction,
  projectId: row.project_id,
  minSample: row.min_sample,
  enabled: row.enabled === 1,
});

const toEvent = (row: EventRow): TelemetryBudgetEvent => ({
  id: row.id,
  budgetId: row.budget_id,
  projectId: row.project_id,
  kind: row.kind,
  windowFrom: row.window_from,
  windowTo: row.window_to,
  value: row.value,
  threshold: row.threshold,
  sampleSize: row.sample_size,
  occurredAt: row.occurred_at,
});

const isTier = Schema.is(RoutingTier);
const isDirection = Schema.is(TelemetryDirection);

/** The budget `input` describes, or the first field it cannot have. */
const validate = (input: TelemetryBudgetsSetInput) => {
  const { measure, tier, threshold, direction, minSample } = input;
  if (!MEASURE_NAMES.has(measure)) return "measure";
  if (!isTier(tier)) return "tier";
  if (!Number.isFinite(threshold)) return "threshold";
  if (!isDirection(direction)) return "direction";
  if (!Number.isInteger(minSample) || minSample < 0) return "minSample";
  return { ...input, tier, direction };
};

/** One breach or recovery for the sweep to append; the budget supplies its id and threshold. */
type NewEvent = Omit<TelemetryBudgetEvent, "id" | "budgetId" | "threshold" | "occurredAt">;

/**
 * The plugin's budgets and the breaches and recoveries the budget sweep records. A budget's state
 * in a project is its newest event there: a breach until a recovery follows it.
 */
export class BudgetStore extends Context.Service<
  BudgetStore,
  {
    /**
     * Every budget with the newest event of each project it judges, oldest budget first; with
     * `projectId`, the budgets that judge that project, with its event alone.
     */
    readonly list: (
      input: TelemetryBudgetsInput,
    ) => Effect.Effect<TelemetryBudgetsResult, TelemetryError>;
    /** Adds a budget, or with `id` replaces that one; refuses a field it cannot have. */
    readonly set: (
      input: TelemetryBudgetsSetInput,
    ) => Effect.Effect<TelemetryBudget, TelemetryError>;
    /** Removes a budget and its events; succeeds when there is none. */
    readonly remove: (id: number) => Effect.Effect<void, TelemetryError>;
    /** A project's events that occurred in `[from, to)`, oldest first. */
    readonly events: (
      input: TelemetryBudgetEventsInput,
    ) => Effect.Effect<ReadonlyArray<TelemetryBudgetEvent>, TelemetryError>;
    /**
     * Appends one event for `budget`, dated now, only while the stored budget is still enabled
     * with the same terms; answers whether it did. A budget removed or edited while the sweep
     * measured it gets nothing.
     */
    readonly record: (
      budget: TelemetryBudget,
      event: NewEvent,
    ) => Effect.Effect<boolean, TelemetryError>;
  }
>()("t3/plugins/telemetry/budgets/BudgetStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const io = (cause: SqlError.SqlError) =>
    Effect.logWarning("telemetry: budget database operation failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new TelemetryError({ message: "The telemetry database could not be read or written." }),
        ),
      ),
    );

  const list: BudgetStore["Service"]["list"] = ({ projectId }) =>
    Effect.gen(function* () {
      const budgets = yield* sql<BudgetRow>`SELECT * FROM budgets
        ${projectId === undefined ? sql`` : sql`WHERE project_id IS NULL OR project_id = ${projectId}`}
        ORDER BY id`;
      const latest = yield* sql<EventRow>`SELECT * FROM budget_events WHERE id IN (
          SELECT MAX(id) FROM budget_events
          ${projectId === undefined ? sql`` : sql`WHERE project_id = ${projectId}`}
          GROUP BY budget_id, project_id)
        ORDER BY id`;
      return budgets.map((row) => {
        // A budget moved to one project keeps the others' events, which no longer count.
        const events = latest
          .filter(
            (event) =>
              event.budget_id === row.id &&
              (row.project_id === null || event.project_id === row.project_id),
          )
          .map(toEvent);
        return {
          ...toBudget(row),
          state: events.some((event) => event.kind === "breach") ? "breach" : "ok",
          latest: events,
        } as const;
      });
    }).pipe(Effect.catchTags({ SqlError: io }));

  const set: BudgetStore["Service"]["set"] = (input) =>
    Effect.gen(function* () {
      const budget = validate(input);
      if (typeof budget === "string") {
        return yield* new TelemetryError({ message: `Budget is invalid: ${budget}` });
      }
      const enabled = budget.enabled ? 1 : 0;
      const rows =
        budget.id === undefined
          ? yield* sql<BudgetRow>`INSERT INTO budgets
              (measure, tier, threshold, direction, project_id, min_sample, enabled)
            VALUES (${budget.measure}, ${budget.tier}, ${budget.threshold}, ${budget.direction},
              ${budget.projectId}, ${budget.minSample}, ${enabled})
            RETURNING *`
          : yield* sql<BudgetRow>`UPDATE budgets SET
              measure = ${budget.measure}, tier = ${budget.tier}, threshold = ${budget.threshold},
              direction = ${budget.direction}, project_id = ${budget.projectId},
              min_sample = ${budget.minSample}, enabled = ${enabled}
            WHERE id = ${budget.id}
            RETURNING *`;
      const row = rows[0];
      if (row === undefined) {
        return yield* new TelemetryError({ message: `Budget ${budget.id} does not exist.` });
      }
      return toBudget(row);
    }).pipe(Effect.catchTags({ SqlError: io }));

  const remove: BudgetStore["Service"]["remove"] = (id) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM budget_events WHERE budget_id = ${id}`;
          yield* sql`DELETE FROM budgets WHERE id = ${id}`;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: io }));

  const events: BudgetStore["Service"]["events"] = (input) =>
    Effect.gen(function* () {
      const from = DateTime.make(input.from);
      const to = DateTime.make(input.to);
      if (Option.isNone(from) || Option.isNone(to)) {
        return yield* new TelemetryError({
          message: "The range's from and to must be ISO instants.",
        });
      }
      const rows = yield* sql<EventRow>`SELECT * FROM budget_events
        WHERE project_id = ${input.projectId}
          AND occurred_at >= ${DateTime.formatIso(from.value)}
          AND occurred_at < ${DateTime.formatIso(to.value)}
        ORDER BY id`;
      return rows.map(toEvent);
    }).pipe(Effect.catchTags({ SqlError: io }));

  const record: BudgetStore["Service"]["record"] = (budget, event) =>
    Effect.gen(function* () {
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      // One statement, so the check and the insert cannot be split by a save or a removal.
      const inserted = yield* sql<{ readonly id: number }>`INSERT INTO budget_events
          (budget_id, project_id, kind, window_from, window_to, value, threshold, sample_size,
           occurred_at)
        SELECT id, ${event.projectId}, ${event.kind}, ${event.windowFrom}, ${event.windowTo},
          ${event.value}, threshold, ${event.sampleSize}, ${occurredAt}
        FROM budgets
        WHERE id = ${budget.id} AND enabled = 1 AND measure = ${budget.measure}
          AND tier = ${budget.tier} AND threshold = ${budget.threshold}
          AND direction = ${budget.direction} AND project_id IS ${budget.projectId}
          AND min_sample = ${budget.minSample}
        RETURNING id`;
      return inserted.length > 0;
    }).pipe(Effect.catchTags({ SqlError: io }));

  return BudgetStore.of({ list, set, remove, events, record });
});

export const layer = Layer.effect(BudgetStore, make);
