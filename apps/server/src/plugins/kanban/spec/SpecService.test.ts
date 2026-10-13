import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  KanbanError,
  MessageId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type Project,
  type RoutingEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ServerActivation from "../../../serverActivation.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PluginDatabase from "../../PluginDatabase.ts";
import * as PluginReactor from "../../PluginReactor.ts";
import * as TierSelectionService from "../../routing/TierSelectionService.ts";
import * as KanbanStore from "../KanbanStore.ts";
import { migrations } from "../migrations.ts";
import * as StopGate from "../StopGate.ts";
import * as SpecReactor from "./SpecReactor.ts";
import * as SpecService from "./SpecService.ts";

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
const cheap: RoutingEntry = { providerInstanceId: codex, model: "gpt-5.4-mini" };
const at = DateTime.makeUnsafe("2026-10-12T12:00:00.000Z");
const NO_CHEAP_TIER =
  "The cheap tier is not configured. Use useExisting or enable the routing plugin.";

const rough = "Login loops when the session cookie has expired.";
const validSpec = [
  "## Goal",
  "An expired session sends the user to sign in once, then back.",
  "",
  "## Approach",
  "- Detect the expired cookie in the auth middleware.",
  "- Redirect to sign-in with the original path.",
  "",
  "## Acceptance",
  "- [ ] An expired cookie lands on sign-in exactly once.",
  "- [ ] Signing in returns to the original path.",
].join("\n");
const sixSteps = [
  "## Goal",
  "No loop.",
  "## Approach",
  ...Array.from({ length: 6 }, (_, i) => `- Step ${i + 1}.`),
  "## Acceptance",
  "- [ ] No loop.",
].join("\n");

// A real event sink and projection on an in-memory core database, as the reactor tests use.
const layerCore = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(layerCore),
);
const layerSink = Layer.merge(EventSink.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerStores),
);

