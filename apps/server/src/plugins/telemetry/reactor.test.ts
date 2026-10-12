import { assert, it } from "@effect/vitest";
import {
  type CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurnTokenUsage,
  RunId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as Fixtures from "./eventFixtures.ts";
import { input } from "./measures/fixtures.ts";
import { acceptedOutcomes, type ThreadRow } from "./measures/input.ts";
import { migrations } from "./migrations.ts";
import * as Reactor from "./reactor.ts";

// A real event sink on an in-memory core database, as PluginReactor.test does.
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

const full = Fixtures.usage;

const write = (events: ReadonlyArray<OrchestrationV2DomainEvent>, commandId?: CommandId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write(commandId === undefined ? { events } : { events, commandId });
  });

const writeUsage = (...usages: ReadonlyArray<OrchestrationV2ProviderTurnTokenUsage | undefined>) =>
  write(usages.map(Fixtures.turnUpdated));

const usageRows = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly provider_turn_id: string;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly input_tokens: number | null;
    readonly cached_input_tokens: number | null;
    readonly output_tokens: number | null;
    readonly reasoning_output_tokens: number | null;
    readonly usage_updated_at: string;
  }>`SELECT provider_turn_id, thread_id, run_id, input_tokens, cached_input_tokens, output_tokens,
    reasoning_output_tokens, usage_updated_at FROM telemetry_turn_usage`;

const startReactor = (
  sql: SqlClient.SqlClient,
  handlers: PluginReactor.Handlers<SqlError.SqlError>,
) =>
  Effect.scoped(
    Effect.flatMap(
      PluginReactor.start({ plugin: "telemetry", from: "start", handlers }),
      (reactor) => reactor.drain,
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  );

/**
 * The plugin's database with its real migrations. Each `drain` starts a new reactor over that
 * database and the shared event sink and waits until it is caught up, so a second one is a restart.
 */
const react = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "telemetry", filename: ":memory:", migrations });
  return { sql, drain: startReactor(sql, Reactor.handlers) };
});

