import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type Project,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../../config.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PluginDatabase from "../../PluginDatabase.ts";
import * as PluginReactor from "../../PluginReactor.ts";
import * as TierSelectionService from "../../routing/TierSelectionService.ts";
import * as FindingService from "../findings/FindingService.ts";
import * as KanbanStore from "../KanbanStore.ts";
import { migrations } from "../migrations.ts";
import * as SpecReactor from "../spec/SpecReactor.ts";
import * as SpecService from "../spec/SpecService.ts";
import * as StopGate from "../StopGate.ts";
import * as SettleCapture from "./SettleCapture.ts";

const projectId = ProjectId.make("project-1");
const project: Project = {
  id: projectId,
  title: "Grand Theft Repo",
  workspaceRoot: "/unused",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
};
const codex = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: codex, model: "gpt-5.4-mini" } satisfies ModelSelection;
const at = DateTime.makeUnsafe("2026-10-12T12:00:00.000Z");
const worked = ThreadId.make("thread-cache");

// A real event sink and projection on an in-memory core database, as the reactor tests use.
const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerTest = Layer.mergeAll(
  Layer.merge(EventSink.layer, ProjectionStore.layer).pipe(Layer.provide(layerStores)),
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-capture-" })).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

let eventCount = 0;
const eventBase = () => ({
  id: EventId.make(`event:capture-${++eventCount}`),
  providerInstanceId: codex,
  occurredAt: at,
});

const appThread = (threadId: ThreadId, title: string): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title,
  providerInstanceId: codex,
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
});

const run = (
  threadId: ThreadId,
  runId: RunId,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run => ({
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: codex,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${threadId}:0`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: at,
  startedAt: at,
  completedAt: status === "running" ? null : at,
  checkpointId: null,
  contextHandoffId: null,
});

/** The agent's reply in the thread's one run, still streaming or complete. */
const replyItem = (threadId: ThreadId, text: string, streaming = false) => {
  const runId = RunId.make(`run:${threadId}`);
  return {
    ...eventBase(),
    type: "turn-item.updated",
    threadId,
    runId,
    payload: {
      id: TurnItemId.make(`item:${threadId}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: streaming ? "running" : "completed",
      title: null,
      startedAt: at,
      completedAt: streaming ? null : at,
      updatedAt: at,
      type: "assistant_message",
      messageId: MessageId.make(`message:${threadId}:1`),
      text,
      streaming,
    },
  } satisfies OrchestrationV2DomainEvent;
};

/** The thread's one run, at `status`. */
const runUpdated = (threadId: ThreadId, status: OrchestrationV2Run["status"]) => {
  const runId = RunId.make(`run:${threadId}`);
  return {
    ...eventBase(),
    type: "run.updated",
    threadId,
    runId,
    payload: run(threadId, runId, status),
  } satisfies OrchestrationV2DomainEvent;
};

/** A thread that ran one turn ending with `reply`, as the orchestrator records it. */
const turn = (
  threadId: ThreadId,
  title: string,
  reply: string,
): ReadonlyArray<OrchestrationV2DomainEvent> => [
  { ...eventBase(), type: "thread.created", threadId, payload: appThread(threadId, title) },
  replyItem(threadId, reply),
  runUpdated(threadId, "completed"),
];

/** `thread.settled` for a thread settled at `settledAt`, which a repeated settle keeps. */
const settled = (
  threadId: ThreadId,
  title: string,
  settledAt = at,
): OrchestrationV2DomainEvent => ({
  ...eventBase(),
  type: "thread.settled",
  threadId,
  payload: { ...appThread(threadId, title), settledAt },
});

const reply = [
  "Done. I cached the token lookups in SQLite rather than Redis: the server already ships SQLite,",
  "and Redis would be one more service to run. I also kept the old cache key format.",
  "While there I noticed the session sweeper never deletes expired rows.",
].join(" ");

/** The extraction turn's answer, as a model wraps it. */
const answer = (decisions: ReadonlyArray<string>) =>
  [
    "```json",
    JSON.stringify({
      decisions: decisions.map((title) => ({
        category: "storage",
        title,
        why: "The server already ships SQLite; Redis would be one more service to run.",
        alternatives: [
          {
            title: "SQLite",
            disposition: "chosen",
            reason: "Already shipped.",
            reasonKind: "contextual",
          },
          {
            title: "Redis",
            disposition: "rejected",
            reason: "One more service.",
            reasonKind: "contextual",
          },
        ],
      })),
      findings: [
        {
          title: "Session sweeper never deletes expired rows",
          evidence: "Noticed while caching token lookups.",
          truthStatus: "seen",
          scopeRelation: "unrelated",
        },
      ],
    }),
    "```",
  ].join("\n");

