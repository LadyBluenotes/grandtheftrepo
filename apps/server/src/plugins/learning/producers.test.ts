import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
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
import * as CorrectionStore from "./CorrectionStore.ts";
import { handlers } from "./index.ts";
import { migrations } from "./migrations.ts";

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

const projectId = ProjectId.make("project:learning");
const threadId = ThreadId.make("thread:learning");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const at = DateTime.makeUnsafe("2026-10-02T12:00:00.000Z");
const later = DateTime.makeUnsafe("2026-10-02T13:00:00.000Z");

let eventCount = 0;
const nextEventId = () => EventId.make(`event:learning-${++eventCount}`);

const thread = (overrides: Partial<OrchestrationV2AppThread> = {}): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Thread",
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

type ThreadEventType = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>["type"];

const threadEvent = (
  type: ThreadEventType,
  overrides: Partial<OrchestrationV2AppThread> = {},
  occurredAt = at,
): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type,
  threadId,
  providerInstanceId,
  occurredAt,
  payload: thread(overrides),
});

/** The `ordinal`th turn of the thread's one provider thread; the projection keys turns by it. */
const turnEvent = (
  ordinal: number,
  status: OrchestrationV2ProviderTurn["status"],
): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type: "provider-turn.updated",
  threadId,
  providerInstanceId,
  occurredAt: at,
  payload: {
    id: ProviderTurnId.make(`provider-turn:${ordinal}`),
    providerThreadId: ProviderThreadId.make("provider-thread:learning"),
    nodeId: NodeId.make("node:learning"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal,
    status,
    startedAt: at,
    completedAt: status === "pending" || status === "running" ? null : at,
  },
});

/** A wake as `PullRequestWatchReactor` sends it, with the summary `pullRequestWatchMessage` builds. */
const wakeEvent = (
  messageId: string,
  summary: string,
  text: string,
): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at,
  payload: {
    id: MessageId.make(messageId),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
    createdBy: "agent",
    creationSource: "server",
    notification: { source: { kind: "monitor" }, outcome: "updated", summary },
  },
});

const pullRequest = (
  reviewDecision: ThreadPullRequestSnapshot["reviewDecision"],
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "o/r",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  source: "manual",
  linkedAt: "2026-10-02T12:00:00.000Z",
  snapshot: {
    state: "open",
    title: "Add it",
    headBranch: "feat",
    baseBranch: "main",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-10-02T12:00:00.000Z",
    reviewDecision,
  },
  stack: null,
});

const openPlugin = Effect.map(
  PluginDatabase.open({ id: "learning-test", filename: ":memory:", migrations }),
  (opened) => opened.sql,
);

/** Commits `events` and runs the plugin's reactor over the log until it has seen them all. */
const react = (sql: SqlClient.SqlClient, events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reactor = yield* PluginReactor.start({ plugin: "learning", from: "start", handlers });
      if (events.length > 0) yield* (yield* EventSink.EventSinkV2).write({ events });
      yield* reactor.drain;
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  );

/** Runs the whole log again from the first event, as a restored or re-cursored plugin would. */
const replay = (sql: SqlClient.SqlClient) =>
  sql`DELETE FROM host_reactor_cursor`.pipe(Effect.andThen(react(sql, [])));

const rows = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly failure_kind: string;
    readonly source_key: string | null;
    readonly description: string;
  }>`SELECT failure_kind, source_key, description FROM corrections ORDER BY id`;

const storeOn = (sql: SqlClient.SqlClient) =>
  Effect.map(
    Layer.build(CorrectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)))),
    (services) => Context.get(services, CorrectionStore.CorrectionStore),
  );

