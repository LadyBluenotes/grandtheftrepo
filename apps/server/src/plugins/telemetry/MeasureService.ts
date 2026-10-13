import { TelemetryError, type TelemetryMeasuresInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import type * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveModelAliases } from "../../usage/usageAggregation.ts";
import {
  createOverrideRateTable,
  parseRateTable,
  type RateTable,
} from "../../usage/usagePricing.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import * as ItemStore from "../learning/items/ItemStore.ts";
import * as VerdictStore from "../review/VerdictStore.ts";
import { computeMeasures, unavailableMeasures } from "./measures/index.ts";
import type { RunRow, ThreadRow, ToolCallRow, TurnUsageRow } from "./measures/input.ts";
import { readiness } from "./readiness.ts";

/** The LiteLLM rate snapshot the Usage page saves under the state directory. */
const RATES_FILE = "usage-model-rates.json";
const decodeRatesFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ document: Schema.Unknown })),
);
/** Where verdicts are read from: a thread's first verdict can predate the window. */
const EPOCH = DateTime.formatIso(DateTime.makeUnsafe(0));

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
 */
export const make = Effect.fn("MeasureService.make")(function* (
  caughtUp: Effect.Effect<void, EventSink.EventSinkV2Error>,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;

  // shortcut: UsageService keeps its rate table private, so this reads the snapshot it saves;
  // ask UsageService for the table if that file moves. Without one nothing prices, as on the
  // Usage page.
  const rates = fs.readFileString(path.join(stateDir, RATES_FILE)).pipe(
    Effect.flatMap(decodeRatesFile),
    Effect.map((file): RateTable => parseRateTable(file.document)),
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
      const unready = yield* readiness(caughtUp).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (unready !== null) return unavailableMeasures(unready);
      const { projectId } = input;
      const threads = yield* sql<ThreadRow>`
        SELECT * FROM telemetry_threads WHERE project_id = ${projectId}`;
      const runs = yield* sql<RunRow>`
        SELECT r.* FROM telemetry_runs r JOIN telemetry_threads t USING (thread_id)
        WHERE t.project_id = ${projectId}`;
      const toolCalls = yield* sql<ToolCallRow>`
        SELECT c.* FROM telemetry_tool_calls c JOIN telemetry_threads t USING (thread_id)
        WHERE t.project_id = ${projectId}`;
      const turnUsage = yield* sql<TurnUsageRow>`
        SELECT u.provider_turn_id, u.thread_id, u.run_id, u.input_tokens, u.cached_input_tokens,
          u.output_tokens
        FROM telemetry_turn_usage u JOIN telemetry_threads t USING (thread_id)
        WHERE t.project_id = ${projectId}`;
      // Read where the call runs: the learning and review plugins' stores are siblings, absent
      // while their plugin is off.
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
      const current = yield* settings.getSettings;
      return computeMeasures({
        ...window,
        threads,
        runs,
        toolCalls,
        turnUsage,
        corrections,
        deliveries,
        verdicts,
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
        ServerSettingsError: failWith(
          "Server settings, which hold custom model prices, could not be read.",
        ),
      }),
    );
});
