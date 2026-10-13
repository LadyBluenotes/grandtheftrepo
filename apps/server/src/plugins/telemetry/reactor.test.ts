import { assert, it } from "@effect/vitest";
import {
  type CommandId,
  type OrchestrationV2AppThread,
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
    readonly event_sequence: number;
  }>`SELECT provider_turn_id, thread_id, run_id, input_tokens, cached_input_tokens, output_tokens,
    reasoning_output_tokens, usage_updated_at, event_sequence FROM telemetry_turn_usage`;

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
          event_sequence: 1,
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
        provider_instance_id: "codex",
        model: "test-model",
        started_at: DateTime.formatIso(Fixtures.at),
        completed_at: DateTime.formatIso(Fixtures.at),
      };
      assert.deepEqual(yield* sql`SELECT * FROM telemetry_runs`, [
        { ...expected, event_sequence: 2 },
      ]);

      yield* write([Fixtures.runEvent("run.updated")]);
      yield* drain;
      assert.deepEqual(yield* sql`SELECT * FROM telemetry_runs`, [
        { ...expected, event_sequence: 3 },
      ]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("keeps one row per tool call with its path and time, runless ones too", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const later = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
      const items = [
        Fixtures.itemEvent(Fixtures.readItem),
        Fixtures.itemEvent(Fixtures.editItem),
        // A provider's subagent makes calls that belong to no run.
        Fixtures.itemEvent({
          ...Fixtures.readItem,
          id: TurnItemId.make("item:runless"),
          runId: null,
        }),
        // An item that never started is placed by when it last changed.
        Fixtures.itemEvent({
          ...Fixtures.readItem,
          id: TurnItemId.make("item:unstarted"),
          runId: null,
          startedAt: null,
          updatedAt: later,
        }),
        Fixtures.itemEvent(Fixtures.noticeItem),
      ];
      yield* write(items);
      yield* drain;
      const row = (
        id: string,
        fields: {
          readonly run_id: string | null;
          readonly ordinal: number;
          readonly item_type: string;
          readonly tool_name: string | null;
          readonly output_tokens: number | null;
          readonly item_at: string;
          readonly event_sequence: number;
        },
      ) => ({
        item_id: id,
        thread_id: Fixtures.threadId,
        path: "src/a.ts",
        command: null,
        status: "failed",
        ...fields,
      });
      const at = DateTime.formatIso(Fixtures.at);
      const expected = (readSequence: number, editSequence: number) => [
        row("item:edit", {
          run_id: Fixtures.runId,
          ordinal: 2,
          item_type: "file_change",
          tool_name: null,
          output_tokens: null,
          item_at: at,
          event_sequence: editSequence,
        }),
        row("item:read", {
          run_id: Fixtures.runId,
          ordinal: 1,
          item_type: "dynamic_tool",
          tool_name: "Read",
          output_tokens: 0,
          item_at: at,
          event_sequence: readSequence,
        }),
        row("item:runless", {
          run_id: null,
          ordinal: 3,
          item_type: "dynamic_tool",
          tool_name: "Read",
          output_tokens: 0,
          item_at: at,
          event_sequence: 3,
        }),
        row("item:unstarted", {
          run_id: null,
          ordinal: 4,
          item_type: "dynamic_tool",
          tool_name: "Read",
          output_tokens: 0,
          item_at: DateTime.formatIso(later),
          event_sequence: 4,
        }),
      ];
      // The sink renumbers item ordinals into positions in the thread, keeping their order.
      const rows = sql`SELECT item_id, run_id, thread_id, ordinal, item_type, tool_name, path,
        command, output_tokens, item_at, status, event_sequence
        FROM telemetry_tool_calls ORDER BY item_id`;
      assert.deepEqual(yield* rows, expected(1, 2));

      yield* write([Fixtures.itemEvent(Fixtures.readItem), Fixtures.itemEvent(Fixtures.editItem)]);
      yield* drain;
      assert.deepEqual(yield* rows, expected(6, 7));
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("sizes each tool call's output by its item type and keeps a command's head", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const longCommand = `git log ${"x".repeat(600)}`;
      yield* write(
        [
          Fixtures.readItem,
          Fixtures.editItem,
          Fixtures.commandItem,
          {
            ...Fixtures.commandItem,
            id: TurnItemId.make("item:command-long"),
            input: longCommand,
            output: "y".repeat(4001),
          },
          Fixtures.mcpItem,
          Fixtures.fileSearchItem,
          Fixtures.webSearchItem,
        ].map(Fixtures.itemEvent),
      );
      yield* drain;
      const rows = yield* sql<{
        readonly item_id: string;
        readonly command: string | null;
        readonly output_tokens: number | null;
      }>`SELECT item_id, command, output_tokens FROM telemetry_tool_calls ORDER BY item_id`;
      // Characters over four, rounded up: a string as it is, anything else as its JSON. An item
      // with nothing to size is NULL; one that returned nothing is 0.
      assert.deepEqual(
        rows.map((row) => [row.item_id, row.output_tokens]),
        [
          ["item:command", 14],
          ["item:command-long", 1001],
          ["item:edit", null],
          ["item:file-search", 20],
          ["item:mcp", 18],
          ["item:read", 0],
          ["item:web-search", 23],
        ],
      );
      // Only a command keeps its command line, cut to the head that names the program.
      assert.deepEqual(
        rows.map((row) => [row.item_id, row.command?.length ?? null]),
        [
          ["item:command", Fixtures.commandItem.input.length],
          ["item:command-long", 512],
          ["item:edit", null],
          ["item:file-search", null],
          ["item:mcp", null],
          ["item:read", null],
          ["item:web-search", null],
        ],
      );
      assert.strictEqual(rows[1]?.command, longCommand.slice(0, 512));
    }),
  ).pipe(Effect.provide(layerSink)),
);

