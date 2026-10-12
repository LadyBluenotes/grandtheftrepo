import {
  type ModelSelection,
  type OrchestratorMcpTarget,
  type ProjectId,
  type RoutingEntry,
  RoutingError,
  RoutingRecommendedDetail,
  type RoutingTaskClass,
  type RoutingTier,
  type RoutingTierReason,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { selectTier } from "./TierSelection.ts";
import * as TierMapService from "./TierMapService.ts";

/** What a launcher knows about the work it is about to launch or delegate. */
export interface Work {
  readonly projectId: ProjectId;
  readonly taskClass: RoutingTaskClass;
  /** Threads that earlier launches of the same work ran in. Their failed runs escalate the tier. */
  readonly earlierThreadIds: ReadonlyArray<ThreadId>;
  /** A tier a person set on the ticket; it wins over the rule and escalation. */
  readonly manualTier?: RoutingTier | undefined;
}

export interface Recommendation {
  readonly taskClass: RoutingTaskClass;
  readonly tier: RoutingTier;
  readonly reason: RoutingTierReason;
  readonly failedRuns: number;
  /** Null when the tier resolves to nothing or to an entry the catalog no longer offers. */
  readonly entry: RoutingEntry | null;
}

const encodeDetail = Schema.encodeEffect(Schema.fromJsonString(RoutingRecommendedDetail));

/**
 * Which tier and model a launch should use, and the record that it was given them. Launchers
 * outside the plugin go through `launch` and `delegate` below, which read this service optionally.
 */
export class TierSelectionService extends Context.Service<
  TierSelectionService,
  {
    /**
     * The tier `work` gets now, from its task class, the failed runs among its earlier threads
     * (`cancelled` and `interrupted` are not failures) and its manual tier, resolved through the
     * project's tier map.
     */
    readonly recommend: (work: Work) => Effect.Effect<Recommendation, RoutingError>;
    /**
     * Appends one `routing_recommended` event for the thread a launch returned. A failure is
     * logged, never raised: the launch it describes has already happened.
     */
    readonly record: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly recommendation: Recommendation;
    }) => Effect.Effect<void>;
  }
>()("t3/plugins/routing/TierSelectionService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tierMap = yield* TierMapService.TierMapService;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const failedRuns = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => runs.filter((run) => run.status === "failed").length),
      Effect.catch((cause) =>
        Effect.logWarning("routing: could not read an earlier launch's runs", {
          threadId,
          cause,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new RoutingError({
                code: "io",
                message: `Could not read the runs of thread "${threadId}".`,
              }),
            ),
          ),
        ),
      ),
    );

  const recommend = Effect.fn("TierSelectionService.recommend")(function* (work: Work) {
    let failed = 0;
    for (const threadId of work.earlierThreadIds) failed += yield* failedRuns(threadId);
    const { tier, reason } = selectTier({
      taskClass: work.taskClass,
      failedRuns: failed,
      manualTier: work.manualTier,
    });
    const state = (yield* tierMap.get({ projectId: work.projectId }))[tier];
    return {
      taskClass: work.taskClass,
      tier,
      reason,
      failedRuns: failed,
      entry: state.available ? state.resolved : null,
    } satisfies Recommendation;
  });

  const record: TierSelectionService["Service"]["record"] = ({
    projectId,
    threadId,
    recommendation,
  }) =>
    Effect.gen(function* () {
      const { taskClass, tier, reason, failedRuns, entry } = recommendation;
      const detail = yield* encodeDetail({ taskClass, failedRuns, reason });
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO routing_events
          (at, kind, project_id, thread_id, tier, provider_instance_id, model, detail)
        VALUES
          (${at}, 'routing_recommended', ${projectId}, ${threadId}, ${tier},
           ${entry?.providerInstanceId ?? null}, ${entry?.model ?? null}, ${detail})
      `;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("routing: recommendation not recorded", { threadId, cause }),
      ),
      Effect.withSpan("TierSelectionService.record"),
    );

  return TierSelectionService.of({ recommend, record });
});

export const layer = Layer.effect(TierSelectionService, make);

/**
 * Reads the service optionally: with `routing` off it is absent and `run` gets nothing, as before
 * the plugin. Otherwise `run` gets the recommended model in the launcher's own shape, or nothing
 * when no model resolves so the caller's model is inherited, and the thread it returns is recorded.
 */
const routed = <A, E, R, P>(
  work: Work,
  run: (selection: P | undefined) => Effect.Effect<A, E, R>,
  shape: (entry: RoutingEntry) => P,
  threadOf: (result: A) => ThreadId,
) =>
  Effect.flatMap(
    Effect.serviceOption(TierSelectionService),
    Option.match({
      onNone: () => run(undefined),
      onSome: (service) =>
        Effect.gen(function* () {
          const recommendation = yield* service.recommend(work);
          const { entry } = recommendation;
          const result = yield* run(entry === null ? undefined : shape(entry));
          yield* service.record({
            projectId: work.projectId,
            threadId: threadOf(result),
            recommendation,
          });
          return result;
        }),
    }),
  );

/** Starts a top-level thread as `t3_thread_launch` does, with the recommended `modelSelection`. */
export const launch = <A extends { readonly threadId: ThreadId }, E, R>(
  work: Work,
  run: (modelSelection: ModelSelection | undefined) => Effect.Effect<A, E, R>,
) =>
  routed(
    work,
    run,
    (entry) => ({ instanceId: entry.providerInstanceId, model: entry.model }),
    (result) => result.threadId,
  );

/** Runs a child agent as `delegate_task` does, with the recommended `target`. */
export const delegate = <A extends { readonly childThreadId: ThreadId }, E, R>(
  work: Work,
  run: (target: OrchestratorMcpTarget | undefined) => Effect.Effect<A, E, R>,
) =>
  routed(
    work,
    run,
    (entry) => ({ providerInstanceId: entry.providerInstanceId, model: entry.model }),
    (result) => result.childThreadId,
  );