const layerTest = Layer.mergeAll(
  layerSink,
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-spec-" })).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

let eventCount = 0;
const eventBase = () => ({
  id: EventId.make(`event:spec-${++eventCount}`),
  providerInstanceId: codex,
  occurredAt: at,
});

const modelSelection = { instanceId: codex, model: cheap.model } satisfies ModelSelection;

/** The drafting thread as the orchestrator records it, so its turn items can be read back. */
const threadCreated = (threadId: ThreadId): OrchestrationV2DomainEvent => ({
  ...eventBase(),
  type: "thread.created",
  threadId,
  payload: {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId,
    title: "Spec",
    providerInstanceId: codex,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "plan",
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
  },
});

const itemBase = (threadId: ThreadId, runId: RunId, ordinal: number) => ({
  id: TurnItemId.make(`item:${threadId}:${ordinal}`),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

const said = (
  threadId: ThreadId,
  runId: RunId,
  ordinal: number,
  text: string,
): OrchestrationV2DomainEvent => ({
  ...eventBase(),
  type: "turn-item.updated",
  threadId,
  runId,
  payload: {
    ...itemBase(threadId, runId, ordinal),
    type: "assistant_message",
    messageId: MessageId.make(`message:${threadId}:${ordinal}`),
    text,
    streaming: false,
  },
});

const planned = (
  threadId: ThreadId,
  runId: RunId,
  ordinal: number,
  markdown: string,
): OrchestrationV2DomainEvent => ({
  ...eventBase(),
  type: "turn-item.updated",
  threadId,
  runId,
  payload: {
    ...itemBase(threadId, runId, ordinal),
    type: "proposed_plan",
    planId: PlanId.make(`plan:${threadId}:${ordinal}`),
    markdown,
    streaming: false,
  },
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

const runUpdated = (
  threadId: ThreadId,
  runId: RunId,
  status: OrchestrationV2Run["status"],
): OrchestrationV2DomainEvent => ({
  ...eventBase(),
  type: "run.updated",
  threadId,
  runId,
  payload: run(threadId, runId, status),
});

/**
 * The plugin's services over a fresh board folder and an in-memory kanban database. Launches go
 * to a stub that records them; `routing` is the tier service the calling fiber holds, if any.
 */
const start = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "kanban", filename: ":memory:", migrations });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  // Runs just before `finish` reads the drafting thread, after it has read its attempt.
  let beforeRecords: Effect.Effect<void> = Effect.void;
  // The real store, except that `admit` can be made to fail, as a rename that cannot complete would,
  // and can be preceded by an edit, as a person's would land between a read and the locked write.
  let admitFails = false;
  let beforeAdmit: Effect.Effect<unknown, KanbanError> = Effect.void;
  const breakableStore = Layer.effect(
    KanbanStore.KanbanStore,
    Effect.map(KanbanStore.KanbanStore, (real) =>
      KanbanStore.KanbanStore.of({
        ...real,
        admit: (...args) =>
          admitFails
            ? Effect.fail(
                new KanbanError({ code: "io", message: "The issue file could not be written." }),
              )
            : Effect.andThen(beforeAdmit, real.admit(...args)),
      }),
    ),
  ).pipe(Layer.provide(KanbanStore.layer));
  const services = yield* Layer.build(
    SpecService.layer.pipe(
      Layer.provideMerge(Layer.merge(breakableStore, StopGate.layer)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId, fields, filter) =>
              Effect.andThen(
                beforeRecords,
                projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
              ),
            getThreadShell: (threadId) => projections.getThreadShell(threadId).pipe(Effect.orDie),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
          }),
        ),
      ),
    ),
  );
  const spec = Context.get(services, SpecService.SpecService);
  const store = Context.get(services, KanbanStore.KanbanStore);
  const gate = Context.get(services, StopGate.StopGate);

  const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const routed: Array<TierSelectionService.Work> = [];
  // The step a launch fails at, after it has recorded the input as the real launcher records the
  // thread; null launches fine.
  let launchFailsAt: ThreadLaunchService.ThreadLaunchError["operation"] | null = null;
  // Runs inside a launch, once it has recorded the input and before it answers or fails.
  let duringLaunch: (input: ThreadLaunchService.ThreadLaunchInput) => Effect.Effect<void> = () =>
    Effect.void;
  const launcher = ThreadLaunchService.ThreadLaunchService.of({
    launch: (input) =>
      Effect.suspend(() => {
        launched.push(input);
        return duringLaunch(input);
      }).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (launchFailsAt !== null)
              return Effect.fail(
                new ThreadLaunchService.ThreadLaunchError({
                  operation: launchFailsAt,
                  commandId: input.commandId,
                  projectId: input.projectId,
                  cause: new Error("The provider is offline."),
                }),
              );
            // Only the thread id is read.
            return Effect.succeed({
              threadId: input.threadId ?? ThreadId.make("unused"),
              resumed: false,
              projection: {} as never,
            });
          }),
        ),
      ),
    checkWorktreeBase: () => Effect.void,
    retryPreparation: () => Effect.die("unused"),
  });
  const tiers = (entry: RoutingEntry | null) =>
    TierSelectionService.TierSelectionService.of({
      recommend: (work) =>
        Effect.sync(() => {
          routed.push(work);
          return { taskClass: work.taskClass, tier: "cheap", reason: "rule", failedRuns: 0, entry };
        }),
      record: () => Effect.void,
    });

  /** `specify` from a request fiber holding the launcher and, unless null, the tier service. */
  const specify = (
    input: Parameters<SpecService.SpecService["Service"]["specify"]>[0],
    routing: RoutingEntry | null | "off" = cheap,
  ) =>
    spec
      .specify(input)
      .pipe(
        Effect.provideService(ThreadLaunchService.ThreadLaunchService, launcher),
        routing === "off"
          ? (effect) => effect
          : Effect.provideService(TierSelectionService.TierSelectionService, tiers(routing)),
      );

  /** Commits events, then runs the reactor until it has handled every one. */
  const react = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    Effect.gen(function* () {
      yield* (yield* EventSink.EventSinkV2).write({ events });
      yield* Effect.scoped(
        Effect.flatMap(
          PluginReactor.start({
            plugin: "kanban",
            from: "start",
            handlers: SpecReactor.handlers(spec),
          }),
          (reactor) => reactor.drain,
        ),
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    });

  /** Files a rough issue as an agent would: in Triage. */
  const file = (title: string, description: string) =>
    store.write(projectId, "thread:agent", { action: "issue.create", title, description });

  const fileText = (id: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory } = yield* store.board(projectId);
      return yield* fs.readFileString(path.join(directory, "issues", `${id}.md`));
    });

  const failAdmit = (fails: boolean) => {
    admitFails = fails;
  };

  const editBeforeAdmit = (edit: Effect.Effect<unknown, KanbanError>) => {
    beforeAdmit = edit;
  };

  const beforeThreadRead = (effect: Effect.Effect<void>) => {
    beforeRecords = effect;
  };

  const whileLaunching = (effect: typeof duringLaunch) => {
    duringLaunch = effect;
  };

  const failLaunch = (operation: typeof launchFailsAt) => {
    launchFailsAt = operation;
  };

  /** The attempts as stored, for a card that is gone and so has no `latest` report. */
  const attempts = sql<{
    readonly status: string;
    readonly reason: string | null;
  }>`SELECT status, reason FROM spec_attempt ORDER BY id`;
  /** Events the reactor gave up on or is holding for a retry. */
  const reactorFailures = sql<{
    readonly sequence: number;
  }>`SELECT sequence FROM host_reactor_failure`;

  return {
    spec,
    sql,
    store,
    gate,
    launched,
    routed,
    specify,
    react,
    file,
    fileText,
    attempts,
    reactorFailures,
    failAdmit,
    editBeforeAdmit,
    beforeThreadRead,
    whileLaunching,
    failLaunch,
  };
});

