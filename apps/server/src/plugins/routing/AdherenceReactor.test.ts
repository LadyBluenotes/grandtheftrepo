import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RoutingObservedDetail,
  RoutingRecommendedDetail,
  RunId,
  type RoutingEntry,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as AdherenceReactor from "./AdherenceReactor.ts";
import * as AdherenceService from "./AdherenceService.ts";
import { migrations } from "./migrations.ts";

// A real event sink on an in-memory core database, as the telemetry reactor test does.
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

const projectId = ProjectId.make("project:routing");
const alpha: RoutingEntry = { providerInstanceId: ProviderInstanceId.make("alpha"), model: "a-3" };
const beta: RoutingEntry = { providerInstanceId: ProviderInstanceId.make("beta"), model: "b-1" };
const window = { projectId, from: "2026-10-01T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" };
const at = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");

const encodeRecommended = Schema.encodeSync(Schema.fromJsonString(RoutingRecommendedDetail));
const decodeObserved = Schema.decodeSync(Schema.fromJsonString(RoutingObservedDetail));

/** A `routing_recommended` row as `TierSelectionService.record` appends it. */
const recommend = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  entry: RoutingEntry | null = alpha,
  options: { readonly project?: ProjectId; readonly time?: string } = {},
) =>
  sql`
    INSERT INTO routing_events
      (at, kind, project_id, thread_id, tier, provider_instance_id, model, detail)
    VALUES
      (${options.time ?? DateTime.formatIso(at)}, 'routing_recommended',
       ${options.project ?? projectId}, ${threadId}, 'cheap', ${entry?.providerInstanceId ?? null},
       ${entry?.model ?? null},
       ${encodeRecommended({ taskClass: "mechanical", failedRuns: 0, reason: "rule" })})
  `;

const run = (threadId: ThreadId, ordinal: number, entry: RoutingEntry): OrchestrationV2Run => ({
  id: RunId.make(`run:${threadId}:${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: entry.providerInstanceId,
  modelSelection: { instanceId: entry.providerInstanceId, model: entry.model },
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${threadId}:${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  checkpointId: null,
  contextHandoffId: null,
});

let eventCount = 0;
const runEvent = (
  type: "run.created" | "run.updated",
  payload: OrchestrationV2Run,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:routing-${++eventCount}`),
  type,
  threadId: payload.threadId,
  runId: payload.id,
  providerInstanceId: payload.providerInstanceId,
  occurredAt: at,
  payload,
});

const publish = (...events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({ events });
  });

const thread = (n: number) => ThreadId.make(`thread:routing-${n}`);

/** The plugin's database with its real migrations, a reactor over the shared sink, and the service. */
const boot = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "routing", filename: ":memory:", migrations });
  const reactor = yield* PluginReactor.start({
    plugin: "routing",
    from: "start",
    handlers: AdherenceReactor.handlers,
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const service = yield* AdherenceService.make(reactor.drain).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  return { sql, drain: reactor.drain, service };
});

const observedRows = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{
      readonly at: string;
      readonly project_id: string;
      readonly thread_id: string;
      readonly tier: string;
      readonly provider_instance_id: string;
      readonly model: string;
      readonly recommendation_id: number;
      readonly detail: string;
    }>`SELECT at, project_id, thread_id, tier, provider_instance_id, model, recommendation_id, detail
       FROM routing_events WHERE kind = 'routing_observed' ORDER BY recommendation_id`,
    (rows) => rows.map(({ detail, ...row }) => ({ ...row, detail: decodeObserved(detail) })),
  );

