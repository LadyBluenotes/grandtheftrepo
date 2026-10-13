import {
  ProviderInstanceId,
  type RoutingAdherence,
  type RoutingAdherenceInput,
  RoutingError,
  RoutingObservedDetail,
  RoutingTier,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import type * as EventSink from "../../orchestration-v2/EventSink.ts";
import { adherence } from "./adherence.ts";

/** How long a request waits for the reactor to catch up before it gives up. */
const CATCH_UP_WAIT = Duration.seconds(3);

/**
 * What the plugin answers over RPC and MCP. Both transports read it with `Effect.serviceOption`:
 * it is in the server's context only while the plugin runs, and its absence is how they tell the
 * plugin is off.
 */
export class AdherenceService extends Context.Service<
  AdherenceService,
  {
    /** Whether the recommended model ran, over the recommendations made in a project's window. */
    readonly adherence: (
      input: RoutingAdherenceInput,
    ) => Effect.Effect<RoutingAdherence, RoutingError>;
  }
>()("t3/plugins/routing/AdherenceService") {}

/** For code outside the plugin's layer: the service when the plugin runs, else its own error. */
export const fromOption = Option.match({
  onNone: () => new RoutingError({ code: "inactive", message: 'Plugin "routing" is not running.' }),
  onSome: Effect.succeed<AdherenceService["Service"]>,
});

const RecommendedRow = Schema.Struct({
  id: Schema.Int,
  at: Schema.String,
  threadId: ThreadId,
  tier: RoutingTier,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(TrimmedNonEmptyString),
});

const ObservedRow = Schema.Struct({
  recommendationId: Schema.Int,
  detail: Schema.fromJsonString(RoutingObservedDetail),
});

const unreadable = (cause: unknown) =>
  Effect.logWarning("routing: adherence could not be computed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new RoutingError({ code: "io", message: "Could not read the routing events." })),
    ),
  );

/**
 * Reads a project's recommendation and observation rows and folds them over the window.
 * `caughtUp` is the drain of the reactor that writes the observations: they trail the event log,
 * by all of it while the reactor replays from the first event, and a ratio over half the rows
 * would look final, so a request waits for the reactor and gives up with an error when it is not
 * caught up within `CATCH_UP_WAIT`.
 */
export const make = (caughtUp: Effect.Effect<void, EventSink.EventSinkV2Error>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const recommended = SqlSchema.findAll({
      Request: Schema.String,
      Result: RecommendedRow,
      execute: (projectId) =>
        sql`
          SELECT id, at, thread_id AS "threadId", tier, provider_instance_id AS "providerInstanceId",
            model
          FROM routing_events
          WHERE kind = 'routing_recommended' AND project_id = ${projectId} AND tier IS NOT NULL
          ORDER BY at, id
        `,
    });
    const observed = SqlSchema.findAll({
      Request: Schema.String,
      Result: ObservedRow,
      execute: (projectId) =>
        sql`
          SELECT recommendation_id AS "recommendationId", detail
          FROM routing_events
          WHERE kind = 'routing_observed' AND project_id = ${projectId}
        `,
    });

    return AdherenceService.of({
      adherence: Effect.fn("AdherenceService.adherence")(function* (input: RoutingAdherenceInput) {
        const from = DateTime.make(input.from);
        const to = DateTime.make(input.to);
        if (Option.isNone(from) || Option.isNone(to)) {
          return yield* new RoutingError({
            code: "invalid",
            message: "The window's from and to must be ISO instants.",
          });
        }
        const inTime = yield* Effect.timeoutOption(caughtUp, CATCH_UP_WAIT).pipe(
          Effect.catch(unreadable),
        );
        if (Option.isNone(inTime)) {
          return yield* new RoutingError({
            code: "io",
            message: "Routing is still reading the event log; try again shortly.",
          });
        }
        const rows = yield* recommended(input.projectId).pipe(Effect.catch(unreadable));
        return adherence({
          recommended: rows.map(({ providerInstanceId, model, ...row }) => ({
            ...row,
            entry:
              providerInstanceId === null || model === null ? null : { providerInstanceId, model },
          })),
          observed: yield* observed(input.projectId).pipe(Effect.catch(unreadable)),
          from: DateTime.formatIso(from.value),
          to: DateTime.formatIso(to.value),
        });
      }),
    });
  });
