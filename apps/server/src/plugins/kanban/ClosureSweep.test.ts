import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type KanbanFindingDisposition,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as Attention from "../Attention.ts";
import { flagKeyedToProject } from "../attentionKeys.ts";
import * as HostDatabase from "../HostDatabase.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as ClosureSweep from "./ClosureSweep.ts";
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

/** The sweep over a real store in a temporary T3 home and a migrated in-memory host database. */
const fixture = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({
    id: "_host",
    filename: ":memory:",
    migrations: HostDatabase.migrations,
  });
  const services = yield* Layer.build(
    Layer.mergeAll(
      KanbanStore.layer,
      Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, sql))),
    ).pipe(
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-closure-" })),
      Layer.provide(NodeServices.layer),
    ),
  );
  const run = yield* ClosureSweep.sweep.pipe(Effect.provideContext(services));
  const hold = yield* ClosureSweep.hold.pipe(Effect.provideContext(services));
  const attention = yield* Attention.Attention.pipe(Effect.provideContext(services));
  const store = yield* KanbanStore.KanbanStore.pipe(Effect.provideContext(services));
  return {
    run,
    hold,
    store,
    attention,
    open: attention.listOpen({ pluginId: "kanban", kind: "closure_held" }),
  };
});

it.effect("a card held from Done keeps one flag until it passes the closure check", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, hold, store, open } = yield* fixture;
      const threadId = ThreadId.make("thr_settled");
      const { id } = yield* store.write(projectId, "user", {
        action: "issue.create",
        title: "Ship the fix",
      });
      yield* store.write(projectId, "user", { action: "issue.link", id, threadId });
      const withFinding = (disposition: KanbanFindingDisposition) =>
        store.transact(projectId, (issues, at) =>
          Effect.succeed({
            result: undefined,
            save: [
              {
                ...issues.get(id)!,
                findings: [
                  {
                    id: "cookie-path",
                    title: "Cookie path is too broad",
                    evidence: "Path=/",
                    truthStatus: "seen" as const,
                    scopeRelation: "adjacent" as const,
                    disposition,
                    proposedBy: "thread:thr_finder",
                    proposedAt: at,
                    threadId: ThreadId.make("thr_finder"),
                    review: null,
                  },
                ],
              },
            ],
          }),
        );
      yield* withFinding("open");

      // The thread settles, then its pull request merges: the card stays, under one flag.
      for (const _ of ["settled", "merged"])
        yield* hold(projectId, yield* store.advance(projectId, threadId, "done"));
      assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "todo");
      const key = `closure:${projectId}:${id}`;
      const [flag, ...others] = yield* open;
      assert.strictEqual(flag?.threadId, key);
      assert.lengthOf(others, 0);
      assert.include(flag?.text, '"Ship the fix" (ship-the-fix) was not moved to Done');
      assert.include(flag?.text, "linked decision");
      assert.include(flag?.text, "finding cookie-path is still open");
      // The board and the weekly report attribute it to the project.
      assert.isTrue(flagKeyedToProject(key, projectId));
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 1, acted: 0, flags: 1 });

      // Half of what was missing is there: the text follows.
      yield* store.write(projectId, "user", {
        action: "issue.noDecision",
        id,
        reason: "A bug fix.",
      });
      assert.deepEqual(yield* run({ dryRun: true }), { examined: 1, acted: 0, flags: 1 });
      assert.include((yield* open)[0]?.text, "linked decision");
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 1, acted: 1, flags: 1 });
      assert.notInclude((yield* open)[0]?.text, "linked decision");

      // It passes: the flag clears, and the card waits to be moved.
      yield* withFinding("fix_now");
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 1, acted: 1, flags: 0 });
      assert.deepEqual(yield* open, []);
      assert.strictEqual((yield* store.getIssue({ projectId, id })).status, "todo");
    }),
  ),
);

it.effect("a flag whose card or project is gone clears", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, hold, open } = yield* fixture;
      const missing = { id: "gone", title: "Gone", missing: ["it needs a linked decision"] };
      yield* hold(projectId, [missing]);
      yield* hold(ProjectId.make("project-2"), [missing]);
      assert.lengthOf(yield* open, 2);
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 2, flags: 0 });
      assert.deepEqual(yield* open, []);
    }),
  ),
);