it.effect("a thread's first run is compared with its recommendation, one row each", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain, service } = yield* boot;
      // Five launches in the project: four ran as recommended, thread 5 ran beta's model.
      for (const n of [1, 2, 3, 4, 5]) yield* recommend(sql, thread(n));
      // Another project's launch never reaches this project's answer.
      yield* recommend(sql, thread(6), alpha, { project: ProjectId.make("project:other") });
      yield* publish(
        ...[1, 2, 3, 4].map((n) => runEvent("run.created", run(thread(n), 1, alpha))),
        runEvent("run.created", run(thread(5), 1, beta)),
        runEvent("run.created", run(thread(6), 1, alpha)),
      );
      yield* drain;

      const rows = yield* observedRows(sql);
      assert.lengthOf(rows, 6);
      assert.deepEqual(rows[4], {
        at: DateTime.formatIso(at),
        project_id: projectId,
        thread_id: thread(5),
        tier: "cheap",
        provider_instance_id: "alpha",
        model: "a-3",
        recommendation_id: 5,
        detail: {
          recommendationId: 5,
          observed: beta,
          matched: false,
          flag: `Thread ${thread(5)} was recommended the cheap tier but ran b-1 on beta.`,
        },
      });
      assert.deepEqual(
        rows.slice(0, 4).map((row) => [row.detail.matched, row.detail.flag]),
        [1, 2, 3, 4].map(() => [true, null]),
      );

      const report = yield* service.adherence(window);
      assert.strictEqual(report.measure.state, "ok");
      assert.strictEqual(report.measure.value, 0.8);
      assert.strictEqual(report.measure.sampleSize, 5);
      assert.deepEqual(report.mismatches, [
        {
          threadId: thread(5),
          tier: "cheap",
          recommended: alpha,
          observed: beta,
          at: DateTime.formatIso(at),
          flag: `Thread ${thread(5)} was recommended the cheap tier but ran b-1 on beta.`,
        },
      ]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("either run event can be the first, and handling the same events again adds no row", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* boot;
      yield* recommend(sql, thread(1));
      yield* recommend(sql, thread(2));
      yield* publish(
        runEvent("run.created", run(thread(1), 1, alpha)),
        runEvent("run.updated", run(thread(1), 1, alpha)),
        runEvent("run.updated", run(thread(2), 1, alpha)),
      );
      yield* drain;
      const before = yield* observedRows(sql);
      assert.deepEqual(
        before.map((row) => row.thread_id),
        [thread(1), thread(2)],
      );

      // A reactor with no cursor reads the whole log again, as after a restore of an older copy.
      yield* sql`DELETE FROM host_reactor_cursor`;
      yield* Effect.scoped(
        Effect.flatMap(
          PluginReactor.start({
            plugin: "routing",
            from: "start",
            handlers: AdherenceReactor.handlers,
          }),
          (replay) => replay.drain,
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      assert.deepEqual(yield* observedRows(sql), before);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect(
  "the index keeps one observed row per recommendation and leaves recommendations alone",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql } = yield* boot;
        const insert = (kind: string, recommendationId: number | null) =>
          sql`INSERT INTO routing_events (at, kind, project_id, thread_id, detail, recommendation_id)
            VALUES ('2026-10-05T12:00:00.000Z', ${kind}, ${projectId}, 'thread:x', '{}',
                    ${recommendationId})`;
        yield* insert("routing_recommended", null);
        yield* insert("routing_recommended", null);
        yield* insert("routing_observed", 1);
        const second = yield* Effect.flip(insert("routing_observed", 1));
        assert.strictEqual(second._tag, "SqlError");
        assert.lengthOf(yield* sql`SELECT id FROM routing_events`, 3);
      }),
    ).pipe(Effect.provide(layerSink)),
);

