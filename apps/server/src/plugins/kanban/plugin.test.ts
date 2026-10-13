import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KANBAN_METHODS,
  KanbanAttentionRow,
  KanbanError,
  PLUGIN_GATEWAY_WS_METHODS,
  ProjectId,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Attention from "../Attention.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";
import { projectA, thread } from "./writerFixtures.ts";

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

const writers: ReadonlyArray<OrchestrationV2ThreadShell> = [
  thread("a", { startedSeconds: 10 }),
  thread("b", { startedSeconds: 20 }),
];

/**
 * The real host and supervisor over a fresh state directory, with two writing threads in the
 * read model. The kanban plugin's layer is built exactly as the server builds it.
 */
const layerHost = PluginHost.layerAll.pipe(
  Layer.provide(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        streamDomainEvents: Stream.never,
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: writers,
            archivedThreads: [],
          }),
        listProjectThreads: ({ projectId }) =>
          Effect.succeed(writers.filter((writer) => writer.projectId === projectId)),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      }),
      // Inactive routing still types its catalog and settings reads through `layerAll`.
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      ServerSettings.layerTest(),
    ),
  ),
);

/** `plugins.json` that switches off every registered plugin except `kanban`. */
const onlyKanban = `{ ${registry
  .filter((plugin) => plugin.id !== "kanban")
  .map((plugin) => `"${plugin.id}": false`)
  .join(", ")} }`;
const allOff = `{ ${registry.map((plugin) => `"${plugin.id}": false`).join(", ")} }`;

const writeStateFile = (name: string, contents: string) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(stateDir, name), contents);
  });

const kanbanFileExists = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(stateDir, "plugins", "kanban.sqlite"));
});

const layerTest = Layer.mergeAll(
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-plugin-" })).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

const decodeError = Schema.decodeUnknownEffect(KanbanError);
const decodeSpecReport = Schema.decodeUnknownEffect(KANBAN_METHODS.specGet.output);
const specInput = { projectId: "project-1", id: "some-issue" };
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(KanbanAttentionRow));

const operate = (method: string, input: unknown) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.operate]({ method, input });
const read = (method: string, input: unknown) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.read]({ method, input });

it.effect(
  "enabled: its file is migrated, the writers sweep raises a host flag, and the stop works",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* writeStateFile("plugins.json", onlyKanban);
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          assert.deepEqual([...host.activeIds], ["kanban"]);
          assert.isTrue(yield* kanbanFileExists);
          const sql = host.databases.get("kanban")!;
          const tables = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
          const names = tables.map((table) => table.name);
          assert.include(names, "stop");
          assert.include(names, "spec_attempt");
          // Flags live in the host's database, not the plugin's.
          assert.notInclude(names, "attention");

          const supervisor = yield* PluginSupervisor.PluginSupervisor;
          assert.deepEqual((yield* supervisor.status).sweeps, [
            { plugin: "kanban", name: "writers" },
          ]);
          const tick = yield* supervisor.tick;
          assert.deepEqual(
            tick.sweeps.map((s) => [s.plugin, s.name, s.status, s.examined, s.acted, s.flags]),
            [["kanban", "writers", "ok", 2, 1, 1]],
          );
          const attention = yield* Attention.Attention;
          const flags = yield* attention.listOpen({ pluginId: "kanban", kind: "two_writers" });
          assert.deepEqual(
            flags.map((flag) => flag.threadId),
            ["a"],
          );
          const rows = yield* decodeRows(
            yield* read(KANBAN_METHODS.attentionList.method, { projectId: projectA }),
          );
          assert.deepEqual(
            rows.map((row) => [row.source, row.kind, row.threadTitle]),
            [["flag", "two_writers", "Thread a"]],
          );

          assert.isNull(yield* read(KANBAN_METHODS.stopGet.method, {}));
          yield* operate(KANBAN_METHODS.stopSet.method, { reason: "freeze" });
          assert.deepEqual(
            yield* sql<{ readonly set_by: string; readonly reason: string }>`
              SELECT set_by, reason FROM stop`,
            [{ set_by: "user", reason: "freeze" }],
          );
          yield* operate(KANBAN_METHODS.stopClear.method, {});
          assert.isNull(yield* read(KANBAN_METHODS.stopGet.method, {}));
          assert.isNull(yield* read(KANBAN_METHODS.specGet.method, specInput));
        }).pipe(Effect.provide(layerHost));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("spec.get still reports an attempt once its issue is deleted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyKanban);
      yield* Effect.gen(function* () {
        const write = (input: unknown) => operate(KANBAN_METHODS.write.method, input);
        yield* write({
          projectId,
          action: "issue.create",
          title: "Gone soon",
          description: "Rough.",
          status: "triage",
        });
        const input = { projectId, id: "gone-soon" };
        yield* operate(KANBAN_METHODS.ticketSpecify.method, { ...input, useExisting: true });
        const before = yield* read(KANBAN_METHODS.specGet.method, input).pipe(
          Effect.flatMap(decodeSpecReport),
        );
        assert.deepEqual(
          [before?.issueStatus, before?.attempt.status, before?.attempt.reason],
          ["triage", "malformed", "Missing section: Goal."],
        );

        yield* write({ projectId, action: "issue.archive", id: "gone-soon" });
        yield* write({ projectId, action: "issue.delete", id: "gone-soon" });
        const after = yield* read(KANBAN_METHODS.specGet.method, input).pipe(
          Effect.flatMap(decodeSpecReport),
        );
        assert.deepEqual(
          [after?.issueStatus, after?.attempt.status, after?.attempt.reason],
          [null, "malformed", "Missing section: Goal."],
        );
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("a dry run records the sweep and writes no flag", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyKanban);
      yield* writeStateFile("supervisor.json", '{ "dryRun": true }');
      yield* Effect.gen(function* () {
        const tick = yield* (yield* PluginSupervisor.PluginSupervisor).tick;
        assert.isTrue(tick.dryRun);
        assert.deepEqual(
          tick.sweeps.map((s) => [s.name, s.status, s.acted, s.flags]),
          [["writers", "ok", 0, 1]],
        );
        const attention = yield* Attention.Attention;
        assert.deepEqual(
          yield* attention.listOpen({ pluginId: "kanban", kind: "two_writers" }),
          [],
        );
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("disabled: no file, no sweep, and its methods say the plugin is not active", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", allOff);
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        assert.deepEqual([...host.activeIds], []);
        assert.isFalse(yield* kanbanFileExists);
        assert.deepEqual((yield* (yield* PluginSupervisor.PluginSupervisor).status).sweeps, []);

        for (const call of [
          operate(KANBAN_METHODS.stopSet.method, {}),
          operate(KANBAN_METHODS.ticketSpecify.method, specInput),
          read(KANBAN_METHODS.specGet.method, specInput),
          read(KANBAN_METHODS.attentionList.method, { projectId: projectA }),
        ]) {
          const refused = yield* call.pipe(
            Effect.andThen(Effect.die("expected a failure")),
            Effect.flip,
          );
          if (refused._tag !== "PluginMethodError") return assert.fail(refused.message);
          const error = yield* decodeError(refused.error);
          assert.strictEqual(error.code, "inactive");
        }
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);