const lastSequence = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  return yield* sink.latestSequence();
});

/**
 * Handles `older`, then `newer`, then records `older` as a failed event and restarts the reactor,
 * whose startup retry handles it again after `newer`. Returns what `rows` read before and after.
 */
const retryOlderAfterNewer = <Row>(
  { sql, drain }: Effect.Success<typeof react>,
  older: OrchestrationV2DomainEvent,
  newer: OrchestrationV2DomainEvent,
  rows: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
) =>
  Effect.gen(function* () {
    yield* write([older]);
    const olderSequence = yield* lastSequence;
    yield* write([newer]);
    yield* drain;
    const newest = yield* rows;
    yield* sql`INSERT INTO host_reactor_failure (sequence, type, attempts, last_error, failed_at)
      VALUES (${olderSequence}, ${older.type}, 1, 'boom', '2026-01-01T00:00:00.000Z')`;
    yield* drain;
    // The retry ran: the failure is gone, so the rows were left alone by the handler.
    assert.deepEqual(yield* sql`SELECT sequence FROM host_reactor_failure`, []);
    return { newest, retried: yield* rows };
  });

it.effect("a run event retried after a newer one leaves the newer state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* react;
      const running = { ...Fixtures.run, status: "running" as const, completedAt: null };
      const { newest, retried } = yield* retryOlderAfterNewer(
        db,
        Fixtures.runEvent("run.created", running),
        Fixtures.runEvent("run.updated"),
        db.sql`SELECT status, completed_at FROM telemetry_runs`,
      );
      assert.deepEqual(newest, [
        { status: "failed", completed_at: DateTime.formatIso(Fixtures.at) },
      ]);
      assert.deepEqual(retried, newest);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a tool call event retried after a newer one leaves the newer state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* react;
      const running = { ...Fixtures.readItem, status: "running" as const, completedAt: null };
      const { newest, retried } = yield* retryOlderAfterNewer(
        db,
        Fixtures.itemEvent(running),
        Fixtures.itemEvent(Fixtures.readItem),
        db.sql`SELECT item_id, status FROM telemetry_tool_calls`,
      );
      assert.deepEqual(newest, [{ item_id: "item:read", status: "failed" }]);
      assert.deepEqual(retried, newest);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a usage report retried after a newer one of the same time leaves the newer one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* react;
      const { newest, retried } = yield* retryOlderAfterNewer(
        db,
        Fixtures.turnUpdated(full),
        Fixtures.turnUpdated({ ...full, inputTokens: 5000 }),
        db.sql`SELECT input_tokens, usage_updated_at FROM telemetry_turn_usage`,
      );
      assert.deepEqual(newest, [{ input_tokens: 5000, usage_updated_at: full.updatedAt }]);
      assert.deepEqual(retried, newest);
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

      // A later event carrying the same settlement does not forget who made it.
      yield* write([Fixtures.threadEvent("thread.visited")]);
      yield* drain;
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

it.effect("an older settle retried after a newer one keeps the newer settlement's origin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const rows = sql<ThreadRow>`SELECT * FROM telemetry_threads`;
      const bySweep = settledBy("2026-10-02T12:00:00.000Z");
      const byHand = settledBy("2026-10-02T14:00:00.000Z");
      yield* write([Fixtures.threadEvent("thread.created", active)]);
      yield* write([Fixtures.threadEvent("thread.settled", bySweep)], Fixtures.sweepCommandId);
      yield* write([Fixtures.threadEvent("thread.settled", byHand)]);
      yield* drain;
      // The reactor's retry of the sweep's settle lands after the hand settle was handled.
      yield* write([Fixtures.threadEvent("thread.settled", bySweep)], Fixtures.sweepCommandId);
      yield* drain;
      const [row] = yield* rows;
      assert.deepEqual([row?.settled_at, row?.settled_by_sweep], ["2026-10-02T14:00:00.000Z", 0]);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("an older event retried after a newer reopen keeps the newer reopen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      const rows = sql<ThreadRow>`SELECT * FROM telemetry_threads`;
      const settled = settledBy("2026-10-02T12:00:00.000Z");
      const reopened = (unsettledAt: string) => ({
        ...settled,
        settledAt: null,
        unsettledAt: DateTime.makeUnsafe(unsettledAt),
      });
      yield* write([
        Fixtures.threadEvent("thread.created", active),
        Fixtures.threadEvent("thread.settled", settled),
        Fixtures.threadEvent("thread.unsettled", reopened("2026-10-02T13:00:00.000Z")),
        Fixtures.threadEvent("thread.settled", {
          ...settled,
          settledAt: DateTime.makeUnsafe("2026-10-02T14:00:00.000Z"),
        }),
        Fixtures.threadEvent("thread.unsettled", reopened("2026-10-02T15:00:00.000Z")),
      ]);
      yield* drain;
      // The reactor's retry of a failed older event lands after the newer ones were handled.
      yield* write([Fixtures.threadEvent("thread.visited", reopened("2026-10-02T13:00:00.000Z"))]);
      yield* drain;
      const [row] = yield* rows;
      assert.deepEqual(
        [row?.settled_at, row?.unsettled_at],
        ["2026-10-02T14:00:00.000Z", "2026-10-02T15:00:00.000Z"],
      );
      assert.deepEqual(
        acceptedOutcomes(input({ threads: yield* rows })).map((thread) => thread.thread_id),
        [],
      );
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect(
  "a compacted log that kept only a later visit still yields the settlement, by someone unknown",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, drain } = yield* react;
        const rows = sql<ThreadRow>`SELECT * FROM telemetry_threads`;
        const acceptedIds = Effect.map(rows, (threads) =>
          acceptedOutcomes(input({ threads })).map((thread) => thread.thread_id),
        );
        const visitedAt = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
        const visit = (thread: OrchestrationV2AppThread) =>
          Fixtures.threadEvent(
            "thread.visited",
            { ...thread, lastVisitedAt: visitedAt },
            visitedAt,
          );
        const settled = settledBy("2026-10-02T12:00:00.000Z");

        // Compaction dropped the `thread.settled`; the visit after it is the thread's newest state.
        yield* write([Fixtures.threadEvent("thread.created", active), visit(settled)]);
        yield* drain;
        const [row] = yield* rows;
        assert.deepEqual(
          [row?.settled_at, row?.settled_by_sweep],
          ["2026-10-02T12:00:00.000Z", null],
        );
        // Not known to be settled by hand, so it is accepted only once a pull request merged.
        assert.deepEqual(yield* acceptedIds, []);
        yield* write([visit({ ...settled, pullRequests: Fixtures.thread.pullRequests })]);
        yield* drain;
        assert.deepEqual(yield* acceptedIds, [Fixtures.threadId]);

        const before = yield* rows;
        yield* sql`DELETE FROM host_reactor_cursor`;
        yield* drain;
        assert.deepEqual(yield* rows, before);
      }),
    ).pipe(Effect.provide(layerSink)),
);

