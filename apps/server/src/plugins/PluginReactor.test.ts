import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginDatabase from "./PluginDatabase.ts";
import * as PluginReactor from "./PluginReactor.ts";

// A real event sink on an in-memory core database, as FoundationPersistence.test does.
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

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

const threadCreated = (n: number, now: DateTime.Utc): OrchestrationV2DomainEvent => {
  const id = ThreadId.make(`thread:reactor-${n}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project:reactor"),
    title: `Thread ${n}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`event:reactor-${n}`),
    type: "thread.created",
    threadId: id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  };
};

const writeThreads = (from: number, count: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    return yield* sink.write({
      events: Array.from({ length: count }, (_, index) => threadCreated(from + index, now)),
    });
  });

/** The plugin database every reactor in a test shares, so a "restart" keeps the cursor. */
const pluginDatabase = Effect.map(
  PluginDatabase.open({ id: "reactor-test", filename: ":memory:", migrations: [] }),
  (opened) => opened.sql,
);

const seenIds = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ readonly event_id: string }>`SELECT event_id FROM seen ORDER BY rowid`, (rows) =>
    rows.map((row) => row.event_id),
  );

const cursorOf = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ readonly sequence: number }>`SELECT sequence FROM host_reactor_cursor WHERE id = 1`,
    (rows) => rows[0]?.sequence,
  );

class Refused extends Data.TaggedError("Refused")<{ readonly id: string }> {}

/** Records every handled event id in `seen`; fails while `failOn` names the event. */
const recording = (sql: SqlClient.SqlClient, failOn: Ref.Ref<string | null>) =>
  Effect.map(
    sql`CREATE TABLE IF NOT EXISTS seen (event_id TEXT NOT NULL)`,
    (): PluginReactor.Handlers<Refused | SqlError.SqlError> => ({
      "thread.created": (stored) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(failOn)) === stored.event.id) {
            return yield* new Refused({ id: stored.event.id });
          }
          yield* sql`INSERT INTO seen (event_id) VALUES (${stored.event.id})`;
        }),
    }),
  );

it.effect("handles an event exactly once across a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* pluginDatabase;
      const handlers = yield* recording(sql, yield* Ref.make<string | null>(null));
      yield* writeThreads(1, 1);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* PluginReactor.start({ plugin: "test", from: "start", handlers });
          yield* reactor.drain;
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* PluginReactor.start({ plugin: "test", from: "start", handlers });
          yield* reactor.drain;
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      assert.deepEqual(yield* seenIds(sql), ["event:reactor-1"]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("replays history from the start, or skips it from now", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeThreads(1, 3);
      for (const from of ["start", "now"] as const) {
        const sql = yield* pluginDatabase;
        const handlers = yield* recording(sql, yield* Ref.make<string | null>(null));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* PluginReactor.start({ plugin: "test", from, handlers });
            yield* reactor.drain;
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );
        assert.deepEqual(
          yield* seenIds(sql),
          from === "start" ? ["event:reactor-1", "event:reactor-2", "event:reactor-3"] : [],
        );
        assert.strictEqual(yield* cursorOf(sql), 3);
      }
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a failing handler stops nothing else and is retried", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* pluginDatabase;
      const failOn = yield* Ref.make<string | null>("event:reactor-2");
      const handlers = yield* recording(sql, failOn);
      yield* writeThreads(1, 3);
      const reactor = yield* PluginReactor.start({
        plugin: "test",
        from: "start",
        handlers,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* reactor.drain;
      assert.deepEqual(yield* seenIds(sql), ["event:reactor-1", "event:reactor-3"]);
      const failures = yield* sql<{
        readonly sequence: number;
        readonly attempts: number;
      }>`SELECT sequence, attempts FROM host_reactor_failure`;
      assert.deepEqual(failures, [{ sequence: 2, attempts: 1 }]);

      yield* reactor.retryFailed().pipe(Effect.provideService(SqlClient.SqlClient, sql));
      assert.deepEqual(
        (yield* sql<{
          readonly attempts: number;
        }>`SELECT attempts FROM host_reactor_failure`).map((row) => row.attempts),
        [2],
      );

      yield* Ref.set(failOn, null);
      yield* reactor.retryFailed().pipe(Effect.provideService(SqlClient.SqlClient, sql));
      assert.deepEqual(yield* seenIds(sql), [
        "event:reactor-1",
        "event:reactor-3",
        "event:reactor-2",
      ]);
      assert.deepEqual(yield* sql`SELECT sequence FROM host_reactor_failure`, []);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("saves the cursor every 256 events even with nothing to handle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* pluginDatabase;
      yield* writeThreads(1, 600);
      const reactor = yield* PluginReactor.start({
        plugin: "test",
        from: "start",
        handlers: {},
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* reactor.drain;
      assert.strictEqual(yield* cursorOf(sql), 512);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("clamps a cursor that is past the log", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* pluginDatabase;
      const handlers = yield* recording(sql, yield* Ref.make<string | null>(null));
      yield* writeThreads(1, 2);
      yield* sql`CREATE TABLE IF NOT EXISTS host_reactor_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
      yield* sql`INSERT INTO host_reactor_cursor (id, sequence) VALUES (1, 999)`;
      const reactor = yield* PluginReactor.start({
        plugin: "test",
        from: "start",
        handlers,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* reactor.drain;
      assert.strictEqual(yield* cursorOf(sql), 2);
      yield* writeThreads(3, 1);
      yield* reactor.drain;
      assert.deepEqual(yield* seenIds(sql), ["event:reactor-3"]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("runs onCursorCreated once, with the new cursor, and not on a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* pluginDatabase;
      yield* sql`CREATE TABLE created (cursor INTEGER NOT NULL)`;
      const onCursorCreated = Effect.flatMap(
        SqlClient.SqlClient,
        (client) =>
          client`INSERT INTO created (cursor) SELECT sequence FROM host_reactor_cursor WHERE id = 1`,
      ).pipe(Effect.asVoid);
      yield* writeThreads(1, 2);
      // A restart reads the saved cursor and runs nothing. With events in the log, `drain` waits
      // until the reactor has read or created its cursor.
      for (const _start of ["first", "restart"]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* PluginReactor.start({
              plugin: "test",
              from: "now",
              handlers: {},
              onCursorCreated,
            });
            yield* reactor.drain;
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );
      }
      assert.deepEqual(yield* sql`SELECT cursor FROM created`, [{ cursor: 2 }]);
    }),
  ).pipe(Effect.provide(layerSink)),
);
