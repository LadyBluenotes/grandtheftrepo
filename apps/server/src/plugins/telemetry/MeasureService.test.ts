import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  type RoutingEntry,
  type RoutingTiers,
  type TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as TierMapService from "../routing/TierMapService.ts";
import * as Fixtures from "./eventFixtures.ts";
import * as MeasureService from "./MeasureService.ts";
import { migrations } from "./migrations.ts";
import * as Reactor from "./reactor.ts";

// A real event sink on an in-memory core database, as reactor.test does.
const layerCore = SqlitePersistence.layerMemory;
const layerSink = EventSink.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCore,
      EventStore.layer.pipe(Layer.provideMerge(layerCore)),
      ProjectionStore.layer.pipe(Layer.provideMerge(layerCore)),
    ),
  ),
);
const layerTest = Layer.mergeAll(
  layerSink,
  ServerSettings.layerTest(),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-telemetry-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const window = {
  projectId: Fixtures.projectId,
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-08T00:00:00.000Z",
};

/** A thread of its own, accepted at noon, whose first run started two hours before. */
const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
  Fixtures.threadEvent("thread.created", {
    ...Fixtures.thread,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: Fixtures.threadId },
  }),
  Fixtures.runEvent("run.created", {
    ...Fixtures.run,
    startedAt: DateTime.makeUnsafe("2026-10-02T10:00:00.000Z"),
  }),
];

it.effect("measures wait for the reactor, and answer unavailable while it is still replaying", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "telemetry",
        filename: ":memory:",
        migrations,
      });
      // The reactor holds the first event until the test lets it go.
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const created = Reactor.handlers["thread.created"]!;
      const reactor = yield* PluginReactor.start({
        plugin: "telemetry",
        from: "start",
        handlers: {
          ...Reactor.handlers,
          "thread.created": (stored) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(created(stored)),
            ),
        },
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const measures = yield* MeasureService.make(reactor.drain).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      yield* (yield* EventSink.EventSinkV2).write({ events });
      yield* Deferred.await(entered);

      const waiting = yield* Effect.forkChild(measures(window));
      yield* TestClock.adjust("3 seconds");
      const replaying = yield* Fiber.join(waiting);
      assert.strictEqual(replaying.length, 16);
      assert.deepEqual(
        [...new Set(replaying.map((measure) => `${measure.state}: ${measure.missingReason}`))],
        ["unavailable: Telemetry is still replaying the event log."],
      );

      yield* Deferred.succeed(release, undefined);
      const caughtUp = yield* measures(window);
      const time = caughtUp.find((measure) => measure.measure === "time_to_accepted_outcome");
      assert.deepEqual([time?.state, time?.value, time?.sampleSize], ["ok", 7200, 1]);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("any failed replay makes every measure unavailable, until the failure is cleared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "telemetry",
        filename: ":memory:",
        migrations,
      });
      const reactor = yield* PluginReactor.start({
        plugin: "telemetry",
        from: "start",
        handlers: Reactor.handlers,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const measures = yield* MeasureService.make(reactor.drain).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      yield* (yield* EventSink.EventSinkV2).write({ events });

      // The reactor's own shape, as it keeps a failure it has given up on. The reactor retries
      // only rows under five attempts, so its retry at start cannot clear this one mid-test.
      yield* sql`INSERT INTO host_reactor_failure (sequence, type, attempts, last_error, failed_at)
        VALUES (1, 'thread.created', 5, 'database is locked', '2026-10-02T12:00:00.000Z')`;
      const failed = yield* measures(window);
      assert.strictEqual(failed.length, 16);
      assert.deepEqual(
        [...new Set(failed.map((measure) => `${measure.state}: ${measure.missingReason}`))],
        [
          "unavailable: 1 event(s) failed to replay into telemetry; retry them before reading measures.",
        ],
      );

      yield* sql`DELETE FROM host_reactor_failure`;
      const cleared = yield* measures(window);
      const time = cleared.find((measure) => measure.measure === "time_to_accepted_outcome");
      assert.deepEqual([time?.state, time?.value, time?.sampleSize], ["ok", 7200, 1]);
    }),
  ).pipe(Effect.provide(layerTest)),
);

/** The routing plugin's answer: `standard` on Codex's `test-model`, the other tiers on nothing. */
const tiers = (standard: RoutingEntry): RoutingTiers => {
  const state = (resolved: RoutingEntry | null) => ({
    resolved,
    source: resolved === null ? null : ("environment" as const),
    available: true,
    environment: resolved,
    project: null,
  });
  return { cheap: state(null), standard: state(standard), strong: state(null) };
};
const tierMap = TierMapService.TierMapService.of({
  get: () =>
    Effect.succeed(
      tiers({ providerInstanceId: ProviderInstanceId.make("codex"), model: "test-model" }),
    ),
  set: () => Effect.die("not used"),
});