it.effect("upgrading from migration 1 replays the log into the new tables", () =>
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
      for (const [, , upgrade] of migrations.slice(1)) {
        yield* upgrade.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      }
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

it.effect(
  "upgrading to migration 3 backfills each run's provider instance and adds the budgets",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql } = yield* PluginDatabase.open({
          id: "telemetry",
          filename: ":memory:",
          migrations: migrations.slice(0, 2),
        });
        yield* write([Fixtures.runEvent("run.created")]);
        // The reactor before the upgrade had stored the run without its provider instance.
        yield* Effect.scoped(
          Effect.flatMap(
            PluginReactor.start({ plugin: "telemetry", from: "now", handlers: {} }),
            (reactor) => reactor.drain,
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );
        yield* sql`INSERT INTO telemetry_runs
          (run_id, thread_id, turn_id, ordinal, status, model, started_at, completed_at,
           event_sequence)
        VALUES (${Fixtures.runId}, ${Fixtures.threadId}, 'message:telemetry', 2, 'failed',
          'test-model', NULL, NULL, 1)`;
        const [, , upgrade] = migrations[2]!;
        yield* upgrade.pipe(Effect.provideService(SqlClient.SqlClient, sql));
        assert.deepEqual(yield* sql`SELECT provider_instance_id FROM telemetry_runs`, [
          { provider_instance_id: null },
        ]);
        yield* startReactor(sql, Reactor.handlers);
        assert.deepEqual(yield* sql`SELECT provider_instance_id FROM telemetry_runs`, [
          { provider_instance_id: "codex" },
        ]);
        // The three placeholder budgets, one per tier, for every project.
        assert.deepEqual(
          yield* sql`SELECT measure, tier, threshold, direction, project_id, min_sample, enabled
          FROM budgets ORDER BY id`,
          [
            ["cheap", 800],
            ["standard", 1500],
            ["strong", 3000],
          ].map(([tier, threshold]) => ({
            measure: "context_efficiency",
            tier,
            threshold,
            direction: "lower_is_better",
            project_id: null,
            min_sample: 20,
            enabled: 1,
          })),
        );
      }),
    ).pipe(Effect.provide(layerSink)),
);

