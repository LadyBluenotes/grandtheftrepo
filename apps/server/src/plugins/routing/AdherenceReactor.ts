import { type OrchestrationV2Run, RoutingObservedDetail } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type * as PluginReactor from "../PluginReactor.ts";

const encodeDetail = Schema.encodeSync(Schema.fromJsonString(RoutingObservedDetail));

/**
 * Compares a thread's first run with the model its launch was recommended and appends one
 * `routing_observed` row. The thread's first event for the run may be either type, and the
 * recommendation may be written just after it, so both run events try again until a row exists.
 * Once it does, a later run, or a model switch on the thread, never changes it: the unique index
 * on `recommendation_id` keeps one row per recommendation even if an event is replayed.
 */
const observe = ({
  event,
}: {
  readonly event: {
    readonly occurredAt: DateTime.Utc;
    readonly payload: OrchestrationV2Run;
  };
}) =>
  Effect.gen(function* () {
    const run = event.payload;
    if (run.ordinal !== 1) return;
    const sql = yield* SqlClient.SqlClient;
    const [recommendation] = yield* sql<{
      readonly id: number;
      readonly project_id: string;
      readonly tier: string;
      readonly provider_instance_id: string;
      readonly model: string;
    }>`
      SELECT id, project_id, tier, provider_instance_id, model
      FROM routing_events AS recommended
      WHERE kind = 'routing_recommended'
        AND thread_id = ${run.threadId}
        AND tier IS NOT NULL
        AND provider_instance_id IS NOT NULL
        AND model IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM routing_events AS observed
          WHERE observed.kind = 'routing_observed' AND observed.recommendation_id = recommended.id
        )
      ORDER BY id
      LIMIT 1
    `;
    if (recommendation === undefined) return;

    const observed = {
      providerInstanceId: run.providerInstanceId,
      model: run.modelSelection.model,
    };
    const base = { recommendationId: recommendation.id, observed };
    const detail = encodeDetail(
      observed.providerInstanceId === recommendation.provider_instance_id &&
        observed.model === recommendation.model
        ? { ...base, matched: true, flag: null }
        : {
            ...base,
            matched: false,
            flag: `Thread ${run.threadId} was recommended the ${recommendation.tier} tier but ran ${observed.model} on ${observed.providerInstanceId}.`,
          },
    );
    yield* sql`
      INSERT INTO routing_events
        (at, kind, project_id, thread_id, tier, provider_instance_id, model, recommendation_id,
         detail)
      VALUES
        (${DateTime.formatIso(event.occurredAt)}, 'routing_observed', ${recommendation.project_id},
         ${run.threadId}, ${recommendation.tier}, ${recommendation.provider_instance_id},
         ${recommendation.model}, ${recommendation.id}, ${detail})
      ON CONFLICT (recommendation_id) WHERE kind = 'routing_observed' DO NOTHING
    `;
  });

/** Both run events carry the whole run, so either can be the first the plugin sees. */
export const handlers: PluginReactor.Handlers<SqlError.SqlError> = {
  "run.created": observe,
  "run.updated": observe,
};
