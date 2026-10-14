import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type KanbanDecision,
  type KanbanError,
  type KanbanFinding,
  type KanbanFindingDisposition,
  type Project,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ClassifySweep from "../learning/ClassifySweep.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import * as ItemStore from "../learning/items/ItemStore.ts";
import { migrations } from "../learning/migrations.ts";
import { rememberThread } from "../learning/producers/threads.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import {
  ISSUE_EXTENSION,
  parseDecisions,
  serializeDecisions,
  serializeIssue,
} from "./KanbanFiles.ts";
import * as KanbanStore from "./KanbanStore.ts";

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

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(KanbanStore.layer),
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
  ),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** A finding with `disposition`, captured at `at`. */
const finding = (disposition: KanbanFindingDisposition, at: string): KanbanFinding => ({
  id: "cookie-path",
  title: "Cookie path is too broad",
  evidence: "Set-Cookie: sid=...; Path=/",
  truthStatus: "seen",
  scopeRelation: "adjacent",
  disposition,
  proposedBy: "thread:thr_finder",
  proposedAt: at,
  threadId: ThreadId.make("thr_finder"),
  review: null,
});

const failureCode = <A>(effect: Effect.Effect<A, KanbanError>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error.code)),
  );

/** The learning plugin's correction store and classify sweep, over a fresh database of its own. */
const learningPlugin = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "learning", filename: ":memory:", migrations });
  const context = yield* Layer.build(
    Layer.mergeAll(CorrectionStore.layer, ItemStore.layer).pipe(
      Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)),
    ),
  );
  const classify = yield* ClassifySweep.sweep.pipe(Effect.provide(context));
  return {
    corrections: Context.get(context, CorrectionStore.CorrectionStore),
    /** A thread of the project, as the plugin's reactor learns it from the thread's events. */
    remember: (id: ThreadId) =>
      rememberThread({ id, projectId }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    classify: classify.run({ dryRun: false }),
  };
});

/**
 * What a test holds of a store whose issues-folder watcher it drives: `events` are the watcher's
 * events, `held` is set when a refresh has read an issue file and `release` lets it go on, and
 * `drained` is set when the watcher takes the event named `sentinel`, which it only does once the
 * refresh in hand has finished. `removing` says the store has started removing an issue file.
 */
const driveWatcher = Effect.gen(function* () {
  return {
    events: yield* Queue.unbounded<FileSystem.WatchEvent>(),
    held: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
    drained: yield* Deferred.make<void>(),
    removing: false,
  };
});

const sentinel = "sentinel";

/**
 * The real file system, except that the issues folder's watcher delivers only what the test
 * offers, the first read of an issue file waits for the test once it has the file's text, and the
 * store's removal of an issue file is noted. (A write also removes its temp folder; that is not it.)
 */
const drivenFileSystem = (control: Effect.Success<typeof driveWatcher>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) => {
      let holding = true;
      return {
        ...real,
        watch: (dir) =>
          dir.endsWith("issues")
            ? Stream.fromQueue(control.events).pipe(
                Stream.tap((event) =>
                  event.path === sentinel
                    ? Deferred.succeed(control.drained, undefined)
                    : Effect.void,
                ),
              )
            : Stream.never,
        readFileString: (file, encoding) =>
          Effect.tap(real.readFileString(file, encoding), () => {
            if (!holding || !file.endsWith(ISSUE_EXTENSION)) return Effect.void;
            holding = false;
            return Effect.andThen(
              Deferred.succeed(control.held, undefined),
              Deferred.await(control.release),
            );
          }),
        remove: (file, options) =>
          Effect.suspend(() => {
            if (file.endsWith(ISSUE_EXTENSION)) control.removing = true;
            return real.remove(file, options);
          }),
      } satisfies FileSystem.FileSystem;
    }),
  );

const layerDriven = (control: Effect.Success<typeof driveWatcher>) =>
  KanbanStore.layer.pipe(
    Layer.provide(drivenFileSystem(control)),
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      }),
    ),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("hashSource", () => {
  const issue = { createdAt: "2026-10-12T00:00:00.000Z", title: "A", description: "B\nC" };

  it("is the same for the same issue and differs when any field does", () => {
    assert.strictEqual(KanbanStore.hashSource(issue), KanbanStore.hashSource({ ...issue }));
    for (const changed of [
      { createdAt: "2026-10-12T00:00:01.000Z" },
      { title: "A2" },
      { description: "B\nC2" },
    ])
      assert.notStrictEqual(
        KanbanStore.hashSource(issue),
        KanbanStore.hashSource({ ...issue, ...changed }),
      );
  });

  it("does not move text across a field boundary", () => {
    // Joined with newlines, both of these would be "A\nB\nC".
    assert.notStrictEqual(
      KanbanStore.hashSource({ ...issue, title: "A", description: "B\nC" }),
      KanbanStore.hashSource({ ...issue, title: "A\nB", description: "C" }),
    );
    assert.notStrictEqual(
      KanbanStore.hashSource({ ...issue, title: "A", description: "" }),
      KanbanStore.hashSource({ ...issue, title: "", description: "A" }),
    );
  });
});