/**
 * One thread with two runs in the window on the same model name: one on the Codex instance, which
 * read two files and wrote 100 and 300 output tokens, and one on a Claude instance, which read
 * one file twice and wrote 5000.
 */
const seedTwoInstances = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO telemetry_threads (thread_id, project_id, created_at)
      VALUES ('thread:1', ${window.projectId}, '2026-10-02T00:00:00.000Z')`;
    yield* sql`INSERT INTO telemetry_runs
        (run_id, thread_id, turn_id, ordinal, status, provider_instance_id, model, started_at,
         completed_at, event_sequence)
      VALUES
        ('run:codex', 'thread:1', 'message:1', 1, 'completed', 'codex', 'test-model',
          '2026-10-02T00:00:00.000Z', '2026-10-02T00:10:00.000Z', 1),
        ('run:claude', 'thread:1', 'message:2', 2, 'completed', 'claude', 'test-model',
          '2026-10-03T00:00:00.000Z', '2026-10-03T00:10:00.000Z', 2)`;
    yield* sql`INSERT INTO telemetry_tool_calls
        (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, status, event_sequence)
      VALUES
        ('item:1', 'run:codex', 'thread:1', 1, 'dynamic_tool', 'Read', 'src/a.ts', 'completed', 1),
        ('item:2', 'run:codex', 'thread:1', 2, 'dynamic_tool', 'Read', 'src/b.ts', 'completed', 1),
        ('item:3', 'run:claude', 'thread:1', 1, 'dynamic_tool', 'Read', 'src/a.ts', 'completed', 2),
        ('item:4', 'run:claude', 'thread:1', 2, 'dynamic_tool', 'Read', 'src/a.ts', 'completed', 2)`;
    yield* sql`INSERT INTO telemetry_turn_usage
        (provider_turn_id, thread_id, run_id, input_tokens, cached_input_tokens, output_tokens,
         usage_updated_at, recorded_at, event_sequence)
      VALUES
        ('turn:1', 'thread:1', 'run:codex', 1000, 0, 100, '2026-10-02T00:01:00.000Z',
          '2026-10-02T00:01:00.000Z', 1),
        ('turn:2', 'thread:1', 'run:codex', 1000, 0, 300, '2026-10-02T00:02:00.000Z',
          '2026-10-02T00:02:00.000Z', 1),
        ('turn:3', 'thread:1', 'run:claude', 1000, 0, 5000, '2026-10-03T00:01:00.000Z',
          '2026-10-03T00:01:00.000Z', 2)`;
  });

it.effect("with a tier, only the runs on the tier's provider instance and model count", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "telemetry",
        filename: ":memory:",
        migrations,
      });
      // The rows are seeded directly; the reactor has no event to replay over them.
      const reactor = yield* PluginReactor.start({
        plugin: "telemetry",
        from: "start",
        handlers: Reactor.handlers,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* seedTwoInstances(sql);
      const measures = yield* MeasureService.make(reactor.drain).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const summary = (result: TelemetryMeasuresResult, name: string) => {
        const measure = result.find((candidate) => candidate.measure === name);
        return [measure?.state, measure?.value, measure?.sampleSize];
      };

      const all = yield* measures(window);
      assert.deepEqual(summary(all, "repeated_reads"), ["ok", 0.25, 2]);
      assert.deepEqual(summary(all, "context_efficiency"), ["unavailable", null, 0]);

      const standard = yield* measures({ ...window, tier: "standard" }).pipe(
        Effect.provideService(TierMapService.TierMapService, tierMap),
      );
      assert.deepEqual(summary(standard, "repeated_reads"), ["ok", 0, 1]);
      assert.deepEqual(summary(standard, "context_efficiency"), ["ok", 200, 2]);

      const strong = yield* measures({ ...window, tier: "strong" }).pipe(
        Effect.provideService(TierMapService.TierMapService, tierMap),
      );
      assert.deepEqual(
        [...new Set(strong.map((measure) => `${measure.state}: ${measure.missingReason}`))],
        ["unavailable: The strong tier has no model."],
      );

      // The routing plugin is off: nothing says which runs a tier ran.
      const routingOff = yield* measures({ ...window, tier: "standard" });
      assert.strictEqual(routingOff.length, 16);
      assert.deepEqual(
        [...new Set(routingOff.map((measure) => `${measure.state}: ${measure.missingReason}`))],
        ["unavailable: Tiers come from the routing plugin, which is not running."],
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);