it.effect("records every reported counter once per provider turn, latest report wins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      yield* writeUsage(full);
      yield* drain;
      assert.deepEqual(yield* usageRows(sql), [
        {
          provider_turn_id: Fixtures.providerTurnId,
          thread_id: Fixtures.threadId,
          run_id: Fixtures.runId,
          input_tokens: 4000,
          cached_input_tokens: 3000,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          usage_updated_at: full.updatedAt,
        },
      ]);

      yield* writeUsage({ ...full, inputTokens: 5000, updatedAt: "2026-10-12T00:00:01.000Z" });
      yield* drain;
      const replaced = yield* usageRows(sql);
      assert.strictEqual(replaced.length, 1);
      assert.strictEqual(replaced[0]?.input_tokens, 5000);
      assert.strictEqual(replaced[0]?.usage_updated_at, "2026-10-12T00:00:01.000Z");
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("writes nothing without tokenUsage and NULL for a counter the provider left out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      yield* writeUsage(undefined);
      yield* drain;
      assert.deepEqual(yield* usageRows(sql), []);

      const { cachedInputTokens: _omitted, ...withoutCache } = full;
      yield* writeUsage(withoutCache);
      yield* drain;
      const [row] = yield* usageRows(sql);
      assert.strictEqual(row?.cached_input_tokens, null);
      assert.strictEqual(row?.input_tokens, 4000);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a restarted reactor over the same database replays nothing it already handled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      yield* writeUsage(full, { ...full, outputTokens: 200 });
      yield* drain;
      assert.strictEqual((yield* usageRows(sql)).length, 1);

      // An upsert hides a replay, so empty the table: only a replayed event could refill it.
      yield* sql`DELETE FROM telemetry_turn_usage`;
      yield* drain;
      assert.deepEqual(yield* usageRows(sql), []);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("an older report for a turn never replaces a newer one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const newer = { ...full, inputTokens: 5000, updatedAt: "2026-10-12T00:00:01.000Z" };
      yield* writeUsage(newer);
      yield* drain;
      yield* writeUsage(full);
      yield* drain;
      const [row] = yield* usageRows(sql);
      assert.strictEqual(row?.input_tokens, 5000);
      assert.strictEqual(row?.usage_updated_at, newer.updatedAt);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("keeps one row per run with its latest state, and a replay adds nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const running = { ...Fixtures.run, status: "running" as const, completedAt: null };
      yield* write([Fixtures.runEvent("run.created", running), Fixtures.runEvent("run.updated")]);
      yield* drain;
      const expected = {
        run_id: Fixtures.runId,
        thread_id: Fixtures.threadId,
        turn_id: "message:telemetry",
        ordinal: 2,
        status: "failed",
        model: "test-model",
        started_at: DateTime.formatIso(Fixtures.at),
        completed_at: DateTime.formatIso(Fixtures.at),
      };
      assert.deepEqual(yield* sql`SELECT * FROM telemetry_runs`, [expected]);

      yield* write([Fixtures.runEvent("run.updated")]);
      yield* drain;
      assert.deepEqual(yield* sql`SELECT * FROM telemetry_runs`, [expected]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("keeps one row per tool call with its path, skipping other items and runless ones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const items = [
        Fixtures.itemEvent(Fixtures.readItem),
        Fixtures.itemEvent(Fixtures.editItem),
        Fixtures.itemEvent({
          ...Fixtures.readItem,
          id: TurnItemId.make("item:runless"),
          runId: null,
        }),
        Fixtures.itemEvent(Fixtures.noticeItem),
      ];
      yield* write(items);
      yield* drain;
      const expected = [
        {
          item_id: "item:edit",
          run_id: Fixtures.runId,
          thread_id: Fixtures.threadId,
          ordinal: 2,
          item_type: "file_change",
          tool_name: null,
          path: "src/a.ts",
          status: "failed",
        },
        {
          item_id: "item:read",
          run_id: Fixtures.runId,
          thread_id: Fixtures.threadId,
          ordinal: 1,
          item_type: "dynamic_tool",
          tool_name: "Read",
          path: "src/a.ts",
          status: "failed",
        },
      ];
      // The sink renumbers item ordinals into positions in the thread, keeping their order.
      const rows = sql`SELECT * FROM telemetry_tool_calls ORDER BY item_id`;
      assert.deepEqual(yield* rows, expected);

      yield* write([Fixtures.itemEvent(Fixtures.readItem), Fixtures.itemEvent(Fixtures.editItem)]);
      yield* drain;
      assert.deepEqual(yield* rows, expected);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("keeps one row per thread with its latest settle and reopen and who settled it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const created = {
        ...Fixtures.thread,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        pullRequests: [],
      };
      yield* write([Fixtures.threadEvent("thread.created", created)]);
      yield* write([Fixtures.threadEvent("thread.settled")], Fixtures.sweepCommandId);
      yield* drain;
      const settled = {
        thread_id: Fixtures.threadId,
        project_id: Fixtures.projectId,
        created_at: "2026-10-02T08:00:00.000Z",
        parent_thread_id: "thread:parent",
        settled_at: "2026-10-02T12:00:00.000Z",
        settled_by_sweep: 1,
        unsettled_at: "2026-10-02T09:30:00.000Z",
        pull_request_merged_at: "2026-10-02T10:00:00.000Z",
      };
      const rows = sql`SELECT * FROM telemetry_threads`;
      assert.deepEqual(yield* rows, [settled]);

      // A reopen clears the thread's settledAt; the row keeps the settle it reopened.
      const reopenedAt = DateTime.makeUnsafe("2026-10-02T13:00:00.000Z");
      yield* write([
        Fixtures.threadEvent("thread.unsettled", {
          ...Fixtures.thread,
          settledOverride: "active",
          settledAt: null,
          unsettledAt: reopenedAt,
        }),
      ]);
      yield* drain;
      const reopened = { ...settled, unsettled_at: DateTime.formatIso(reopenedAt) };
      assert.deepEqual(yield* rows, [reopened]);

      // A fork's parent is not a delegating parent.
      yield* write([
        Fixtures.threadEvent("thread.created", {
          ...created,
          lineage: { ...created.lineage, relationshipToParent: "fork" },
        }),
      ]);
      yield* drain;
      assert.deepEqual(yield* rows, [reopened]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

// A top-level thread, so it can be an accepted outcome, and its states as the commands leave it.
const topLevel = {
  ...Fixtures.thread,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: Fixtures.threadId },
  pullRequests: [],
};
const active = { ...topLevel, settledOverride: null, settledAt: null, unsettledAt: null };
const settledBy = (settledAt: string) => ({
  ...topLevel,
  settledOverride: "settled" as const,
  settledAt: DateTime.makeUnsafe(settledAt),
  unsettledAt: null,
});
/** What `thread.pin` leaves of a settled thread: reopened, with no `unsettledAt` stamped. */
const pinnedAt = (at: string) =>
  Fixtures.threadEvent(
    "thread.pinned",
    { ...active, settledOverride: "active", pinnedAt: DateTime.makeUnsafe(at) },
    DateTime.makeUnsafe(at),
  );

it.effect("a pin reopens a thread whose latest settle is still standing, and nothing else", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const row = Effect.map(sql<ThreadRow>`SELECT * FROM telemetry_threads`, (rows) => [
        rows[0]?.settled_at,
        rows[0]?.unsettled_at,
      ]);

      // Never settled: nothing to reopen.
      yield* write([
        Fixtures.threadEvent("thread.created", active),
        pinnedAt("2026-10-02T11:00:00.000Z"),
      ]);
      yield* drain;
      assert.deepEqual(yield* row, [null, null]);

      yield* write([Fixtures.threadEvent("thread.settled", settledBy("2026-10-02T12:00:00.000Z"))]);
      yield* write([pinnedAt("2026-10-03T00:00:00.000Z")]);
      yield* drain;
      assert.deepEqual(yield* row, ["2026-10-02T12:00:00.000Z", "2026-10-03T00:00:00.000Z"]);

      // Already reopened since that settle: a later pin is not another reopen.
      yield* write([pinnedAt("2026-10-04T00:00:00.000Z")]);
      yield* drain;
      assert.deepEqual(yield* row, ["2026-10-02T12:00:00.000Z", "2026-10-03T00:00:00.000Z"]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a thread settled, pinned, settled and pinned again is accepted only while settled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const rows = sql<ThreadRow>`SELECT * FROM telemetry_threads`;
      const acceptedIds = Effect.map(rows, (threads) =>
        acceptedOutcomes(input({ threads })).map((thread) => thread.thread_id),
      );

      yield* write([Fixtures.threadEvent("thread.created", active)]);
      yield* write([Fixtures.threadEvent("thread.settled", settledBy("2026-10-02T12:00:00.000Z"))]);
      yield* drain;
      assert.deepEqual(yield* acceptedIds, [Fixtures.threadId]);

      // The pin reopens it; no `thread.unsettled` is emitted.
      yield* write([pinnedAt("2026-10-03T00:00:00.000Z")]);
      yield* drain;
      assert.deepEqual(yield* acceptedIds, []);

      yield* write([Fixtures.threadEvent("thread.settled", settledBy("2026-10-05T00:00:00.000Z"))]);
      yield* drain;
      assert.deepEqual(yield* acceptedIds, [Fixtures.threadId]);

      yield* write([pinnedAt("2026-10-06T00:00:00.000Z")]);
      yield* drain;
      assert.deepEqual(yield* acceptedIds, []);

      // Replaying the whole log from its first event lands on the same row.
      const before = yield* rows;
      yield* sql`DELETE FROM host_reactor_cursor`;
      yield* drain;
      assert.deepEqual(yield* rows, before);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("upgrading to migration 2 replays the log into the new tables", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "telemetry",
        filename: ":memory:",
        migrations: migrations.slice(0, 1),
      });
      yield* write([Fixtures.runEvent("run.created")]);
      // The reactor before the upgrade had handled every event.
      yield* Effect.scoped(
        Effect.flatMap(
          PluginReactor.start({ plugin: "telemetry", from: "now", handlers: {} }),
          (reactor) => reactor.drain,
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      // A failure the old reactor gave up on must not outlive the replay.
      yield* sql`INSERT INTO host_reactor_failure (sequence, type, attempts, last_error, failed_at)
        VALUES (1, 'run.created', 5, 'boom', '2026-01-01T00:00:00.000Z')`;
      const [, , upgrade] = migrations[1]!;
      yield* upgrade.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* startReactor(sql, Reactor.handlers);
      assert.deepEqual(
        (yield* sql<{ readonly run_id: string }>`SELECT run_id FROM telemetry_runs`).map(
          (row) => row.run_id,
        ),
        [RunId.make("run:telemetry")],
      );
      assert.deepEqual(yield* sql`SELECT sequence FROM host_reactor_failure`, []);
    }),
  ).pipe(Effect.provide(layerSink)),
);