it.layer(layerTest)("KanbanStore", (it) => {
  describe("issues", () => {
    it.effect("creates a user issue in Todo as a markdown file and lists it without its body", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { baseDir } = yield* ServerConfig.ServerConfig;

        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Fix login redirect",
          description: "Loops on an expired cookie.",
        });
        assert.strictEqual(id, "fix-login-redirect");
        const board = yield* store.board(projectId);
        assert.strictEqual(board.directory, path.join(baseDir, "wiki", "grand-theft-repo"));
        const card = board.issues.find((issue) => issue.id === id);
        assert.strictEqual(card?.status, "todo");
        assert.strictEqual(card?.priority, "p3");
        assert.isFalse("description" in (card ?? {}));
        const file = yield* fs.readFileString(path.join(board.directory, "issues", `${id}.md`));
        assert.include(file, "project: grand-theft-repo");
        assert.include(file, "Loops on an expired cookie.");
        const full = yield* store.getIssue({ projectId, id });
        assert.strictEqual(full.log[0]?.kind, "status");
        assert.strictEqual(full.log[0]?.text, "todo");

        const second = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Fix login redirect",
        });
        assert.strictEqual(second.id, "fix-login-redirect-2");
      }),
    );

    it.effect("gates agents: they file into Triage and cannot release work; the user can", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const agent = "thread:thr_agent";
        assert.strictEqual(
          yield* failureCode(
            store.write(projectId, agent, {
              action: "issue.create",
              title: "Sneaky",
              status: "todo",
            }),
          ),
          "gated",
        );
        const { id } = yield* store.write(projectId, agent, {
          action: "issue.create",
          title: "Found a bug",
          verification: "partial",
        });
        assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "triage");
        yield* store.write(projectId, agent, { action: "issue.move", id, status: "inbox" });
        assert.strictEqual(
          yield* failureCode(
            store.write(projectId, agent, { action: "issue.move", id, status: "todo" }),
          ),
          "gated",
        );
        assert.strictEqual(
          yield* failureCode(
            store.write(projectId, agent, {
              action: "issue.link",
              id,
              threadId: ThreadId.make("thr_agent"),
            }),
          ),
          "gated",
        );
        yield* store.write(projectId, "user", { action: "issue.move", id, status: "todo" });
        yield* store.write(projectId, agent, {
          action: "issue.link",
          id,
          threadId: ThreadId.make("thr_agent"),
        });
        const issue = yield* store.getIssue({ projectId, id });
        assert.strictEqual(issue.status, "todo");
        assert.deepStrictEqual(
          issue.threads.map((link) => link.id),
          [ThreadId.make("thr_agent")],
        );
      }),
    );

    it.effect("advances linked work forward only and never out of the holding columns", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const threadId = ThreadId.make("thr_work");
        const todo = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Ship it",
        });
        yield* store.write(projectId, "user", {
          action: "issue.noDecision",
          id: todo.id,
          reason: "Nothing to choose between.",
        });
        yield* store.write(projectId, "user", { action: "issue.link", id: todo.id, threadId });
        const held = yield* store.write(projectId, "thread:x", {
          action: "issue.create",
          title: "Held",
        });
        yield* store.write(projectId, "user", { action: "issue.link", id: held.id, threadId });

        yield* store.advance(projectId, threadId, "in_progress");
        assert.strictEqual(
          (yield* store.getIssue({ projectId, id: todo.id })).status,
          "in_progress",
        );
        assert.strictEqual((yield* store.getIssue({ projectId, id: held.id })).status, "triage");
        assert.strictEqual(yield* store.linkedProject(threadId), projectId);

        yield* store.advance(projectId, threadId, "done");
        const done = yield* store.getIssue({ projectId, id: todo.id });
        assert.isNotNull(done.doneAt);
        assert.strictEqual(done.log.at(-1)?.by, "system");

        // Backward automation is ignored; the user can still drag it back.
        yield* store.advance(projectId, threadId, "in_review");
        assert.strictEqual((yield* store.getIssue({ projectId, id: todo.id })).status, "done");
        yield* store.write(projectId, "user", {
          action: "issue.move",
          id: todo.id,
          status: "in_review",
          reopenReason: "scope_change",
        });
        const reopened = yield* store.getIssue({ projectId, id: todo.id });
        assert.strictEqual(reopened.status, "in_review");
        assert.isNull(reopened.doneAt);
      }),
    );

    it.effect("blocks with a reason, logs notes, and deletes only archived issues", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Flaky",
        });
        yield* store.write(projectId, "thread:t", {
          action: "issue.block",
          id,
          reason: "Need a decision",
        });
        yield* store.write(projectId, "thread:t", {
          action: "issue.note",
          id,
          text: "Repro attached",
        });
        const blocked = yield* store.getIssue({ projectId, id });
        assert.strictEqual(blocked.blocked?.reason, "Need a decision");
        assert.deepStrictEqual(
          blocked.log.map((entry) => entry.kind),
          ["status", "blocked", "note"],
        );
        yield* store.write(projectId, "user", { action: "issue.unblock", id });
        assert.isNull((yield* store.getIssue({ projectId, id })).blocked);
        assert.strictEqual(
          yield* failureCode(store.write(projectId, "user", { action: "issue.delete", id })),
          "invalid",
        );
        yield* store.write(projectId, "user", { action: "issue.archive", id });
        yield* store.write(projectId, "user", { action: "issue.delete", id });
        assert.strictEqual(yield* failureCode(store.getIssue({ projectId, id })), "not_found");
      }),
    );
  });

  describe("definition of done", () => {
    it.effect("holds Done behind the criteria and needs a reason to come back", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Ship criteria",
          tier: "strong",
        });
        yield* store.write(projectId, "user", {
          action: "issue.noDecision",
          id,
          reason: "Only criteria matter here.",
        });
        yield* store.write(projectId, "user", { action: "criterion.add", id, text: "Tests pass" });
        yield* store.write(projectId, "thread:t", {
          action: "criterion.add",
          id,
          text: "Docs updated",
        });
        let issue = yield* store.getIssue({ projectId, id });
        assert.deepStrictEqual(
          issue.criteria.map((c) => c.id),
          ["c1", "c2"],
        );
        assert.strictEqual(issue.tier, "strong");
        assert.strictEqual(
          yield* failureCode(
            store.write(projectId, "user", { action: "issue.move", id, status: "done" }),
          ),
          "invalid",
        );
        yield* store.write(projectId, "thread:t", {
          action: "criterion.update",
          id,
          criterionId: "c1",
          checked: true,
        });
        yield* store.write(projectId, "user", {
          action: "criterion.remove",
          id,
          criterionId: "c2",
        });
        yield* store.write(projectId, "user", { action: "issue.move", id, status: "done" });
        const card = (yield* store.board(projectId)).issues.find((i) => i.id === id);
        assert.deepStrictEqual(
          [card?.status, card?.criteriaOpen, card?.criteriaTotal],
          ["done", 0, 1],
        );
        assert.strictEqual(
          yield* failureCode(
            store.write(projectId, "user", { action: "issue.move", id, status: "todo" }),
          ),
          "invalid",
        );
        yield* store.write(projectId, "user", {
          action: "issue.move",
          id,
          status: "todo",
          reopenReason: "defect",
        });
        issue = yield* store.getIssue({ projectId, id });
        assert.strictEqual(issue.reopened?.reason, "defect");
        assert.isNull(issue.doneAt);
        assert.deepStrictEqual(
          issue.log.map((e) => e.kind),
          [
            "status",
            "note",
            "criterion",
            "criterion",
            "criterion",
            "criterion",
            "status",
            "status",
            "reopened",
          ],
        );

        // Automation respects the definition too: a settled thread cannot close an open checklist.
        const threadId = ThreadId.make("thr_criteria");
        yield* store.write(projectId, "user", { action: "criterion.add", id, text: "Reviewed" });
        yield* store.write(projectId, "user", { action: "issue.link", id, threadId });
        yield* store.advance(projectId, threadId, "done");
        assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "todo");
      }),
    );

    it.effect("refuses Done without a linked decision or a reason none was needed", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const toDone = (id: string) =>
          store.write(projectId, "user", { action: "issue.move", id, status: "done" });
        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Bump the timeout",
        });
        const refused = yield* Effect.flip(toDone(id));
        assert.strictEqual(refused.code, "invalid");
        assert.include(refused.message, "linked decision");
        assert.include(refused.message, "issue.noDecision");

        // A reason stands in for a decision; it can be changed, and cleared again.
        yield* store.write(projectId, "user", {
          action: "issue.noDecision",
          id,
          reason: "A config value.",
        });
        yield* store.write(projectId, "thread:t", {
          action: "issue.noDecision",
          id,
          reason: "Only a config value.",
        });
        let issue = yield* store.getIssue({ projectId, id });
        assert.deepStrictEqual(
          [issue.noDecision?.reason, issue.noDecision?.by],
          ["Only a config value.", "thread:t"],
        );
        yield* store.write(projectId, "user", { action: "issue.noDecision", id, reason: " " });
        issue = yield* store.getIssue({ projectId, id });
        assert.isNull(issue.noDecision);
        assert.deepStrictEqual(
          issue.log
            .filter((entry) => entry.kind === "note" && /no.decision/.test(entry.text))
            .map((entry) => entry.text),
          [
            "no decision needed: A config value.",
            "no decision needed: Only a config value.",
            "cleared the no-decision reason",
          ],
        );
        assert.strictEqual(yield* failureCode(toDone(id)), "invalid");
        yield* store.write(projectId, "user", {
          action: "issue.noDecision",
          id,
          reason: "A config value.",
        });
        yield* toDone(id);
        assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "done");

        // A decision listing the issue does too, in any state.
        const linked = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Pick a queue",
        });
        assert.strictEqual(yield* failureCode(toDone(linked.id)), "invalid");
        const decision = yield* store.write(projectId, "thread:t", {
          action: "decision.create",
          category: "queues",
          state: "proposed",
          title: "Use SQS",
          why: "Managed, and the team knows it.",
          issues: [linked.id],
        });
        yield* toDone(linked.id);
        assert.strictEqual((yield* store.getIssue({ projectId, id: linked.id })).status, "done");
        // The decisions tests count this board's categories.
        yield* store.write(projectId, "user", {
          action: "decision.delete",
          category: "queues",
          id: decision.id,
        });
      }),
    );

    it.effect("refuses Done while a finding on the issue is open", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Harden login",
        });
        yield* store.write(projectId, "user", {
          action: "issue.noDecision",
          id,
          reason: "A fix, not a choice.",
        });
        const withFinding = (disposition: KanbanFindingDisposition) =>
          store.transact(projectId, (issues, at) =>
            Effect.succeed({
              result: undefined,
              save: [{ ...issues.get(id)!, findings: [finding(disposition, at)] }],
            }),
          );
        const toDone = store.write(projectId, "user", { action: "issue.move", id, status: "done" });

        yield* withFinding("open");
        const refused = yield* Effect.flip(toDone);
        assert.include(refused.message, "finding cookie-path is still open");
        assert.notInclude(refused.message, "linked decision");
        yield* withFinding("ticketed");
        yield* toDone;
        assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "done");
      }),
    );

    it.effect("holds a card failing the check back from Done when its thread settles", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const threadId = ThreadId.make("thr_held");
        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Held card",
        });
        yield* store.write(projectId, "user", { action: "issue.link", id, threadId });
        assert.deepStrictEqual(yield* store.advance(projectId, threadId, "in_review"), []);

        const held = yield* store.advance(projectId, threadId, "done");
        assert.deepStrictEqual(
          held.map((card) => [card.id, card.title]),
          [[id, "Held card"]],
        );
        assert.include(held[0]?.missing.join(), "linked decision");
        assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "in_review");

        yield* store.write(projectId, "user", {
          action: "issue.noDecision",
          id,
          reason: "Plain bug fix.",
        });
        assert.deepStrictEqual(yield* store.advance(projectId, threadId, "done"), []);
        assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "done");
      }),
    );

    it.effect("checks a settling card against what a write holding the lock saves", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const threadId = ThreadId.make("thr_race");
        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Race the gate",
        });
        yield* store.write(projectId, "user", {
          action: "issue.noDecision",
          id,
          reason: "Plain fix.",
        });
        yield* store.write(projectId, "user", { action: "issue.link", id, threadId });

        // A finding lands while the thread settles: the card passes until the write saves it.
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const capturing = yield* Effect.forkChild(
          store.transact(projectId, (issues, at) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return {
                result: undefined,
                save: [{ ...issues.get(id)!, findings: [finding("open", at)] }],
              };
            }),
          ),
        );
        yield* Deferred.await(entered);
        // Runs until it waits for the lock the write holds.
        const settling = yield* Effect.forkChild(store.advance(projectId, threadId, "done"), {
          startImmediately: true,
        });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(capturing);

        const held = yield* Fiber.join(settling);
        assert.deepStrictEqual(
          held.map((card) => card.id),
          [id],
        );
        const issue = yield* store.getIssue({ projectId, id });
        assert.deepStrictEqual(
          [issue.status, issue.findings.map((f) => f.disposition)],
          ["todo", ["open"]],
        );
      }),
    );

    it.effect("lets an issue filed before the check move to Done, by hand or on its own", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-older-" });
        yield* fs.makeDirectory(path.join(folder, "issues"), { recursive: true });
        const threadId = ThreadId.make("thr_older");
        const at = "2026-10-01T00:00:00.000Z";
        // As the server wrote them before the check: no `closureCheck`, and here an open finding.
        for (const id of ["dragged", "settled"])
          yield* fs.writeFileString(
            path.join(folder, "issues", `${id}${ISSUE_EXTENSION}`),
            serializeIssue(
              {
                id,
                title: id,
                status: "in_review",
                priority: "p3",
                labels: [],
                verification: "unverified",
                tier: null,
                criteria: [],
                findings: [finding("open", at)],
                closureCheck: false,
                noDecision: null,
                blocked: null,
                reopened: null,
                threads: [{ id: threadId, linkedAt: at }],
                createdAt: at,
                createdBy: "user",
                updatedAt: at,
                doneAt: null,
                archivedAt: null,
                description: "",
                log: [],
              },
              "grand-theft-repo",
            ),
          );
        assert.notInclude(
          yield* fs.readFileString(path.join(folder, "issues", `dragged${ISSUE_EXTENSION}`)),
          "closureCheck",
        );
        yield* store.setDirectory({ projectId, directory: folder });

        yield* store.write(projectId, "user", {
          action: "issue.move",
          id: "dragged",
          status: "done",
        });
        assert.strictEqual((yield* store.getIssue({ projectId, id: "dragged" })).status, "done");
        assert.deepStrictEqual(yield* store.advance(projectId, threadId, "done"), []);
        assert.strictEqual((yield* store.getIssue({ projectId, id: "settled" })).status, "done");
        yield* store.setDirectory({ projectId, directory: null });
      }),
    );

    it.effect("reads a blank no-decision reason in a hand-edited file as none", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-blank-" });
        yield* fs.makeDirectory(path.join(folder, "issues"), { recursive: true });
        const at = "2026-10-01T00:00:00.000Z";
        yield* fs.writeFileString(
          path.join(folder, "issues", `blank${ISSUE_EXTENSION}`),
          serializeIssue(
            {
              id: "blank",
              title: "Blank",
              status: "in_review",
              priority: "p3",
              labels: [],
              verification: "unverified",
              tier: null,
              criteria: [],
              findings: [],
              closureCheck: true,
              noDecision: { reason: "  ", at, by: "user" },
              blocked: null,
              reopened: null,
              threads: [],
              createdAt: at,
              createdBy: "user",
              updatedAt: at,
              doneAt: null,
              archivedAt: null,
              description: "",
              log: [],
            },
            "grand-theft-repo",
          ),
        );
        yield* store.setDirectory({ projectId, directory: folder });

        assert.isNull((yield* store.getIssue({ projectId, id: "blank" })).noDecision);
        const refused = yield* Effect.flip(
          store.write(projectId, "user", { action: "issue.move", id: "blank", status: "done" }),
        );
        assert.strictEqual(refused.code, "invalid");
        assert.include(refused.message, "linked decision");
        yield* store.setDirectory({ projectId, directory: null });
      }),
    );

    it.effect(
      "a reopen is one correction on the thread linked last, classified by its reason, while learning runs",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* KanbanStore.KanbanStore;
            const learning = yield* learningPlugin;
            const first = ThreadId.make("thr_reopen_first");
            const last = ThreadId.make("thr_reopen_last");
            const elsewhere = ThreadId.make("thr_reopen_elsewhere");
            // `last` is not projected into the learning plugin yet: a reopen still records it,
            // because the core places it in the ticket's project.
            yield* learning.remember(first);
            const owners = new Map([
              [first, projectId],
              [last, projectId],
              [elsewhere, ProjectId.make("project-2")],
            ]);
            const core = Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (id) => {
                const owner = owners.get(id);
                return Effect.succeed(
                  owner === undefined ? null : { ...liveThreadShell(id), projectId: owner },
                );
              },
            });
            const reopen = (
              title: string,
              reopenReason: "defect" | "scope_change",
              threads: ReadonlyArray<ThreadId>,
            ) =>
              Effect.gen(function* () {
                const { id } = yield* store.write(projectId, "user", {
                  action: "issue.create",
                  title,
                });
                for (const threadId of threads)
                  yield* store.write(projectId, "user", { action: "issue.link", id, threadId });
                yield* store.write(projectId, "user", {
                  action: "issue.noDecision",
                  id,
                  reason: "A bug fix.",
                });
                yield* store.write(projectId, "user", { action: "issue.move", id, status: "done" });
                yield* store.write(projectId, "user", {
                  action: "issue.move",
                  id,
                  status: "todo",
                  reopenReason,
                });
                return id;
              });

            // Without the learning plugin a reopen records nothing and still succeeds.
            yield* reopen("Reopened while learning is off", "defect", [last]);
            const [defect, scopeChange] = yield* Effect.gen(function* () {
              const ids = yield* Effect.all([
                reopen("Login loops", "defect", [first, last]),
                reopen("Login needs SSO too", "scope_change", [last]),
                // No linked thread, so no agent's work to learn from.
                reopen("Typo on the board", "defect", []),
                // A ticket links any thread id; one the core places elsewhere, or does not know,
                // is not claimed for this project.
                reopen("Linked to another project's thread", "defect", [elsewhere]),
                reopen("Linked to a thread that never existed", "defect", [
                  ThreadId.make("thr_reopen_missing"),
                ]),
              ]);
              // Settling and reopening again within the same clock tick is a second correction.
              yield* store.write(projectId, "user", {
                action: "issue.move",
                id: ids[0],
                status: "done",
              });
              yield* store.write(projectId, "user", {
                action: "issue.move",
                id: ids[0],
                status: "todo",
                reopenReason: "defect",
              });
              return ids;
            }).pipe(
              Effect.provideService(CorrectionStore.CorrectionStore, learning.corrections),
              Effect.provide(core),
            );

            const at = DateTime.formatIso(yield* DateTime.now);
            const recorded = yield* learning.corrections.list({ projectId, from: at, to: at });
            assert.deepEqual(
              recorded.map((c) => [c.threadId, c.failureKind, c.declaredMode, c.sourceKey]),
              [
                [
                  last,
                  "reopened_after_settlement",
                  "defect",
                  `issue:${projectId}:${defect}:1:${at}`,
                ],
                [
                  last,
                  "reopened_after_settlement",
                  "unclear_spec",
                  `issue:${projectId}:${scopeChange}:1:${at}`,
                ],
                [
                  last,
                  "reopened_after_settlement",
                  "defect",
                  `issue:${projectId}:${defect}:2:${at}`,
                ],
              ],
            );

            assert.deepInclude(yield* learning.classify, { examined: 3, acted: 3 });
            const classified = yield* Effect.forEach(recorded, (c) =>
              learning.corrections.get(c.id),
            );
            assert.deepEqual(
              classified.map((c) => [c.causeClass, c.classificationReason]),
              [
                ["defect", "declared mode"],
                ["unclear_spec", "declared mode"],
                ["defect", "declared mode"],
              ],
            );
          }),
        ),
    );
  });

  describe("decisions", () => {
    it.effect("groups decisions by category file and filters by issue", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { id } = yield* store.write(projectId, "user", {
          action: "decision.create",
          category: "auth",
          title: "Keep session TTL at 30m",
          why: "Extending it hides the bug.",
          issues: ["fix-login-redirect"],
        });
        yield* store.write(projectId, "thread:t", {
          action: "decision.create",
          state: "rejected",
          title: "Retries on login",
          why: "They hide the real failure.",
        });
        const board = yield* store.board(projectId);
        assert.deepStrictEqual(
          [...board.decisionCategories].sort((a, b) => a.category.localeCompare(b.category)),
          [
            { category: "auth", count: 1 },
            { category: "general", count: 1 },
          ],
        );
        assert.isTrue(yield* fs.exists(path.join(board.directory, "decisions", "auth.yaml")));
        const about = yield* store.listDecisions({ projectId, issue: "fix-login-redirect" });
        assert.deepStrictEqual(
          about.map((d) => d.id),
          [id],
        );
        yield* store.write(projectId, "user", {
          action: "decision.update",
          category: "auth",
          id,
          why: "Security review says so.",
        });
        assert.strictEqual(
          (yield* store.listDecisions({ projectId, category: "auth" }))[0]?.why,
          "Security review says so.",
        );
        yield* store.write(projectId, "user", { action: "decision.delete", category: "auth", id });
        assert.isFalse(yield* fs.exists(path.join(board.directory, "decisions", "auth.yaml")));
      }),
    );
  });

  describe("folder", () => {
    it.effect("a folder change and a capture toggle made at once both land", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const fs = yield* FileSystem.FileSystem;
        const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-capture-" });
        yield* Effect.all(
          [
            store.setDirectory({ projectId, directory: other }),
            store.setCapture({ projectId, enabled: true }),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(yield* store.directory(projectId), other);
        assert.isTrue(yield* store.captures(projectId));
        yield* store.setCapture({ projectId, enabled: false });
        yield* store.setDirectory({ projectId, directory: null });
      }),
    );

    it.effect("capture toggles made at once leave the board's setting as kanban.json has it", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const fs = yield* FileSystem.FileSystem;
        const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-capture-" });
        yield* store.setDirectory({ projectId, directory: other });
        // Loaded, so each toggle also updates the board in memory.
        yield* store.board(projectId);
        yield* Effect.all(
          [true, false, true, false, true, false].map((enabled) =>
            store.setCapture({ projectId, enabled }),
          ),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(
          (yield* store.board(projectId)).capture,
          yield* store.captures(projectId),
        );
        yield* store.setCapture({ projectId, enabled: false });
        yield* store.setDirectory({ projectId, directory: null });
      }),
    );

    it.effect(
      "keeps capture beside the folder in kanban.json, each surviving a change to the other",
      () =>
        Effect.gen(function* () {
          const store = yield* KanbanStore.KanbanStore;
          const fs = yield* FileSystem.FileSystem;
          const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-capture-" });
          yield* store.setCapture({ projectId, enabled: true });
          yield* store.setDirectory({ projectId, directory: other });
          assert.isTrue((yield* store.board(projectId)).capture);
          yield* store.setCapture({ projectId, enabled: false });
          assert.strictEqual((yield* store.board(projectId)).directory, other);
          assert.isFalse((yield* store.board(projectId)).capture);
          assert.isFalse(yield* store.captures(projectId));
          yield* store.setDirectory({ projectId, directory: null });
        }),
    );

    it.effect("archives Done issues older than seven days when a folder loads", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-folder-" });
        yield* fs.makeDirectory(path.join(other, "issues"), { recursive: true });
        // The test clock sits at the epoch, so "old" means before 1970.
        const at = "1960-01-01T00:00:00.000Z";
        yield* fs.writeFileString(
          path.join(other, "issues", "old.md"),
          serializeIssue(
            {
              id: "old",
              title: "Old",
              status: "done",
              priority: "p3",
              labels: [],
              verification: "unverified",
              tier: null,
              criteria: [],
              findings: [],
              closureCheck: false,
              noDecision: null,
              blocked: null,
              reopened: null,
              threads: [],
              createdAt: at,
              createdBy: "user",
              updatedAt: at,
              doneAt: at,
              archivedAt: null,
              description: "",
              log: [],
            },
            "grand-theft-repo",
          ),
        );
        yield* store.setDirectory({ projectId, directory: other });
        const board = yield* store.board(projectId);
        assert.strictEqual(board.directory, other);
        assert.isNotNull(board.issues.find((issue) => issue.id === "old")?.archivedAt);
        const { stateDir } = yield* ServerConfig.ServerConfig;
        assert.include(yield* fs.readFileString(path.join(stateDir, "kanban.json")), other);
        yield* store.setDirectory({ projectId, directory: null });
      }),
    );

    it.effect("publishes a new board when a file changes on disk", () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const board = yield* store.board(projectId);
        const written = yield* Ref.make(false);
        const boards = yield* Stream.runCollect(
          store.subscribeBoard(projectId).pipe(
            // Write once the subscription has delivered its first snapshot, so the watcher is up.
            Stream.tap((snapshot) =>
              Effect.flatMap(Ref.getAndSet(written, true), (done) =>
                done
                  ? Effect.void
                  : fs.writeFileString(
                      path.join(snapshot.directory, "issues", "from-editor.md"),
                      "---\ntitle: From an editor\nstatus: inbox\ncreatedAt: 2026-10-12T00:00:00.000Z\n---\n",
                    ),
              ),
            ),
            Stream.takeUntil((snapshot) =>
              snapshot.issues.some((issue) => issue.id === "from-editor"),
            ),
          ),
        );
        assert.isAtLeast(boards.length, 2);
        assert.strictEqual(boards[0]?.issues.length, board.issues.length);
        assert.strictEqual(
          (yield* store.getIssue({ projectId, id: "from-editor" })).status,
          "inbox",
        );
      }),
    );
  });
});