it.effect("a recommendation without a model is not observed or counted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain, service } = yield* boot;
      yield* recommend(sql, thread(1), null);
      yield* publish(runEvent("run.created", run(thread(1), 1, beta)));
      yield* drain;

      assert.deepEqual(yield* observedRows(sql), []);
      assert.strictEqual((yield* service.adherence(window)).measure.sampleSize, 0);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a recommendation whose thread has not run is left out, then counted once it has", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain, service } = yield* boot;
      for (const n of [1, 2, 3, 4, 5]) yield* recommend(sql, thread(n));
      yield* publish(...[1, 2, 3, 4].map((n) => runEvent("run.created", run(thread(n), 1, alpha))));
      yield* drain;

      const waiting = yield* service.adherence(window);
      assert.strictEqual(waiting.measure.state, "unavailable");
      assert.strictEqual(waiting.measure.sampleSize, 4);
      assert.strictEqual(
        waiting.measure.missingReason,
        "Needs at least 5 observed launches in this window; found 4.",
      );

      yield* publish(runEvent("run.created", run(thread(5), 1, alpha)));
      yield* drain;
      const counted = yield* service.adherence(window);
      assert.strictEqual(counted.measure.state, "ok");
      assert.strictEqual(counted.measure.value, 1);
      assert.strictEqual(counted.measure.sampleSize, 5);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("recommendations outside the window, and their observations, are never read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain, service } = yield* boot;
      for (const n of [1, 2, 3, 4, 5]) yield* recommend(sql, thread(n));
      yield* publish(
        ...[1, 2, 3, 4, 5].map((n) => runEvent("run.created", run(thread(n), 1, alpha))),
      );
      yield* drain;

      // Rows the report cannot decode, recommended just before `from` and exactly at `to`, whose
      // observations were written inside the window. Reading either would fail the request.
      for (const time of ["2026-09-30T23:59:59.999Z", window.to]) {
        const [outside] = yield* sql<{ readonly id: number }>`
          INSERT INTO routing_events (at, kind, project_id, thread_id, tier, detail)
          VALUES (${time}, 'routing_recommended', ${projectId}, 'thread:outside', 'unreadable', '{}')
          RETURNING id`;
        yield* sql`
          INSERT INTO routing_events (at, kind, project_id, thread_id, recommendation_id, detail)
          VALUES ('2026-10-05T12:00:00.000Z', 'routing_observed', ${projectId}, 'thread:outside',
                  ${outside!.id}, 'not json')`;
      }

      const report = yield* service.adherence(window);
      assert.strictEqual(report.measure.value, 1);
      assert.strictEqual(report.measure.sampleSize, 5);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a run seen before its recommendation exists is observed by the run's next event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* boot;
      // The launch returns, and its run starts, before `record` appends the recommendation.
      yield* publish(runEvent("run.created", run(thread(1), 1, alpha)));
      yield* drain;
      assert.deepEqual(yield* observedRows(sql), []);

      yield* recommend(sql, thread(1));
      yield* publish(runEvent("run.updated", run(thread(1), 1, alpha)));
      yield* drain;
      assert.lengthOf(yield* observedRows(sql), 1);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a later run or model switch leaves the first run's row as it was", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* boot;
      yield* recommend(sql, thread(1));
      // Thread 2 is only ever seen on its second run.
      yield* recommend(sql, thread(2));
      yield* publish(
        runEvent("run.created", run(thread(1), 1, alpha)),
        runEvent("run.created", run(thread(2), 2, beta)),
      );
      yield* drain;
      const first = yield* observedRows(sql);
      assert.deepEqual(
        first.map((row) => [row.thread_id, row.detail.matched]),
        [[thread(1), true]],
      );

      yield* publish(
        runEvent("run.created", run(thread(1), 2, beta)),
        runEvent("run.updated", run(thread(1), 2, beta)),
        // The first run's own record changing its model later does not rewrite the row either.
        runEvent("run.updated", run(thread(1), 1, beta)),
      );
      yield* drain;
      assert.deepEqual(yield* observedRows(sql), first);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a window that is not ISO instants is refused, and offsets are read as UTC", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain, service } = yield* boot;
      const refused = yield* Effect.flip(service.adherence({ ...window, from: "last week" }));
      assert.strictEqual(refused.code, "invalid");
      assert.strictEqual(refused.message, "The window's from and to must be ISO instants.");

      yield* recommend(sql, thread(1), alpha, { time: "2026-10-01T00:00:00.000Z" });
      yield* publish(runEvent("run.created", run(thread(1), 1, alpha)));
      yield* drain;
      const report = (from: string) => service.adherence({ ...window, from });
      assert.strictEqual((yield* report("2026-10-01T02:00:00.000+02:00")).measure.sampleSize, 1);
      assert.strictEqual((yield* report("2026-10-01T00:00:00.001Z")).measure.sampleSize, 0);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a request the reactor has not caught up for answers unavailable, not a ratio", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "routing",
        filename: ":memory:",
        migrations,
      });
      const service = yield* AdherenceService.make(Effect.never).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const call = yield* Effect.forkChild(service.adherence(window));
      yield* TestClock.adjust("3 seconds");
      const report = yield* Fiber.join(call);
      assert.strictEqual(report.measure.state, "unavailable");
      assert.strictEqual(report.measure.value, null);
      assert.strictEqual(report.measure.missingReason, "Routing is still reading the event log.");
      assert.deepEqual(report.mismatches, []);
    }),
  ),
);

it.effect("an event that failed to replay makes the answer unavailable until it is retried", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain, service } = yield* boot;
      for (const n of [1, 2, 3, 4, 5]) yield* recommend(sql, thread(n));
      yield* publish(
        ...[1, 2, 3, 4].map((n) => runEvent("run.created", run(thread(n), 1, alpha))),
        runEvent("run.created", run(thread(5), 1, beta)),
      );
      yield* drain;
      assert.strictEqual((yield* service.adherence(window)).measure.state, "ok");

      // The reactor advances past an event whose handler failed and keeps it here for a retry.
      yield* sql`INSERT INTO host_reactor_failure (sequence, type, attempts, last_error, failed_at)
        VALUES (1, 'run.created', 1, 'boom', '2026-10-05T12:00:00.000Z')`;
      const failed = yield* service.adherence(window);
      assert.strictEqual(failed.measure.state, "unavailable");
      assert.strictEqual(failed.measure.value, null);
      assert.strictEqual(
        failed.measure.missingReason,
        "1 event(s) failed to replay into routing; retry them before reading adherence.",
      );
      // Thread 5's mismatch is in the rows, but a list from incomplete rows is not offered either.
      assert.deepEqual(failed.mismatches, []);

      yield* sql`DELETE FROM host_reactor_failure`;
      const retried = yield* service.adherence(window);
      assert.strictEqual(retried.measure.value, 0.8);
      assert.lengthOf(retried.mismatches, 1);
    }),
  ).pipe(Effect.provide(layerSink)),
);