it.effect(
  "upgrading to migration 4 replays the tool calls into the new columns and adds the budget",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql } = yield* PluginDatabase.open({
          id: "telemetry",
          filename: ":memory:",
          migrations: migrations.slice(0, 3),
        });
        yield* write([Fixtures.itemEvent(Fixtures.commandItem)]);
        // The reactor before the upgrade had stored the tool call without a size.
        yield* Effect.scoped(
          Effect.flatMap(
            PluginReactor.start({ plugin: "telemetry", from: "now", handlers: {} }),
            (reactor) => reactor.drain,
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );
        yield* sql`INSERT INTO telemetry_tool_calls
        (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, status, event_sequence)
        VALUES ('item:command', ${Fixtures.runId}, ${Fixtures.threadId}, 1, 'command_execution',
          NULL, NULL, 'failed', 1)`;
        const [, , upgrade] = migrations[3]!;
        yield* upgrade.pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const calls = sql`SELECT command, output_tokens FROM telemetry_tool_calls`;
        assert.deepEqual(yield* calls, [{ command: null, output_tokens: null }]);
        // The reactor writes the columns migration 5 adds, so the upgrade runs through it.
        for (const [, , rebuild] of migrations.slice(4)) {
          yield* rebuild.pipe(Effect.provideService(SqlClient.SqlClient, sql));
        }
        yield* startReactor(sql, Reactor.handlers);
        assert.deepEqual(yield* calls, [
          { command: Fixtures.commandItem.input, output_tokens: 14 },
        ]);
        // The measure reads no tier, so the one budget on `standard` judges every run.
        assert.deepEqual(
          yield* sql`SELECT measure, tier, threshold, direction, project_id, min_sample, enabled
          FROM budgets WHERE measure = 'tool_output_max_per_call'`,
          [
            {
              measure: "tool_output_max_per_call",
              tier: "standard",
              threshold: 8000,
              direction: "lower_is_better",
              project_id: null,
              min_sample: 20,
              enabled: 1,
            },
          ],
        );
      }),
    ).pipe(Effect.provide(layerSink)),
);

