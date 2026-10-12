import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
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
      assert.strictEqual(replaying.length, 14);
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
      assert.strictEqual(failed.length, 14);
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