const refusal = <A>(effect: Effect.Effect<A, KanbanError>) =>
  effect.pipe(
    Effect.flatMap(() => Effect.die("expected a refusal")),
    Effect.catchTags({ KanbanError: (error) => Effect.succeed(error) }),
  );

describe("SpecService", () => {
  it.effect("a valid draft fills the criteria, clears triage and admits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, store, launched, routed, specify, react, file } = yield* start;
        const { id } = yield* file("Login loops", rough);
        // One criterion the draft keeps and one it drops.
        yield* store.write(projectId, "thread:agent", {
          action: "criterion.add",
          id,
          text: "Signing in returns to the original path.",
        });
        yield* store.write(projectId, "thread:agent", {
          action: "criterion.add",
          id,
          text: "Stale guess.",
        });

        const attempt = yield* specify({ projectId, id });
        assert.strictEqual(attempt.status, "running");
        assert.strictEqual(attempt.source, "child");
        assert.deepEqual(routed, [{ projectId, taskClass: "mechanical", earlierThreadIds: [] }]);
        assert.lengthOf(launched, 1);
        const child = launched[0]!;
        assert.strictEqual(child.threadId, attempt.childThreadId);
        assert.strictEqual(child.interactionMode, "plan");
        assert.deepEqual(child.modelSelection, modelSelection);
        assert.include(child.initialMessage?.text, rough);
        assert.include(child.initialMessage?.text, "## Acceptance");
        assert.deepEqual(yield* spec.latest({ projectId, id }), { attempt, issueStatus: "triage" });

        // Plan mode answers with a proposed plan; the chatter after it is not the spec.
        const threadId = child.threadId!;
        const runId = RunId.make("run:spec-1");
        yield* react([
          threadCreated(threadId),
          runUpdated(threadId, runId, "running"),
          planned(threadId, runId, 1, validSpec),
          said(threadId, runId, 2, "I proposed the spec above."),
          runUpdated(threadId, runId, "completed"),
        ]);

        const issue = yield* store.getIssue({ projectId, id });
        assert.strictEqual(issue.status, "todo");
        assert.deepEqual(
          issue.criteria.map((c) => [c.id, c.text, c.checked]),
          [
            ["c3", "An expired cookie lands on sign-in exactly once.", false],
            ["c1", "Signing in returns to the original path.", false],
          ],
        );
        assert.deepEqual(
          issue.log.filter((entry) => entry.by === "spec").map((entry) => entry.text),
          [
            "removed: Stale guess.",
            "added: An expired cookie lands on sign-in exactly once.",
            "todo",
          ],
        );
        assert.strictEqual(issue.description, rough);
        const decided = yield* spec.latest({ projectId, id });
        assert.strictEqual(decided?.issueStatus, "todo");
        assert.strictEqual(decided?.attempt.status, "valid");
        assert.strictEqual(decided?.attempt.text, validSpec);
        assert.isNull(decided?.attempt.reason);
        assert.isNotNull(decided?.attempt.completedAt);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a description edited while the child drafts: malformed, the card stays in Triage",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { spec, store, launched, specify, react, file, fileText } = yield* start;
          const { id } = yield* file("Login loops", rough);

          yield* specify({ projectId, id });
          // A person rewrites the description while the child drafts from the old one.
          yield* store.write(projectId, "user", {
            action: "issue.update",
            id,
            description: "Login loops when the session cookie has expired, but only on Safari.",
          });
          const edited = yield* fileText(id);
          const threadId = launched[0]!.threadId!;
          const runId = RunId.make("run:spec-edited");
          yield* react([
            threadCreated(threadId),
            planned(threadId, runId, 1, validSpec),
            runUpdated(threadId, runId, "completed"),
          ]);

          const report = yield* spec.latest({ projectId, id });
          assert.strictEqual(report?.attempt.status, "malformed");
          assert.strictEqual(
            report?.attempt.reason,
            "The issue changed while the spec was drafted. Run specify again.",
          );
          assert.strictEqual(report?.attempt.text, validSpec);
          assert.isNotNull(report?.attempt.completedAt);
          assert.strictEqual(report?.issueStatus, "triage");
          assert.strictEqual(yield* fileText(id), edited);
          assert.lengthOf((yield* store.getIssue({ projectId, id })).criteria, 0);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a description edited and the card moved on while the child drafts: malformed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, store, launched, specify, react, file, fileText } = yield* start;
        const { id } = yield* file("Login loops", rough);

        yield* specify({ projectId, id });
        // Out of Triage, so the column alone would have left the attempt valid.
        yield* store.write(projectId, "user", {
          action: "issue.update",
          id,
          description: "Login loops when the session cookie has expired, but only on Safari.",
        });
        yield* store.write(projectId, "user", { action: "issue.move", id, status: "todo" });
        const edited = yield* fileText(id);
        const threadId = launched[0]!.threadId!;
        const runId = RunId.make("run:spec-edited-moved");
        yield* react([
          threadCreated(threadId),
          planned(threadId, runId, 1, validSpec),
          runUpdated(threadId, runId, "completed"),
        ]);

        const report = yield* spec.latest({ projectId, id });
        assert.strictEqual(report?.attempt.status, "malformed");
        assert.strictEqual(
          report?.attempt.reason,
          "The issue changed while the spec was drafted. Run specify again.",
        );
        assert.strictEqual(report?.issueStatus, "todo");
        assert.strictEqual(yield* fileText(id), edited);
        assert.lengthOf((yield* store.getIssue({ projectId, id })).criteria, 0);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a title edited while the child drafts: malformed, the card stays in Triage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, store, launched, specify, react, file, fileText } = yield* start;
        const { id } = yield* file("Login loops", rough);

        yield* specify({ projectId, id });
        // The child was asked to spec the old title; the description is as it was.
        yield* store.write(projectId, "user", {
          action: "issue.update",
          id,
          title: "Login loops on Safari",
        });
        const edited = yield* fileText(id);
        const threadId = launched[0]!.threadId!;
        const runId = RunId.make("run:spec-retitled");
        yield* react([
          threadCreated(threadId),
          planned(threadId, runId, 1, validSpec),
          runUpdated(threadId, runId, "completed"),
        ]);

        const report = yield* spec.latest({ projectId, id });
        assert.strictEqual(report?.attempt.status, "malformed");
        assert.strictEqual(
          report?.attempt.reason,
          "The issue changed while the spec was drafted. Run specify again.",
        );
        assert.strictEqual(report?.issueStatus, "triage");
        assert.strictEqual(yield* fileText(id), edited);
        assert.lengthOf((yield* store.getIssue({ projectId, id })).criteria, 0);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a card deleted and recreated with the same text while the child drafts: malformed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { spec, store, launched, specify, react, file, fileText } = yield* start;
          const { id } = yield* file("Login loops", rough);

          yield* specify({ projectId, id });
          // The card is archived, deleted and filed again with the same title and text, so it gets
          // the same slug. Only its creation time differs.
          yield* store.write(projectId, "user", { action: "issue.archive", id });
          yield* store.write(projectId, "user", { action: "issue.delete", id });
          yield* TestClock.adjust("1 second");
          const again = yield* file("Login loops", rough);
          assert.strictEqual(again.id, id);
          const recreated = yield* fileText(id);
          const threadId = launched[0]!.threadId!;
          const runId = RunId.make("run:spec-recreated");
          yield* react([
            threadCreated(threadId),
            planned(threadId, runId, 1, validSpec),
            runUpdated(threadId, runId, "completed"),
          ]);

          const report = yield* spec.latest({ projectId, id });
          assert.strictEqual(report?.attempt.status, "malformed");
          assert.strictEqual(
            report?.attempt.reason,
            "The issue changed while the spec was drafted. Run specify again.",
          );
          assert.strictEqual(report?.issueStatus, "triage");
          assert.strictEqual(yield* fileText(id), recreated);
          assert.lengthOf((yield* store.getIssue({ projectId, id })).criteria, 0);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("the drafting thread runs with the modes the caller passed, else the strictest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { launched, specify, file } = yield* start;
        const first = yield* file("Login loops", rough);
        const second = yield* file("Logout loops", rough);

        // The gateway passes none.
        yield* specify({ projectId, id: first.id });
        assert.strictEqual(launched[0]?.runtimeMode, "approval-required");
        assert.strictEqual(launched[0]?.interactionMode, "plan");

        // The MCP tool passes what it resolved against its caller's modes.
        yield* specify({
          projectId,
          id: second.id,
          modes: { runtimeMode: "auto-accept-edits", interactionMode: "default" },
        });
        assert.strictEqual(launched[1]?.runtimeMode, "auto-accept-edits");
        assert.strictEqual(launched[1]?.interactionMode, "default");
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a card deleted while the child drafts: malformed, and the reactor does not retry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { spec, launched, specify, react, file, store, attempts, reactorFailures } =
            yield* start;
          const { id } = yield* file("Login loops", rough);

          yield* specify({ projectId, id });
          yield* store.write(projectId, "user", { action: "issue.archive", id });
          yield* store.write(projectId, "user", { action: "issue.delete", id });
          const threadId = launched[0]!.threadId!;
          const runId = RunId.make("run:spec-deleted");
          yield* react([
            threadCreated(threadId),
            planned(threadId, runId, 1, validSpec),
            runUpdated(threadId, runId, "completed"),
          ]);

          assert.deepEqual(yield* attempts, [
            { status: "malformed", reason: "The issue was deleted while the spec was drafted." },
          ]);
          assert.lengthOf(yield* reactorFailures, 0);

          // The report is still readable once the card is gone, and says so.
          const report = yield* spec.latest({ projectId, id });
          assert.strictEqual(report?.attempt.status, "malformed");
          assert.strictEqual(
            report?.attempt.reason,
            "The issue was deleted while the spec was drafted.",
          );
          assert.isNull(report?.issueStatus);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("useExisting: a card deleted before the admission is malformed too", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, store, specify, file, attempts, editBeforeAdmit } = yield* start;
        const { id } = yield* file("Login loops", validSpec);

        editBeforeAdmit(
          TestClock.adjust("1 second").pipe(
            Effect.andThen(store.write(projectId, "user", { action: "issue.archive", id })),
            Effect.andThen(store.write(projectId, "user", { action: "issue.delete", id })),
          ),
        );
        const attempt = yield* specify({ projectId, id, useExisting: true });
        assert.strictEqual(attempt.status, "malformed");
        assert.strictEqual(attempt.reason, "The issue was deleted while the spec was drafted.");
        assert.deepEqual(yield* attempts, [{ status: "malformed", reason: attempt.reason }]);
        assert.deepEqual((yield* spec.latest({ projectId, id }))?.attempt, attempt);
        assert.notStrictEqual(attempt.completedAt, attempt.createdAt);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "starting the plugin closes an attempt whose thread or first run was never created",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { spec, sql, launched, specify, react, file } = yield* start;
          const noThread = yield* file("Login loops", rough);
          const noRun = yield* file("Logout loops", rough);
          const started = yield* file("Signin loops", rough);
          yield* specify({ projectId, id: noThread.id });
          yield* specify({ projectId, id: noRun.id });
          yield* specify({ projectId, id: started.id });
          // The process exited after storing all three attempts. The second launch got as far as
          // creating its thread, the third as far as creating its run.
          const [, noRunThread, startedThread] = launched.map((input) => input.threadId!);
          const runId = RunId.make("run:spec-started");
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              threadCreated(noRunThread!),
              threadCreated(startedThread!),
              runUpdated(startedThread!, runId, "running"),
            ],
          });

          // The plugin starts later, and the layer runs the reconciliation once, after activation.
          yield* TestClock.adjust("1 second");
          const reconciled = yield* Deferred.make<void>();
          const withSignal = Layer.succeed(
            SpecService.SpecService,
            SpecService.SpecService.of({
              ...spec,
              reconcile: (cutoff) =>
                Effect.ensuring(spec.reconcile(cutoff), Deferred.succeed(reconciled, undefined)),
            }),
          );
          yield* Layer.build(
            SpecReactor.layer.pipe(
              Layer.provide(withSignal),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            ),
          );
          yield* Deferred.await(reconciled);

          for (const { id } of [noThread, noRun]) {
            const closed = yield* spec.latest({ projectId, id });
            assert.strictEqual(closed?.attempt.status, "malformed");
            assert.strictEqual(
              closed?.attempt.reason,
              "The drafting thread was never started. Run specify again.",
            );
            assert.isNotNull(closed?.attempt.completedAt);
            assert.strictEqual(closed?.issueStatus, "triage");
          }
          assert.strictEqual(
            (yield* spec.latest({ projectId, id: started.id }))?.attempt.status,
            "running",
          );

          // Its run's end still reaches the reactor, and the spec admits the card.
          yield* react([
            planned(startedThread!, runId, 1, validSpec),
            runUpdated(startedThread!, runId, "completed"),
          ]);
          const decided = yield* spec.latest({ projectId, id: started.id });
          assert.strictEqual(decided?.attempt.status, "valid");
          assert.strictEqual(decided?.issueStatus, "todo");
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a launch error that closes the attempt first wins over the run's end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, sql, store, launched, specify, react, file, fileText, beforeThreadRead } =
          yield* start;
        const { id } = yield* file("Login loops", rough);
        yield* specify({ projectId, id });
        const before = yield* fileText(id);

        // The launch's error closes the attempt after `finish` has read it as running and before
        // it writes.
        beforeThreadRead(
          sql`UPDATE spec_attempt SET status = 'malformed', reason = 'The launch failed.',
            completed_at = '1970-01-01T00:00:00.000Z' WHERE status = 'running'`.pipe(
            Effect.orDie,
            Effect.asVoid,
          ),
        );
        const threadId = launched[0]!.threadId!;
        const runId = RunId.make("run:spec-race-launch-first");
        yield* react([
          threadCreated(threadId),
          planned(threadId, runId, 1, validSpec),
          runUpdated(threadId, runId, "completed"),
        ]);

        const report = yield* spec.latest({ projectId, id });
        assert.strictEqual(report?.attempt.status, "malformed");
        assert.strictEqual(report?.attempt.reason, "The launch failed.");
        // The run's end changed nothing, and the card was not admitted on a spec it lost.
        assert.strictEqual(report?.issueStatus, "triage");
        assert.strictEqual(yield* fileText(id), before);
        assert.lengthOf((yield* store.getIssue({ projectId, id })).criteria, 0);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a run's end that lands first is not overwritten by a late launch error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, store, specify, react, file, whileLaunching, failLaunch } = yield* start;
        const { id } = yield* file("Login loops", rough);
        const sink = yield* EventSink.EventSinkV2;

        // The run finishes while the launcher is still working, then the launch reports an error.
        whileLaunching((input) =>
          react([
            threadCreated(input.threadId!),
            planned(input.threadId!, RunId.make("run:spec-race-run-first"), 1, validSpec),
            runUpdated(input.threadId!, RunId.make("run:spec-race-run-first"), "completed"),
          ]).pipe(Effect.provideService(EventSink.EventSinkV2, sink), Effect.orDie),
        );
        failLaunch("dispatch-message");
        const error = yield* refusal(specify({ projectId, id }));
        assert.strictEqual(error.code, "io");

        const report = yield* spec.latest({ projectId, id });
        assert.strictEqual(report?.attempt.status, "valid");
        assert.isNull(report?.attempt.reason);
        assert.strictEqual(report?.attempt.text, validSpec);
        assert.strictEqual(report?.issueStatus, "todo");
        assert.lengthOf((yield* store.getIssue({ projectId, id })).criteria, 2);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "an attempt stored after the layer was built is not closed by a late reconciliation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { spec, sql, specify, file } = yield* start;
          const early = yield* file("Login loops", rough);
          const late = yield* file("Logout loops", rough);
          yield* specify({ projectId, id: early.id });

          // The layer is built, and the reconciliation parked until activation.
          yield* TestClock.adjust("1 second");
          const activation = yield* Deferred.make<void>();
          const reconciled = yield* Deferred.make<void>();
          const withSignal = Layer.succeed(
            SpecService.SpecService,
            SpecService.SpecService.of({
              ...spec,
              reconcile: (cutoff) =>
                Effect.ensuring(spec.reconcile(cutoff), Deferred.succeed(reconciled, undefined)),
            }),
          );
          yield* Layer.build(
            SpecReactor.layer.pipe(
              Layer.provide(withSignal),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
              Layer.provide(
                Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
              ),
            ),
          );

          // A request is accepted after the build; its thread is not created yet. Activation, and so
          // the reconciliation, comes later still.
          yield* TestClock.adjust("1 second");
          yield* specify({ projectId, id: late.id });
          yield* TestClock.adjust("1 second");
          yield* Deferred.succeed(activation, undefined);
          yield* Deferred.await(reconciled);

          const closed = yield* spec.latest({ projectId, id: early.id });
          assert.strictEqual(closed?.attempt.status, "malformed");
          assert.strictEqual(
            closed?.attempt.reason,
            "The drafting thread was never started. Run specify again.",
          );
          assert.strictEqual(
            (yield* spec.latest({ projectId, id: late.id }))?.attempt.status,
            "running",
          );
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("six Approach items: malformed with the reason, the ticket untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, store, launched, specify, react, file, fileText } = yield* start;
        const { id } = yield* file("Login loops", rough);
        const before = yield* fileText(id);

        yield* specify({ projectId, id });
        const threadId = launched[0]!.threadId!;
        const runId = RunId.make("run:spec-6");
        yield* react([
          threadCreated(threadId),
          said(threadId, runId, 1, sixSteps),
          runUpdated(threadId, runId, "completed"),
        ]);

        const report = yield* spec.latest({ projectId, id });
        assert.strictEqual(report?.attempt.status, "malformed");
        assert.strictEqual(report?.attempt.reason, "Approach has 6 items; the limit is 5.");
        assert.strictEqual(report?.attempt.text, sixSteps);
        assert.strictEqual(report?.issueStatus, "triage");
        assert.strictEqual(yield* fileText(id), before);
        assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "triage");
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a drafting run that ends without completing leaves a malformed attempt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, launched, specify, react, file, fileText } = yield* start;
        const { id } = yield* file("Login loops", rough);
        const before = yield* fileText(id);

        yield* specify({ projectId, id });
        const threadId = launched[0]!.threadId!;
        yield* react([
          threadCreated(threadId),
          runUpdated(threadId, RunId.make("run:spec-failed"), "failed"),
        ]);

        const report = yield* spec.latest({ projectId, id });
        assert.strictEqual(report?.attempt.status, "malformed");
        assert.strictEqual(
          report?.attempt.reason,
          "The drafting run ended failed before it sent a spec.",
        );
        assert.strictEqual(yield* fileText(id), before);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("useExisting validates the description and never starts a thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, launched, routed, specify, file, fileText } = yield* start;

        const written = yield* file("Login loops", validSpec);
        // No tier service at all: the description path needs no model.
        const valid = yield* specify({ projectId, id: written.id, useExisting: true }, "off");
        assert.strictEqual(valid.status, "valid");
        assert.strictEqual(valid.source, "existing");
        assert.isNull(valid.childThreadId);
        const admitted = yield* store.getIssue({ projectId, id: written.id });
        assert.strictEqual(admitted.status, "todo");
        assert.deepEqual(
          admitted.criteria.map((c) => c.text),
          [
            "An expired cookie lands on sign-in exactly once.",
            "Signing in returns to the original path.",
          ],
        );
        assert.strictEqual(admitted.description, validSpec);

        const roughIssue = yield* file("Something else", rough);
        const before = yield* fileText(roughIssue.id);
        const malformed = yield* specify({ projectId, id: roughIssue.id, useExisting: true });
        assert.strictEqual(malformed.status, "malformed");
        assert.strictEqual(malformed.reason, "Missing section: Goal.");
        assert.strictEqual(yield* fileText(roughIssue.id), before);

        assert.lengthOf(launched, 0);
        assert.lengthOf(routed, 0);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("useExisting: a description edited before the admission is not admitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, store, specify, file, fileText, editBeforeAdmit } = yield* start;
        const { id } = yield* file("Login loops", validSpec);

        // The edit lands after `specify` has read and validated the issue, and time passes before
        // the attempt is moved to malformed.
        editBeforeAdmit(
          TestClock.adjust("1 second").pipe(
            Effect.andThen(
              store.write(projectId, "user", {
                action: "issue.update",
                id,
                description: `${validSpec}\n- [ ] A late addition.`,
              }),
            ),
          ),
        );
        const attempt = yield* specify({ projectId, id, useExisting: true });
        assert.strictEqual(attempt.status, "malformed");
        assert.strictEqual(
          attempt.reason,
          "The issue changed while the spec was drafted. Run specify again.",
        );
        const edited = yield* fileText(id);
        const report = yield* spec.latest({ projectId, id });
        assert.strictEqual(report?.attempt.status, "malformed");
        assert.strictEqual(report?.attempt.reason, attempt.reason);
        // The reply is the row that was written, completion time included.
        assert.deepEqual(report?.attempt, attempt);
        assert.notStrictEqual(attempt.completedAt, attempt.createdAt);
        assert.strictEqual(report?.issueStatus, "triage");
        assert.lengthOf((yield* store.getIssue({ projectId, id })).criteria, 0);

        // Run again over the text as it stands now.
        editBeforeAdmit(Effect.void);
        assert.strictEqual((yield* specify({ projectId, id, useExisting: true })).status, "valid");
        assert.notStrictEqual(yield* fileText(id), edited);
        const admitted = yield* store.getIssue({ projectId, id });
        assert.strictEqual(admitted.status, "todo");
        assert.lengthOf(admitted.criteria, 3);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "useExisting stores the valid attempt before admitting, and specify again recovers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { spec, store, specify, file, failAdmit } = yield* start;
          const { id } = yield* file("Login loops", validSpec);

          // The admission cannot finish, as after a crash between the attempt and the issue file.
          failAdmit(true);
          const error = yield* refusal(specify({ projectId, id, useExisting: true }));
          assert.strictEqual(error.code, "io");
          const stored = yield* spec.latest({ projectId, id });
          assert.strictEqual(stored?.attempt.status, "valid");
          assert.strictEqual(stored?.attempt.source, "existing");
          // A valid spec is not an admitted card, and the report says where the card is.
          assert.strictEqual(stored?.issueStatus, "triage");
          assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "triage");

          // The card is still in Triage, so the "already admitted" refusal does not apply.
          failAdmit(false);
          const again = yield* specify({ projectId, id, useExisting: true });
          assert.strictEqual(again.status, "valid");
          assert.notStrictEqual(again.id, stored?.attempt.id);
          assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "todo");
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a valid draft for a card that moved meanwhile does not admit it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, store, launched, specify, react, file } = yield* start;
        const { id } = yield* file("Login loops", rough);

        yield* specify({ projectId, id });
        // A person moves the card while the child drafts.
        yield* store.write(projectId, "user", { action: "issue.move", id, status: "in_progress" });
        const threadId = launched[0]!.threadId!;
        yield* react([
          threadCreated(threadId),
          planned(threadId, RunId.make("run:spec-moved"), 1, validSpec),
          runUpdated(threadId, RunId.make("run:spec-moved"), "completed"),
        ]);

        const report = yield* spec.latest({ projectId, id });
        assert.strictEqual(report?.attempt.status, "valid");
        assert.strictEqual(report?.issueStatus, "in_progress");
        assert.lengthOf((yield* store.getIssue({ projectId, id })).criteria, 0);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a launch that fails closes its attempt, and the run it may have started is ignored",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { spec, store, launched, specify, react, file, failLaunch } = yield* start;
          const { id } = yield* file("Login loops", rough);

          // The launcher stores the thread and its message before a later step fails.
          failLaunch("dispatch-message");
          const error = yield* refusal(specify({ projectId, id }));
          assert.strictEqual(error.code, "io");
          assert.lengthOf(launched, 1);
          const child = launched[0]!;
          const closed = yield* spec.latest({ projectId, id });
          assert.strictEqual(closed?.attempt.status, "malformed");
          assert.strictEqual(closed?.attempt.childThreadId, child.threadId);
          assert.strictEqual(
            closed?.attempt.reason,
            `The drafting thread could not be started: Thread launch ${child.commandId} failed during dispatch-message.`,
          );
          assert.isNotNull(closed?.attempt.completedAt);

          // The run went on regardless and sends a valid spec: there is no attempt to report into.
          const threadId = child.threadId!;
          const runId = RunId.make("run:spec-orphan");
          yield* react([
            threadCreated(threadId),
            planned(threadId, runId, 1, validSpec),
            runUpdated(threadId, runId, "completed"),
          ]);
          assert.deepEqual(yield* spec.latest({ projectId, id }), closed);
          assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "triage");

          // The card is still in Triage, so the person can run `specify` again.
          failLaunch(null);
          const again = yield* specify({ projectId, id });
          assert.strictEqual(again.status, "running");
          assert.notStrictEqual(again.id, closed?.attempt.id);
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("no model for the cheap tier: refused, nothing launched or stored", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spec, launched, specify, file } = yield* start;
        const { id } = yield* file("Login loops", rough);

        for (const routing of ["off", null] as const) {
          const error = yield* refusal(specify({ projectId, id }, routing));
          assert.strictEqual(error.code, "invalid");
          assert.strictEqual(error.message, NO_CHEAP_TIER);
        }
        assert.lengthOf(launched, 0);
        assert.isNull(yield* spec.latest({ projectId, id }));
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("an admitted ticket is refused on both paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, launched, specify } = yield* start;
        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Released work",
          description: validSpec,
        });
        for (const useExisting of [false, true]) {
          const error = yield* refusal(specify({ projectId, id, useExisting }));
          assert.strictEqual(error.message, "This ticket is already admitted.");
        }
        assert.lengthOf(launched, 0);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("the emergency stop holds back the drafting thread, not useExisting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { gate, launched, specify, file } = yield* start;
        const { id } = yield* file("Login loops", validSpec);
        yield* gate.set({ setBy: "user" });

        const error = yield* refusal(specify({ projectId, id }));
        assert.strictEqual(error.code, "gated");
        assert.lengthOf(launched, 0);
        assert.strictEqual((yield* specify({ projectId, id, useExisting: true })).status, "valid");
      }),
    ).pipe(Effect.provide(layerTest)),
  );
});
