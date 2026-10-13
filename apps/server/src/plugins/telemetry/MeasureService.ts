import {
  type ProjectId,
  type RoutingTier,
  TelemetryError,
  type TelemetryMeasuresInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import type * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveModelAliases } from "../../usage/usageAggregation.ts";
import { createOverrideRateTable, type RateTable } from "../../usage/usagePricing.ts";
import * as KnowledgeStore from "../knowledge/KnowledgeStore.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import * as ItemStore from "../learning/items/ItemStore.ts";
import * as VerdictStore from "../review/VerdictStore.ts";
import * as TierMapService from "../routing/TierMapService.ts";
import { computeMeasures, unavailableMeasures } from "./measures/index.ts";
import type { RunRow, ThreadRow, ToolCallRow, TurnUsageRow } from "./measures/input.ts";
import { rateSnapshot } from "./rates.ts";
import { readiness } from "./readiness.ts";

/** Where verdicts are read from: a thread's first verdict can predate the window. */
const EPOCH = DateTime.formatIso(DateTime.makeUnsafe(0));

/**
 * The tier's provider instance and model for the project, as the routing plugin resolves it now,
 * or why there is none. The routing plugin is a sibling, read where the call runs: absent while
 * it is off.
 */
const modelOf = (projectId: ProjectId, tier: RoutingTier) =>
  Effect.gen(function* () {
    const tierMap = yield* Effect.serviceOption(TierMapService.TierMapService);
    if (Option.isNone(tierMap)) return "Tiers come from the routing plugin, which is not running.";
    const { resolved } = (yield* tierMap.value.get({ projectId }))[tier];
    return resolved ?? `The ${tier} tier has no model.`;
  });

const failWith =
  (message: string) =>
  <E>(cause: E) =>
    Effect.logWarning("telemetry: measures could not be computed", { cause }).pipe(
      Effect.andThen(Effect.fail(new TelemetryError({ message }))),
    );

/**
 * Reads a window's rows from the plugin's tables and runs every measure over them. The queries
 * narrow only to the project; each measure picks its own rows by window, so the window logic is
 * all in the pure measures. Nothing is cached.
 *
 * `caughtUp` is the reactor's `drain`. Until `readiness` says the tables are complete, every
 * measure answers `unavailable` with its reason.
 *
 * With a `tier`, only the project's runs on that tier's model, as the routing plugin resolves it
 * now, count, with their tool calls and turn usage; threads all stay. A run is on the tier when
 * its provider instance and model are the tier's, so a model shared by two tiers counts for both.
 */
