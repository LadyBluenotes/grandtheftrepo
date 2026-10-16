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
import { adherence, unavailableAdherence } from "./adherence.ts";

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

/** A project's window with `from` and `to` as `DateTime.formatIso` strings, so they compare with `at`. */
const Window = Schema.Struct({ projectId: Schema.String, from: Schema.String, to: Schema.String });

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
 * `caughtUp` is the drain of the reactor that writes the observations. They trail the event log,
 * by all of it while the reactor replays from the first event, and the reactor also advances past
 * an event whose handler failed, leaving a row in `host_reactor_failure`; a ratio over rows
 * missing observations would look final. So a request waits for the reactor, and answers
 * `unavailable` with the reason when it is not caught up within `CATCH_UP_WAIT` or any event
 * failed. Only a read error fails.
 */
export const make = (caughtUp: Effect.Effect<void, EventSink.EventSinkV2Error>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // The window is applied here as well as in the fold, so a project's history before and after
    // it is never read. The rows are ordered by the (project_id, kind, at) index.
    const recommended = SqlSchema.findAll({
      Request: Window,
      Result: RecommendedRow,
      execute: ({ projectId, from, to }) =>
        sql`
          SELECT id, at, thread_id AS "threadId", tier, provider_instance_id AS "providerInstanceId",
            model
          FROM routing_events
          WHERE kind = 'routing_recommended' AND project_id = ${projectId} AND tier IS NOT NULL
            AND at >= ${from} AND at < ${to}
          ORDER BY at, id
        `,
    });
    // Only the observations of those recommendations.
    const observed = SqlSchema.findAll({
      Request: Window,
      Result: ObservedRow,
      execute: ({ projectId, from, to }) =>
        sql`
          SELECT observed.recommendation_id AS "recommendationId", observed.detail
          FROM routing_events AS recommended
          JOIN routing_events AS observed ON observed.recommendation_id = recommended.id
          WHERE recommended.kind = 'routing_recommended' AND recommended.project_id = ${projectId}
            AND recommended.at >= ${from} AND recommended.at < ${to}
            AND observed.kind = 'routing_observed'
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
          return unavailableAdherence("Routing is still reading the event log.");
        }
        const failures = yield* sql<{
          readonly failed: number;
        }>`SELECT COUNT(*) AS failed FROM host_reactor_failure`.pipe(Effect.catch(unreadable));
        const failed = failures[0]?.failed ?? 0;
        if (failed > 0) {
          return unavailableAdherence(
            `${failed} event(s) failed to replay into routing; retry them before reading adherence.`,
          );
        }
        const window = {
          projectId: input.projectId,
          from: DateTime.formatIso(from.value),
          to: DateTime.formatIso(to.value),
        };
        const rows = yield* recommended(window).pipe(Effect.catch(unreadable));
        return adherence({
          recommended: rows.map(({ providerInstanceId, model, ...row }) => ({
            ...row,
            entry:
              providerInstanceId === null || model === null ? null : { providerInstanceId, model },
          })),
          observed: yield* observed(window).pipe(Effect.catch(unreadable)),
          from: window.from,
          to: window.to,
        });
      }),
    });
  });