it.effect("a failed turn is one correction, replayed or updated again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* openPlugin;
      yield* react(sql, [
        threadEvent("thread.created"),
        turnEvent(1, "running"),
        turnEvent(1, "failed"),
      ]);
      assert.deepEqual(yield* rows(sql), [
        {
          failure_kind: "provider_turn_failed",
          source_key: "provider-turn:1:failed",
          description: "Provider turn 1 failed.",
        },
      ]);
      yield* replay(sql);
      yield* react(sql, [turnEvent(1, "failed")]);
      assert.strictEqual((yield* rows(sql)).length, 1);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("an interrupted turn is the other kind; completed and cancelled turns are nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* openPlugin;
      yield* react(sql, [
        threadEvent("thread.created"),
        turnEvent(1, "interrupted"),
        turnEvent(2, "completed"),
        turnEvent(3, "cancelled"),
      ]);
      assert.deepEqual(
        (yield* rows(sql)).map((row) => [row.failure_kind, row.source_key]),
        [["provider_turn_interrupted", "provider-turn:1:interrupted"]],
      );
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a turn on a thread the plugin never saw is skipped, not failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* openPlugin;
      yield* react(sql, [turnEvent(1, "failed")]);
      assert.deepEqual(yield* rows(sql), []);
      assert.deepEqual(yield* sql`SELECT sequence FROM host_reactor_failure`, []);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a wake about new comments counts while changes are requested, redacted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* openPlugin;
      yield* react(sql, [
        threadEvent("thread.created"),
        threadEvent("thread.pull-request-synced", {
          pullRequests: [pullRequest("changes-requested")],
        }),
        wakeEvent(
          "message:pr-watch:1",
          "#7: new comments",
          'Update on pull request #7:\n- 1 new comment:\n  - reviewer on src/index.ts: "Drop TOKEN=abc123 from the diff."',
        ),
        wakeEvent(
          "message:pr-watch:2",
          "#7: checks failed",
          "Update on pull request #7:\n- Checks failed",
        ),
        threadEvent("thread.pull-request-synced", { pullRequests: [pullRequest("approved")] }),
        wakeEvent(
          "message:pr-watch:3",
          "#7: new comments",
          "Update on pull request #7:\n- 1 new comment",
        ),
      ]);
      assert.deepEqual(yield* rows(sql), [
        {
          failure_kind: "changes_requested",
          source_key: "message:pr-watch:1",
          description:
            'Update on pull request #7:\n- 1 new comment:\n  - reviewer on src/index.ts: "Drop TOKEN=[redacted] from the diff."',
        },
      ]);
      yield* replay(sql);
      assert.strictEqual((yield* rows(sql)).length, 1);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect("a thread reopened after settlement is one correction; an unsettle alone is none", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* openPlugin;
      yield* react(sql, [
        threadEvent("thread.created"),
        threadEvent("thread.unsettled", { settledOverride: "active" }),
      ]);
      assert.deepEqual(yield* rows(sql), []);
      yield* react(sql, [
        threadEvent("thread.settled", { settledOverride: "settled", settledAt: at }),
        threadEvent("thread.unsettled", { settledOverride: "active", unsettledAt: later }, later),
      ]);
      assert.deepEqual(
        (yield* rows(sql)).map((row) => [row.failure_kind, row.source_key]),
        [["reopened_after_settlement", "thread:learning:2026-10-02T13:00:00.000Z"]],
      );
      yield* replay(sql);
      assert.strictEqual((yield* rows(sql)).length, 1);
    }),
  ).pipe(Effect.provide(layerSink)),
);

it.effect(
  "the store lists by project, time and kind, finds one by id, and records manual rows",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* openPlugin;
        yield* react(sql, [threadEvent("thread.created"), turnEvent(1, "failed")]);
        const store = yield* storeOn(sql);
        const manual = yield* store.record({
          projectId,
          threadId,
          failureKind: "manual",
          declaredMode: "incomplete",
          description: "Left the tests out. API_KEY=secret",
          sourceEventIds: [],
          sourceKey: null,
        });
        assert.strictEqual(manual.description, "Left the tests out. API_KEY=[redacted]");
        assert.strictEqual(manual.declaredMode, "incomplete");
        assert.strictEqual(manual.causeClass, "unclassified");
        // A second manual row never collides with the first: null source keys are distinct.
        yield* store.record({ ...manual, declaredMode: undefined, sourceEventIds: [] });

        // `it.effect` runs on the test clock, so rows are dated at its epoch.
        const range = {
          projectId,
          from: "1970-01-01T00:00:00.000Z",
          to: "2100-01-01T00:00:00.000Z",
        };
        const all = yield* store.list(range);
        assert.deepEqual(
          all.map((correction) => correction.failureKind),
          ["provider_turn_failed", "manual", "manual"],
        );
        assert.deepEqual(
          (yield* store.list({ ...range, failureKind: "provider_turn_failed" })).map((c) => c.id),
          [all[0]!.id],
        );
        assert.deepEqual(yield* store.list({ ...range, from: "2000-01-01T00:00:00.000Z" }), []);
        assert.deepEqual(
          yield* store.list({ ...range, projectId: ProjectId.make("project:other") }),
          [],
        );
        assert.deepEqual(yield* store.get(manual.id), manual);
        assert.strictEqual((yield* Effect.flip(store.get(999))).code, "not_found");
      }),
    ).pipe(Effect.provide(layerSink)),
);