/**
 * The plugin's services over a fresh board folder and an in-memory kanban database, run by the
 * plugin's reactor. Launches go to a stub that records them, on a cheap tier that always resolves,
 * and settling a thread is recorded, or refused while `failSettles(true)` holds.
 */
const start = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "kanban", filename: ":memory:", migrations });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settledThreads: Array<ThreadId> = [];
  let settleFails = false;
  const services = yield* Layer.build(
    Layer.merge(SettleCapture.layer, SpecService.layer).pipe(
      Layer.provideMerge(FindingService.layer),
      Layer.provideMerge(Layer.merge(KanbanStore.layer, StopGate.layer)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId, fields, filter) =>
              projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
            settleThread: ({ threadId, commandId }) =>
              settleFails
                ? Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId,
                      commandType: "thread.settle",
                      cause: "The settle was refused.",
                    }),
                  )
                : Effect.sync(() => {
                    settledThreads.push(threadId);
                    return { sequence: 0 };
                  }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
          }),
        ),
      ),
    ),
  );
  const store = Context.get(services, KanbanStore.KanbanStore);
  const handlers = SpecReactor.handlers(
    Context.get(services, SpecService.SpecService),
    Context.get(services, SettleCapture.SettleCapture),
  );

  const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const routed: Array<TierSelectionService.Work> = [];
  const launcher = ThreadLaunchService.ThreadLaunchService.of({
    launch: (input) =>
      Effect.sync(() => {
        launched.push(input);
        return { threadId: input.threadId!, resumed: false, projection: {} as never };
      }),
    checkWorktreeBase: () => Effect.void,
    retryPreparation: () => Effect.die("unused"),
    prepareRun: () => Effect.die("unused"),
  });
  const tiers = TierSelectionService.TierSelectionService.of({
    recommend: (work) =>
      Effect.sync(() => {
        routed.push(work);
        return {
          taskClass: work.taskClass,
          tier: "cheap",
          reason: "rule",
          failedRuns: 0,
          entry: { providerInstanceId: codex, model: modelSelection.model },
        };
      }),
    record: () => Effect.void,
  });

  /**
   * Commits events, then starts the reactor, which first retries the events that failed, as it
   * does at every server start, and runs it until it has handled every one. Its fiber holds the
   * launcher and the routing plugin's tier service, as `PluginServices` gives it on the server.
   */
  const react = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    Effect.gen(function* () {
      yield* (yield* EventSink.EventSinkV2).write({ events });
      yield* Effect.scoped(
        Effect.flatMap(
          PluginReactor.start({ plugin: "kanban", from: "start", handlers }),
          (r) => r.drain,
        ),
      ).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ThreadLaunchService.ThreadLaunchService, launcher),
        Effect.provideService(TierSelectionService.TierSelectionService, tiers),
      );
    });

  /** The capture thread's turn ending with `text`. */
  const extract = (threadId: ThreadId, text: string) => react(turn(threadId, "Capture", text));

  const failSettles = (fail: boolean) => {
    settleFails = fail;
  };

  return { sql, store, launched, routed, settledThreads, failSettles, react, extract };
});