it.effect(
  "upgrading to migration 5 keeps the tool calls, lets one have no run, and replays the ones skipped",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql } = yield* PluginDatabase.open({
          id: "telemetry",
          filename: ":memory:",
          migrations: migrations.slice(0, 4),
        });
        const runless = {
          ...Fixtures.mcpItem,
          id: TurnItemId.make("item:runless"),
          runId: null,
        };
        yield* write([Fixtures.itemEvent(Fixtures.commandItem), Fixtures.itemEvent(runless)]);
        // The reactor before the upgrade had handled both and kept only the call with a run.
        yield* Effect.scoped(
          Effect.flatMap(
            PluginReactor.start({ plugin: "telemetry", from: "now", handlers: {} }),
            (reactor) => reactor.drain,
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );
        yield* sql`INSERT INTO telemetry_tool_calls
          (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, command, output_tokens,
           status, event_sequence)
          VALUES ('item:command', ${Fixtures.runId}, ${Fixtures.threadId}, 1, 'command_execution',
            NULL, NULL, 'git status', 14, 'failed', 1)`;
        const [, , rebuild] = migrations[4]!;
        yield* rebuild.pipe(Effect.provideService(SqlClient.SqlClient, sql));

        const calls = sql`SELECT item_id, run_id, command, output_tokens, item_at
          FROM telemetry_tool_calls ORDER BY item_id`;
        // The row survives the rebuild as it was; its time waits for the replay.
        assert.deepEqual(yield* calls, [
          {
            item_id: "item:command",
            run_id: Fixtures.runId,
            command: "git status",
            output_tokens: 14,
            item_at: null,
          },
        ]);
        assert.deepEqual(
          (yield* sql<{
            readonly name: string;
          }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'telemetry_tool_calls'
            AND name = 'telemetry_tool_calls_thread'`).length,
          1,
        );

        yield* startReactor(sql, Reactor.handlers);
        const at = DateTime.formatIso(Fixtures.at);
        assert.deepEqual(yield* calls, [
          {
            item_id: "item:command",
            run_id: Fixtures.runId,
            command: Fixtures.commandItem.input,
            output_tokens: 14,
            item_at: at,
          },
          { item_id: "item:runless", run_id: null, command: null, output_tokens: 18, item_at: at },
        ]);
      }),
    ).pipe(Effect.provide(layerSink)),
);