export const make = Effect.fn("MeasureService.make")(function* (
  caughtUp: Effect.Effect<void, EventSink.EventSinkV2Error>,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Optional so a test can build the service without it; the plugin's layer always has it.
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);

  /**
   * The project's directory, which the repeated work measures make paths relative to; null when
   * the project is gone or cannot be read, and the paths then stay as recorded.
   */
  const directoryOf = (projectId: ProjectId) =>
    Option.isNone(projects)
      ? Effect.succeed(null)
      : projects.value.getShell(projectId).pipe(
          Effect.map(Option.match({ onNone: () => null, onSome: (p) => p.workspaceRoot })),
          Effect.orElseSucceed(() => null),
        );

  // Without a snapshot nothing prices, as on the Usage page.
  const rates = rateSnapshot({ fs, path, stateDir }).read.pipe(
    Effect.orElseSucceed((): RateTable => new Map()),
  );

  return (input: TelemetryMeasuresInput) =>
    Effect.gen(function* () {
      const from = DateTime.make(input.from);
      const to = DateTime.make(input.to);
      if (Option.isNone(from) || Option.isNone(to)) {
        return yield* new TelemetryError({
          message: "The window's from and to must be ISO instants.",
        });
      }
      const window = { from: DateTime.formatIso(from.value), to: DateTime.formatIso(to.value) };
      const { projectId, tier } = input;
      const tierModel = tier === undefined ? undefined : yield* modelOf(projectId, tier);
      if (typeof tierModel === "string") return unavailableMeasures(tierModel);
      const unready = yield* readiness(caughtUp).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (unready !== null) return unavailableMeasures(unready);
      const threads = yield* sql<ThreadRow>`
        SELECT * FROM telemetry_threads WHERE project_id = ${projectId}`;
      const projectRuns = yield* sql<RunRow>`
        SELECT r.* FROM telemetry_runs r JOIN telemetry_threads t USING (thread_id)
        WHERE t.project_id = ${projectId}`;
      const projectToolCalls = yield* sql<ToolCallRow>`
        SELECT c.* FROM telemetry_tool_calls c JOIN telemetry_threads t USING (thread_id)
        WHERE t.project_id = ${projectId}`;
      const projectTurnUsage = yield* sql<TurnUsageRow>`
        SELECT u.provider_turn_id, u.thread_id, u.run_id, u.input_tokens, u.cached_input_tokens,
          u.output_tokens
        FROM telemetry_turn_usage u JOIN telemetry_threads t USING (thread_id)
        WHERE t.project_id = ${projectId}`;
      const runs =
        tierModel === undefined
          ? projectRuns
          : projectRuns.filter(
              (run) =>
                run.provider_instance_id === tierModel.providerInstanceId &&
                run.model === tierModel.model,
            );
      const runIds = new Set(runs.map((run) => run.run_id));
      const toolCalls =
        tierModel === undefined
          ? projectToolCalls
          : // A call with no run has no model, so no tier claims it.
            projectToolCalls.filter((call) => call.run_id !== null && runIds.has(call.run_id));
      const turnUsage =
        tierModel === undefined
          ? projectTurnUsage
          : projectTurnUsage.filter((turn) => turn.run_id !== null && runIds.has(turn.run_id));
      // Read where the call runs: the learning, review and knowledge plugins' stores are
      // siblings, absent while their plugin is off.
      const store = yield* Effect.serviceOption(CorrectionStore.CorrectionStore);
      const corrections = Option.isSome(store)
        ? yield* store.value.list({ projectId, ...window })
        : undefined;
      const items = yield* Effect.serviceOption(ItemStore.ItemStore);
      const deliveries = Option.isSome(items)
        ? yield* items.value.deliveredAt(projectId)
        : undefined;
      const verdictStore = yield* Effect.serviceOption(VerdictStore.VerdictStore);
      const verdicts = Option.isSome(verdictStore)
        ? yield* verdictStore.value.listWindow({ projectId, from: EPOCH, to: window.to })
        : undefined;
      const knowledge = yield* Effect.serviceOption(KnowledgeStore.KnowledgeStore);
      const knowledgePages = Option.isSome(knowledge)
        ? (yield* knowledge.value.list({ projectId, state: "accepted" })).length
        : undefined;
      const current = yield* settings.getSettings;
      return computeMeasures({
        ...window,
        tier,
        projectDirectory: yield* directoryOf(projectId),
        threads,
        runs,
        toolCalls,
        turnUsage,
        corrections,
        deliveries,
        verdicts,
        knowledgePages,
        pricing: {
          rates: yield* rates,
          overrides: createOverrideRateTable(current.usagePriceOverrides),
          aliases: resolveModelAliases(current.usageModelAliases),
        },
      });
    }).pipe(
      Effect.catchTags({
        SqlError: failWith("The telemetry database could not be read."),
        LearningError: failWith("The learning plugin's corrections or items could not be read."),
        ReviewVerdictError: failWith("The review plugin's verdicts could not be read."),
        KnowledgeError: failWith("The knowledge plugin's pages could not be read."),
        RoutingError: (error) => Effect.fail(new TelemetryError({ message: error.message })),
        ServerSettingsError: failWith(
          "Server settings, which hold custom model prices, could not be read.",
        ),
      }),
    );
});
