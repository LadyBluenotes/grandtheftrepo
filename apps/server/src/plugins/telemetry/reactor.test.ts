import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurnTokenUsage,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginReactor from "../PluginReactor.ts";
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

const threadId = ThreadId.make("thread:telemetry");
const providerTurnId = ProviderTurnId.make("provider-turn:telemetry-1");

const full: OrchestrationV2ProviderTurnTokenUsage = {
  usedTokens: 4100,
  inputTokens: 4000,
  cachedInputTokens: 3000,
  outputTokens: 100,
  reasoningOutputTokens: 20,
  updatedAt: "2026-10-12T00:00:00.000Z",
};

let sequence = 0;
/** One `provider-turn.updated` for the same provider turn, carrying `tokenUsage` when given. */
const turnUpdated = (
  tokenUsage: OrchestrationV2ProviderTurnTokenUsage | undefined,
  now: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:telemetry-${++sequence}`),
  type: "provider-turn.updated",
  threadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  occurredAt: now,
  payload: {
    id: providerTurnId,
    providerThreadId: ProviderThreadId.make("provider-thread:telemetry"),
    nodeId: NodeId.make("node:telemetry"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: now,
    completedAt: null,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  },
});

const write = (...usages: ReadonlyArray<OrchestrationV2ProviderTurnTokenUsage | undefined>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({ events: usages.map((usage) => turnUpdated(usage, now)) });
  });

interface Row {
  readonly provider_turn_id: string;
  readonly thread_id: string;
  readonly input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reasoning_output_tokens: number | null;
  readonly usage_updated_at: string;
}

const rows = (sql: SqlClient.SqlClient) =>
  sql<Row>`SELECT provider_turn_id, thread_id, input_tokens, cached_input_tokens, output_tokens,
    reasoning_output_tokens, usage_updated_at FROM telemetry_turn_usage`;

/** The plugin's database with its real migrations, and one reactor run over it until it is caught up. */
const react = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "telemetry", filename: ":memory:", migrations });
  const drain = Effect.scoped(
    Effect.flatMap(
      PluginReactor.start({ plugin: "telemetry", from: "start", handlers: Reactor.handlers }),
      (reactor) => reactor.drain,
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  );
  return { sql, drain };
});

it.effect("records every reported counter once per provider turn, latest report wins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      yield* write(full);
      yield* drain;
      assert.deepEqual(yield* rows(sql), [
        {
          provider_turn_id: providerTurnId,
          thread_id: threadId,
          input_tokens: 4000,
          cached_input_tokens: 3000,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          usage_updated_at: full.updatedAt,
        },
      ]);

      yield* write({ ...full, inputTokens: 5000, updatedAt: "2026-10-12T00:00:01.000Z" });
      yield* drain;
      const replaced = yield* rows(sql);
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
      yield* write(undefined);
      yield* drain;
      assert.deepEqual(yield* rows(sql), []);

      const { cachedInputTokens: _omitted, ...withoutCache } = full;
      yield* write(withoutCache);
      yield* drain;
      const [row] = yield* rows(sql);
      assert.strictEqual(row?.cached_input_tokens, null);
      assert.strictEqual(row?.input_tokens, 4000);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a rebuild over the same database replays nothing it already has", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql, drain } = yield* react;
      yield* write(full, { ...full, outputTokens: 200 });
      yield* drain;
      const before = yield* rows(sql);
      assert.strictEqual(before.length, 1);
      yield* drain;
      assert.deepEqual(yield* rows(sql), before);
    }),
  ).pipe(Effect.provide(layerSink)),
);
