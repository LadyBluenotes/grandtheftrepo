import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as Attention from "../Attention.ts";
import { flagKeyedToProject } from "../attentionKeys.ts";
import * as HostDatabase from "../HostDatabase.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as DecisionSweep from "./DecisionSweep.ts";
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
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-sweep-" })),
      Layer.provide(NodeServices.layer),
    ),
  );
  const run = yield* DecisionSweep.sweep.pipe(Effect.provideContext(services));
  const attention = yield* Attention.Attention.pipe(Effect.provideContext(services));
  const store = yield* KanbanStore.KanbanStore.pipe(Effect.provideContext(services));
  return {
    run,
    store,
    attention,
    open: attention.listOpen({ pluginId: "kanban", kind: "decision_conflict" }),
  };
});

it.effect("a conflicted decision keeps one flag on its project until its state changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, store, attention, open } = yield* fixture;
      // Raised before this start for a project the store has not loaded: left alone.
      const unloaded = "decision:project-2:auth/keep-ttl";
      yield* attention.raise({
        pluginId: "kanban",
        threadId: unloaded,
        kind: "decision_conflict",
        text: "Older.",
        resumeAction: { label: "Open decisions", target: "board" },
      });

      const { id } = yield* store.write(projectId, "user", {
        action: "decision.create",
        title: "Cache in Redis",
        why: "Shared across workers.",
        state: "conflicted",
      });
      yield* store.write(projectId, "user", {
        action: "decision.create",
        title: "Cache in memory",
        why: "Fast.",
      });

      assert.deepEqual(yield* run({ dryRun: true }), { examined: 2, acted: 0, flags: 1 });
      assert.deepEqual(
        (yield* open).map((flag) => flag.threadId),
        [unloaded],
      );

      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 1, flags: 1 });
      const key = `decision:${projectId}:general/${id}`;
      assert.deepEqual(yield* open, [
        { threadId: unloaded, text: "Older." },
        {
          threadId: key,
          text: 'Decision "Cache in Redis" (general/cache-in-redis) is conflicted.',
        },
      ]);
      // The board and the weekly report attribute it to the project.
      assert.isTrue(flagKeyedToProject(key, projectId));
      // Reconciled state writes nothing.
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 0, flags: 1 });

      yield* store.write(projectId, "user", {
        action: "decision.setState",
        category: "general",
        id,
        state: "accepted",
      });
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 1, flags: 0 });
      assert.deepEqual(
        (yield* open).map((flag) => flag.threadId),
        [unloaded],
      );
    }),
  ),
);