/** A decisions file as written before decisions had a state. */
const LEGACY_DECISIONS = `category: auth
project: grand-theft-repo
decisions:
  - id: keep-ttl
    stance: for
    title: Keep session TTL at 30m
    why: Extending it hides the bug.
    issues: [fix-login-redirect]
    by: user
    at: "2026-10-12T14:00:00.000Z"
  - id: retries-on-login
    stance: against
    title: Retries on login
    why: They hide the real failure.
    issues: []
    by: thread:thr_1
    at: "2026-10-12T15:00:00.000Z"
`;

/** Its own folder, so no other test's decisions show up in these. */
it.layer(layerTest)("KanbanStore decisions", (it) => {
  const revisions = (category: string, id: string) =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const found = (yield* store.listDecisions({ projectId, category })).find((d) => d.id === id);
      return found?.revisions.map((r) => r.change) ?? [];
    });

  it.effect("loads a for/against file without losing anything and saves it in the new shape", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-legacy-" });
      const file = path.join(folder, "decisions", "auth.yaml");
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, LEGACY_DECISIONS);
      yield* store.setDirectory({ projectId, directory: folder });

      const loaded = yield* store.listDecisions({ projectId });
      assert.deepStrictEqual(
        loaded.map((d) => [d.id, d.state, d.title, d.why, d.issues, d.by, d.at]),
        [
          [
            "keep-ttl",
            "accepted",
            "Keep session TTL at 30m",
            "Extending it hides the bug.",
            ["fix-login-redirect"],
            "user",
            "2026-10-12T14:00:00.000Z",
          ],
          [
            "retries-on-login",
            "accepted",
            "Retries on login",
            "They hide the real failure.",
            [],
            "thread:thr_1",
            "2026-10-12T15:00:00.000Z",
          ],
        ],
      );
      // The stance survives as the one alternative: chosen for `for`, rejected for `against`.
      assert.deepStrictEqual(
        loaded.map((d) => d.alternatives),
        [
          [
            {
              title: "Keep session TTL at 30m",
              disposition: "chosen",
              reason: "Extending it hides the bug.",
              reasonKind: "contextual",
            },
          ],
          [
            {
              title: "Retries on login",
              disposition: "rejected",
              reason: "They hide the real failure.",
              reasonKind: "contextual",
            },
          ],
        ],
      );

      yield* store.write(projectId, "user", {
        action: "decision.setState",
        category: "auth",
        id: "retries-on-login",
        state: "rejected",
      });
      const saved = yield* fs.readFileString(file);
      assert.notInclude(saved, "stance");
      // The whole file is rewritten in the new shape, and reads back as it loaded plus the write.
      const [keep, retries] = loaded;
      assert.deepStrictEqual(parseDecisions("auth", saved), [
        keep!,
        {
          ...retries!,
          state: "rejected",
          revisions: [
            { at: "1970-01-01T00:00:00.000Z", by: "user", change: "state: accepted → rejected" },
          ],
        },
      ]);
      yield* store.setDirectory({ projectId, directory: null });
    }),
  );

  it.effect("keeps a chosen and a rejected alternative through the store and its file", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const alternatives = [
        {
          title: "SQLite",
          disposition: "chosen" as const,
          reason: "Already bundled.",
          reasonKind: "contextual" as const,
        },
        {
          title: "Postgres",
          disposition: "rejected" as const,
          reason: "Needs a server on every machine.",
          reasonKind: "permanent" as const,
        },
      ];
      const { id } = yield* store.write(projectId, "thread:thr_db", {
        action: "decision.create",
        category: "storage",
        title: "Store state in SQLite",
        why: "One file per environment.",
        alternatives,
        reconsiderWhen: "Several machines share one environment.",
      });
      const [stored] = yield* store.listDecisions({ projectId, category: "storage" });
      assert.deepStrictEqual(stored?.alternatives, alternatives);
      assert.strictEqual(stored?.state, "accepted");
      assert.strictEqual(stored?.reconsiderWhen, "Several machines share one environment.");
      // Made by an agent: its thread is where the decision was made.
      assert.deepStrictEqual(stored?.threads, [ThreadId.make("thr_db")]);
      assert.deepStrictEqual(stored?.revisions, [
        { at: "1970-01-01T00:00:00.000Z", by: "thread:thr_db", change: "created: accepted" },
      ]);
      const { directory } = yield* store.board(projectId);
      const text = yield* fs.readFileString(path.join(directory, "decisions", "storage.yaml"));
      assert.deepStrictEqual(parseDecisions("storage", text), [stored!]);
      assert.strictEqual(id, "store-state-in-sqlite");
    }),
  );

  it.effect("supersedes, links both sides, and unlinks them when the old one changes state", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const create = (title: string) =>
        store.write(projectId, "user", {
          action: "decision.create",
          category: "cache",
          title,
          why: "Measured.",
        });
      const a = (yield* create("Cache in memory")).id;
      const b = (yield* create("Cache in Redis")).id;
      const decisions = () =>
        Effect.map(
          store.listDecisions({ projectId, category: "cache" }),
          (list) => new Map(list.map((d) => [d.id, d])),
        );

      yield* store.write(projectId, "user", {
        action: "decision.supersede",
        category: "cache",
        id: a,
        by: `cache/${b}`,
      });
      let now = yield* decisions();
      assert.strictEqual(now.get(a)?.state, "superseded");
      assert.strictEqual(now.get(a)?.supersededBy, `cache/${b}`);
      assert.deepStrictEqual(now.get(b)?.supersedes, [`cache/${a}`]);
      assert.strictEqual(now.get(b)?.state, "accepted");

      // Superseding again with the same replacement changes nothing (the revisions below show it);
      // neither side can be superseded into a cycle or by another, nor deleted while linked.
      const supersede = (id: string, by: string) =>
        failureCode(
          store.write(projectId, "user", {
            action: "decision.supersede",
            category: "cache",
            id,
            by,
          }),
        );
      assert.strictEqual(yield* supersede(a, `cache/${b}`), "ok");
      const c = (yield* create("Cache on disk")).id;
      assert.strictEqual(yield* supersede(a, `cache/${c}`), "invalid");
      assert.strictEqual(yield* supersede(b, `cache/${a}`), "invalid");
      assert.strictEqual(yield* supersede(b, `cache/${b}`), "invalid");
      assert.strictEqual(yield* supersede(b, "cache/missing"), "not_found");
      assert.strictEqual(
        yield* failureCode(
          store.write(projectId, "user", { action: "decision.delete", category: "cache", id: b }),
        ),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(
          store.write(projectId, "user", {
            action: "decision.setState",
            category: "cache",
            id: b,
            state: "superseded",
          }),
        ),
        "invalid",
      );

      // The way back: leaving superseded clears the link on both sides.
      yield* store.write(projectId, "user", {
        action: "decision.setState",
        category: "cache",
        id: a,
        state: "rejected",
      });
      now = yield* decisions();
      assert.strictEqual(now.get(a)?.state, "rejected");
      assert.isNull(now.get(a)?.supersededBy ?? null);
      assert.deepStrictEqual(now.get(b)?.supersedes, []);
      // And a rejected decision can be proposed again.
      yield* store.write(projectId, "user", {
        action: "decision.setState",
        category: "cache",
        id: a,
        state: "proposed",
      });
      assert.deepStrictEqual(yield* revisions("cache", a), [
        "created: accepted",
        `state: accepted → superseded by cache/${b}`,
        `state: superseded → rejected; no longer superseded by cache/${b}`,
        "state: rejected → proposed",
      ]);
      assert.deepStrictEqual(yield* revisions("cache", b), [
        "created: accepted",
        `supersedes cache/${a}`,
        `no longer supersedes cache/${a}`,
      ]);
    }),
  );

  it.effect("adds one revision per write and never drops one", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const { id } = yield* store.write(projectId, "user", {
        action: "decision.create",
        category: "ui",
        title: "Virtualize the thread list",
        why: "Long lists drop frames.",
      });
      const writes = [
        { action: "decision.update", why: "Long lists drop frames on 120Hz.", issues: ["perf"] },
        { action: "decision.setState", state: "conflicted" },
        { action: "decision.update", reconsiderWhen: "Lists stay under 100 rows." },
        { action: "decision.setState", state: "accepted" },
      ] as const;
      let before = yield* revisions("ui", id);
      for (const write of writes) {
        yield* store.write(projectId, "user", { ...write, category: "ui", id });
        const after = yield* revisions("ui", id);
        assert.strictEqual(after.length, before.length + 1);
        assert.deepStrictEqual(after.slice(0, before.length), before);
        before = after;
      }
      assert.strictEqual(before[1], "edited: why, issues");
      // A write that changes nothing writes nothing, so it adds no revision.
      yield* store.write(projectId, "user", { action: "decision.update", category: "ui", id });
      yield* store.write(projectId, "user", {
        action: "decision.setState",
        category: "ui",
        id,
        state: "accepted",
      });
      assert.deepStrictEqual(yield* revisions("ui", id), before);
      // State changes go through setState, not update.
      assert.strictEqual(
        yield* failureCode(
          store.write(projectId, "user", {
            action: "decision.update",
            category: "ui",
            id,
            state: "rejected",
          }),
        ),
        "invalid",
      );
    }),
  );

  it.effect("refuses an agent's decision without a why, and an agent's delete", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const agent = "thread:thr_agent";
      const refused = yield* store
        .write(projectId, agent, { action: "decision.create", category: "api", title: "No why" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");
      assert.match(refused.message, /^why is required/);
      const { id } = yield* store.write(projectId, agent, {
        action: "decision.create",
        category: "api",
        title: "Paginate by cursor",
        why: "Offsets skip rows under writes.",
      });
      assert.strictEqual(
        yield* failureCode(
          store.write(projectId, agent, { action: "decision.delete", category: "api", id }),
        ),
        "gated",
      );
      yield* store.write(projectId, "user", { action: "decision.delete", category: "api", id });
      assert.deepStrictEqual(yield* store.listDecisions({ projectId, category: "api" }), []);
    }),
  );

  it.effect("reads a link one file lost as the superseded side holds it", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-links-" });
      yield* fs.makeDirectory(path.join(folder, "decisions"), { recursive: true });
      const decision = (category: string, id: string): KanbanDecision => ({
        category,
        id,
        state: "accepted",
        title: id,
        why: "",
        alternatives: [],
        reconsiderWhen: null,
        supersedes: [],
        supersededBy: null,
        issues: [],
        threads: [],
        by: "user",
        at: "2026-10-12T00:00:00.000Z",
        revisions: [],
      });
      const write = (category: string, decisions: ReadonlyArray<KanbanDecision>) =>
        fs.writeFileString(
          path.join(folder, "decisions", `${category}.yaml`),
          serializeDecisions(category, "grand-theft-repo", decisions),
        );
      // `old` says `b/new` replaced it, but `new` never recorded it; `new` claims `a/gone`, which
      // does not exist; `orphan` names a replacement that does not exist.
      yield* write("a", [
        { ...decision("a", "old"), state: "superseded", supersededBy: "b/new" },
        { ...decision("a", "orphan"), state: "superseded", supersededBy: "b/missing" },
      ]);
      yield* write("b", [{ ...decision("b", "new"), supersedes: ["a/gone"] }]);
      yield* store.setDirectory({ projectId, directory: folder });

      const links = new Map(
        (yield* store.listDecisions({ projectId })).map((d) => [
          `${d.category}/${d.id}`,
          [d.state, d.supersededBy, d.supersedes],
        ]),
      );
      assert.deepStrictEqual(Object.fromEntries(links), {
        "a/old": ["superseded", "b/new", []],
        "a/orphan": ["superseded", "b/missing", []],
        "b/new": ["accepted", null, ["a/old"]],
      });
      yield* store.setDirectory({ projectId, directory: null });
    }),
  );

  it.effect("searches a decision's words, most matches first, within a state", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const create = (title: string, why: string, state?: "rejected") =>
        store.write(projectId, "user", {
          action: "decision.create",
          category: "queue",
          title,
          why,
          ...(state === undefined ? {} : { state }),
          alternatives: [
            {
              title: "Kafka",
              disposition: "rejected",
              reason: "Too heavy for one machine.",
              reasonKind: "contextual",
            },
          ],
        });
      yield* create("Retry failed jobs", "Backoff with jitter.");
      yield* create("Queue jobs in SQLite", "No extra service; retry from the table.");
      yield* create("Drop the job runner", "Nobody uses it.", "rejected");
      const search = (query: string, state?: "rejected") =>
        Effect.map(
          store.listDecisions({
            projectId,
            category: "queue",
            query,
            ...(state === undefined ? {} : { state }),
          }),
          (found) => found.map((d) => d.id),
        );
      assert.deepStrictEqual(yield* search("sqlite RETRY"), [
        "queue-jobs-in-sqlite",
        "retry-failed-jobs",
      ]);
      // Alternatives are searched too.
      assert.strictEqual((yield* search("kafka")).length, 3);
      assert.deepStrictEqual(yield* search("job", "rejected"), ["drop-the-job-runner"]);
      assert.deepStrictEqual(yield* search("postgres"), []);
    }),
  );

  it.effect("lists the decisions linked to a thread, the one an agent decided in included", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const here = ThreadId.make("thr_here");
      const elsewhere = ThreadId.make("thr_elsewhere");
      const { id: made } = yield* store.write(projectId, `thread:${here}`, {
        action: "decision.create",
        category: "linked",
        title: "Made in the thread",
        why: "The agent decided it there.",
      });
      const { id: applied } = yield* store.write(projectId, "user", {
        action: "decision.create",
        category: "linked",
        title: "Applied in the thread",
        threads: [elsewhere, here],
      });
      yield* store.write(projectId, "user", {
        action: "decision.create",
        category: "linked",
        title: "Elsewhere only",
        threads: [elsewhere],
      });
      const linked = (thread: ThreadId) =>
        Effect.map(store.listDecisions({ projectId, category: "linked", thread }), (found) =>
          found.map((d) => d.id).sort(),
        );
      assert.deepStrictEqual(yield* linked(here), [applied, made].sort());

      // Unlinking the thread takes the decision off its count.
      yield* store.write(projectId, "user", {
        action: "decision.update",
        category: "linked",
        id: applied,
        threads: [elsewhere],
      });
      assert.deepStrictEqual(yield* linked(here), [made]);
      assert.strictEqual((yield* linked(elsewhere)).length, 2);
    }),
  );
});

