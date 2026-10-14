import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, type KanbanError, type Project } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ClassifySweep from "../learning/ClassifySweep.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import * as ItemStore from "../learning/items/ItemStore.ts";
import { migrations } from "../learning/migrations.ts";
import { rememberThread } from "../learning/producers/threads.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { ISSUE_EXTENSION, serializeIssue } from "./KanbanFiles.ts";
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

    it.effect(
      "a reopen is one correction on the thread linked last, classified by its reason, while learning runs",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* KanbanStore.KanbanStore;
            const learning = yield* learningPlugin;
            const first = ThreadId.make("thr_reopen_first");
            const last = ThreadId.make("thr_reopen_last");
            for (const id of [first, last]) yield* learning.remember(id);
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
            const [defect, scopeChange] = yield* Effect.all([
              reopen("Login loops", "defect", [first, last]),
              reopen("Login needs SSO too", "scope_change", [last]),
              // No linked thread, so no agent's work to learn from.
              reopen("Typo on the board", "defect", []),
            ]).pipe(Effect.provideService(CorrectionStore.CorrectionStore, learning.corrections));

            const at = DateTime.formatIso(yield* DateTime.now);
            const recorded = yield* learning.corrections.list({ projectId, from: at, to: at });
            assert.deepEqual(
              recorded.map((c) => [c.threadId, c.failureKind, c.declaredMode, c.sourceKey]),
              [
                [last, "reopened_after_settlement", "defect", `issue:${projectId}:${defect}:${at}`],
                [
                  last,
                  "reopened_after_settlement",
                  "unclear_spec",
                  `issue:${projectId}:${scopeChange}:${at}`,
                ],
              ],
            );

            assert.deepInclude(yield* learning.classify, { examined: 2, acted: 2 });
            const classified = yield* Effect.forEach(recorded, (c) =>
              learning.corrections.get(c.id),
            );
            assert.deepEqual(
              classified.map((c) => [c.causeClass, c.classificationReason]),
              [
                ["defect", "declared mode"],
                ["unclear_spec", "declared mode"],
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
          stance: "for",
          title: "Keep session TTL at 30m",
          why: "Extending it hides the bug.",
          issues: ["fix-login-redirect"],
        });
        yield* store.write(projectId, "thread:t", {
          action: "decision.create",
          stance: "against",
          title: "Retries on login",
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
