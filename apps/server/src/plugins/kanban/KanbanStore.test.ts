import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, type KanbanError, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { serializeIssue } from "./KanbanFiles.ts";
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
              blocked: null,
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