it.layer(layerTest)("KanbanStore without a board", (it) => {
  it.effect("answers no decisions and creates no folder until the board is used", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const fs = yield* FileSystem.FileSystem;
      const thread = ThreadId.make("thr_first");
      const directory = yield* store.directory(projectId);

      assert.deepStrictEqual(yield* store.listDecisions({ projectId, thread }), []);
      assert.isFalse(yield* fs.exists(directory));
      // A folder that exists without the board's `issues/` marker is no board yet either.
      yield* fs.makeDirectory(directory, { recursive: true });
      assert.deepStrictEqual(yield* store.listDecisions({ projectId, thread }), []);
      assert.deepStrictEqual(yield* fs.readDirectory(directory), []);

      yield* store.write(projectId, `thread:${thread}`, {
        action: "decision.create",
        title: "First call",
        why: "Someone had to.",
      });
      assert.deepStrictEqual(
        (yield* store.listDecisions({ projectId, thread })).map((d) => d.id),
        ["first-call"],
      );
    }),
  );
});

/** The store over the real file system, except that writing a file named in `failing` fails. */
const layerFailingWrites = (failing: Set<string>) =>
  KanbanStore.layer.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) => ({
          ...real,
          // Every store write lands by renaming a temp file onto its target.
          rename: (from, to) =>
            [...failing].some((name) => to.endsWith(`/${name}`))
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "rename",
                    description: "ENOSPC: no space left on device",
                  }),
                )
              : real.rename(from, to),
        })),
      ),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      }),
    ),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("decision writes across two files", () => {
  it.effect("write the superseded side first and record the replacement only once it holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing = new Set<string>();
        const services = yield* Layer.build(layerFailingWrites(failing));
        const store = Context.get(services, KanbanStore.KanbanStore);
        const fs = Context.get(services, FileSystem.FileSystem);
        const path = Context.get(services, Path.Path);
        const create = (category: string, title: string) =>
          store.write(projectId, "user", { action: "decision.create", category, title, why: "." });
        const a = (yield* create("old", "Cache in memory")).id;
        const b = (yield* create("new", "Cache in Redis")).id;
        const supersede = store.write(projectId, "user", {
          action: "decision.supersede",
          category: "old",
          id: a,
          by: `new/${b}`,
        });
        const unlink = store.write(projectId, "user", {
          action: "decision.setState",
          category: "old",
          id: a,
          state: "accepted",
        });
        // Keyed by decision: a reload reads the files in the directory's order.
        const links = Effect.map(store.listDecisions({ projectId }), (list) =>
          Object.fromEntries(
            list.map((d) => [
              `${d.category}/${d.id}`,
              [d.state, d.supersededBy, d.supersedes, d.revisions.map((r) => r.change)],
            ]),
          ),
        );
        const { directory } = yield* store.board(projectId);
        const onDisk = (category: string) =>
          Effect.map(
            fs.readFileString(path.join(directory, "decisions", `${category}.yaml`)),
            (text) => parseDecisions(category, text)?.map((d) => d.revisions.map((r) => r.change)),
          );
        const created = ["created: accepted"];
        const superseded = [...created, `state: accepted → superseded by new/${b}`];

        // The superseded side is written first: when it fails, nothing changed anywhere.
        failing.add("old.yaml");
        assert.strictEqual(yield* failureCode(supersede), "io");
        assert.deepStrictEqual(yield* links, {
          [`old/${a}`]: ["accepted", null, [], created],
          [`new/${b}`]: ["accepted", null, [], created],
        });
        assert.deepStrictEqual(yield* onDisk("new"), [created]);

        // When only the replacement's file fails, the link holds from the superseded side and the
        // replacement has no revision for it yet: missing, never false.
        failing.clear();
        failing.add("new.yaml");
        assert.strictEqual(yield* failureCode(supersede), "io");
        const held = {
          [`old/${a}`]: ["superseded", `new/${b}`, [], superseded],
          [`new/${b}`]: ["accepted", null, [`old/${a}`], created],
        };
        assert.deepStrictEqual(yield* links, held);
        assert.deepStrictEqual(yield* onDisk("new"), [created]);
        // So it reads after a reload from disk too.
        yield* store.setDirectory({ projectId, directory: null });
        assert.deepStrictEqual(yield* links, held);

        // A retry records the replacement's revision once; another retry changes nothing.
        failing.clear();
        yield* supersede;
        yield* supersede;
        const linked = {
          [`old/${a}`]: ["superseded", `new/${b}`, [], superseded],
          [`new/${b}`]: ["accepted", null, [`old/${a}`], [...created, `supersedes old/${a}`]],
        };
        assert.deepStrictEqual(yield* links, linked);

        // Unlinking: the superseded side failing leaves both as they were.
        failing.add("old.yaml");
        assert.strictEqual(yield* failureCode(unlink), "io");
        assert.deepStrictEqual(yield* links, linked);
        // The replacement failing leaves the link gone and no false revision.
        failing.clear();
        failing.add("new.yaml");
        assert.strictEqual(yield* failureCode(unlink), "io");
        assert.deepStrictEqual(yield* links, {
          [`old/${a}`]: [
            "accepted",
            null,
            [],
            [...superseded, `state: superseded → accepted; no longer superseded by new/${b}`],
          ],
          [`new/${b}`]: ["accepted", null, [], [...created, `supersedes old/${a}`]],
        });
      }),
    ),
  );
});