describe("SettleCapture", () => {
  it.effect(
    "a settled reply that chose one approach over another yields one proposed decision and an open finding, linked to the thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { store, launched, routed, settledThreads, react, extract } = yield* start;
          yield* store.setCapture({ projectId, enabled: true });
          assert.isTrue((yield* store.board(projectId)).capture);

          yield* react([
            ...turn(worked, "Cache token lookups", reply),
            settled(worked, "Cache token lookups"),
          ]);
          assert.strictEqual(launched.length, 1);
          const capture = launched[0]!;
          assert.deepEqual(
            routed.map((work) => work.taskClass),
            ["mechanical"],
          );
          assert.deepEqual(capture.modelSelection, modelSelection);
          assert.strictEqual(capture.interactionMode, "plan");
          assert.include(capture.initialMessage!.text, reply);
          assert.include(capture.initialMessage!.text, "Nothing is recorded from this thread yet.");
          // Nothing is filed until the turn answers.
          assert.deepEqual(yield* store.listDecisions({ projectId }), []);

          yield* extract(capture.threadId!, answer(["Cache token lookups in SQLite, not Redis"]));
          const decisions = yield* store.listDecisions({ projectId });
          assert.deepEqual(
            decisions.map((d) => [d.category, d.title, d.state, d.threads, d.by]),
            [
              [
                "storage",
                "Cache token lookups in SQLite, not Redis",
                "proposed",
                [worked],
                "system",
              ],
            ],
          );
          assert.deepEqual(
            decisions[0]!.alternatives.map((a) => [a.title, a.disposition]),
            [
              ["SQLite", "chosen"],
              ["Redis", "rejected"],
            ],
          );
          const issues = (yield* store.board(projectId)).issues;
          assert.deepEqual(
            issues.map((i) => [i.status, i.labels]),
            [["triage", ["finding"]]],
          );
          const [finding] = (yield* store.getIssue({ projectId, id: issues[0]!.id })).findings;
          assert.strictEqual(finding?.disposition, "open");
          assert.isNull(finding?.review);
          assert.strictEqual(finding?.threadId, worked);
          assert.strictEqual(finding?.proposedBy, `thread:${capture.threadId}`);
          // The capture thread leaves the active list once its drafts are filed.
          assert.deepEqual(settledThreads, [capture.threadId]);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a decision already recorded in the thread is not drafted again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, launched, react, extract } = yield* start;
        yield* store.setCapture({ projectId, enabled: true });
        yield* store.write(projectId, `thread:${worked}`, {
          action: "decision.create",
          category: "storage",
          title: "Cache token lookups in SQLite, not Redis",
          why: "SQLite ships with the server.",
        });

        yield* react([
          ...turn(worked, "Cache token lookups", reply),
          settled(worked, "Cache token lookups"),
        ]);
        const prompt = launched[0]!.initialMessage!.text;
        assert.include(prompt, "- Decision: Cache token lookups in SQLite, not Redis");

        // The model repeats it, in other case and punctuation, beside one that is new.
        yield* extract(
          launched[0]!.threadId!,
          answer(["cache token lookups in SQLite -- not Redis.", "Keep the old cache key format"]),
        );
        const decisions = yield* store.listDecisions({ projectId });
        assert.deepEqual(
          decisions.map((d) => [d.title, d.state]),
          [
            ["Cache token lookups in SQLite, not Redis", "accepted"],
            ["Keep the old cache key format", "proposed"],
          ],
        );
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a thread settled again without being reopened starts no second turn; one settled after a reopen does",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { store, launched, react } = yield* start;
          yield* store.setCapture({ projectId, enabled: true });
          yield* react([
            ...turn(worked, "Cache token lookups", reply),
            settled(worked, "Cache token lookups"),
          ]);
          assert.strictEqual(launched.length, 1);

          // The orchestrator emits the event again for a settled thread, keeping its settledAt.
          yield* react([settled(worked, "Cache token lookups")]);
          assert.strictEqual(launched.length, 1);

          // Reopened and settled later: a new settlement, read again.
          const later = DateTime.add(at, { hours: 1 });
          yield* react([settled(worked, "Cache token lookups", later)]);
          assert.strictEqual(launched.length, 2);
          assert.notStrictEqual(launched[1]!.threadId, launched[0]!.threadId);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a thread settled while its latest run still goes is read once that run ends, and only once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { store, launched, react } = yield* start;
          yield* store.setCapture({ projectId, enabled: true });
          yield* react([
            {
              ...eventBase(),
              type: "thread.created",
              threadId: worked,
              payload: appThread(worked, "Cache token lookups"),
            },
            replyItem(worked, reply.slice(0, 40), true),
            runUpdated(worked, "running"),
            settled(worked, "Cache token lookups"),
          ]);
          // Half a reply is not the settlement's reply: nothing starts until the run ends.
          assert.deepEqual(launched, []);

          yield* react([replyItem(worked, reply), runUpdated(worked, "completed")]);
          assert.strictEqual(launched.length, 1);
          assert.include(launched[0]!.initialMessage!.text, reply);

          // The settle redelivered, and the run's end again, start no second turn.
          yield* react([settled(worked, "Cache token lookups"), runUpdated(worked, "completed")]);
          assert.strictEqual(launched.length, 1);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a capture thread whose settle fails is settled when the reactor retries the event, filing nothing twice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { store, launched, settledThreads, failSettles, react, extract } = yield* start;
          yield* store.setCapture({ projectId, enabled: true });
          yield* react([
            ...turn(worked, "Cache token lookups", reply),
            settled(worked, "Cache token lookups"),
          ]);
          const child = launched[0]!.threadId!;
          const filed = Effect.gen(function* () {
            return {
              decisions: (yield* store.listDecisions({ projectId })).map((d) => d.title),
              findings: (yield* store.board(projectId)).issues.map((i) => i.labels),
            };
          });

          failSettles(true);
          yield* extract(child, answer(["Cache token lookups in SQLite, not Redis"]));
          assert.deepEqual(settledThreads, []);
          // The drafts landed before the settle failed.
          const once = {
            decisions: ["Cache token lookups in SQLite, not Redis"],
            findings: [["finding"]],
          };
          assert.deepEqual(yield* filed, once);

          // The next start retries the event.
          failSettles(false);
          yield* react([]);
          assert.deepEqual(settledThreads, [child]);
          assert.deepEqual(yield* filed, once);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a capture run rolled back closes the capture as failed and settles its thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, store, launched, settledThreads, react } = yield* start;
        yield* store.setCapture({ projectId, enabled: true });
        yield* react([
          ...turn(worked, "Cache token lookups", reply),
          settled(worked, "Cache token lookups"),
        ]);
        const child = launched[0]!.threadId!;

        yield* react([
          {
            ...eventBase(),
            type: "thread.created",
            threadId: child,
            payload: appThread(child, "Capture"),
          },
          runUpdated(child, "rolled_back"),
        ]);
        const rows = yield* sql<{ readonly status: string }>`
          SELECT status FROM settle_capture WHERE child_thread_id = ${child}`;
        assert.deepEqual(
          rows.map((row) => row.status),
          ["failed"],
        );
        // Nothing is filed, and the capture thread still leaves the active list.
        assert.deepEqual(yield* store.listDecisions({ projectId }), []);
        assert.deepEqual(settledThreads, [child]);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("with the setting off, no turn starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, launched, routed, react } = yield* start;
        yield* react([
          ...turn(worked, "Cache token lookups", reply),
          settled(worked, "Cache token lookups"),
        ]);
        assert.deepEqual(launched, []);
        assert.deepEqual(routed, []);

        // Turned on and off again: still nothing.
        yield* store.setCapture({ projectId, enabled: true });
        yield* store.setCapture({ projectId, enabled: false });
        assert.isFalse((yield* store.board(projectId)).capture);
        yield* react([settled(worked, "Cache token lookups")]);
        assert.deepEqual(launched, []);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("the capture thread settling starts no capture of its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, launched, react, extract } = yield* start;
        yield* store.setCapture({ projectId, enabled: true });
        yield* react([
          ...turn(worked, "Cache token lookups", reply),
          settled(worked, "Cache token lookups"),
        ]);
        const child = launched[0]!.threadId!;
        yield* extract(child, answer(["Cache token lookups in SQLite, not Redis"]));

        yield* react([settled(child, "Capture")]);
        assert.strictEqual(launched.length, 1);
      }),
    ).pipe(Effect.provide(layerTest)),
  );
});

describe("parseDrafts", () => {
  it("reads the JSON object wherever the model put it and skips entries that do not decode", () => {
    const drafts = SettleCapture.parseDrafts(
      `Here you go:\n${JSON.stringify({
        decisions: [{ title: "Use SQLite", why: "Already shipped." }, { title: "No reason given" }],
        findings: [{ title: "Sweeper leaks rows", evidence: "Seen in the reply." }, "junk"],
      })}\nThat is all.`,
    );
    assert.deepEqual(
      drafts.decisions.map((d) => d.title),
      ["Use SQLite"],
    );
    assert.deepEqual(
      drafts.findings.map((f) => f.title),
      ["Sweeper leaks rows"],
    );
    assert.deepEqual(SettleCapture.parseDrafts("Nothing to record."), {
      decisions: [],
      findings: [],
    });
  });
});