describe("watcher refresh", () => {
  it.effect("does not bring back an issue deleted after the refresh read it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const control = yield* driveWatcher;
        const store = Context.get(
          yield* Layer.build(layerDriven(control)),
          KanbanStore.KanbanStore,
        );
        // Loads the board folder, which is empty, and starts the watcher.
        yield* store.board(projectId);
        const { id } = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Login loops",
        });
        yield* store.write(projectId, "user", { action: "issue.archive", id });

        // The archive write's event: the refresh reads the archived file, then waits to index it.
        yield* Queue.offer(control.events, { _tag: "Update", path: `${id}${ISSUE_EXTENSION}` });
        yield* Deferred.await(control.held);

        // The delete starts while the refresh waits. Without the lock it runs to its end under the
        // refresh; with it, the delete waits for the refresh, which waits for the test.
        const deleting = yield* Effect.forkChild(
          store.write(projectId, "user", { action: "issue.delete", id }),
          { startImmediately: true },
        );
        if (control.removing) yield* Fiber.join(deleting);
        yield* Deferred.succeed(control.release, undefined);

        // The delete's own event has not been handled yet; the next one is taken after the refresh.
        yield* Queue.offer(control.events, { _tag: "Update", path: sentinel });
        yield* Deferred.await(control.drained);
        yield* Fiber.join(deleting);

        const again = yield* store.write(projectId, "user", {
          action: "issue.create",
          title: "Login loops",
        });
        assert.strictEqual(again.id, id);
        const board = yield* store.board(projectId);
        assert.deepStrictEqual(
          board.issues.map((issue) => issue.id),
          [id],
        );
        assert.isNull(board.issues[0]?.archivedAt);
      }),
    ),
  );
});
