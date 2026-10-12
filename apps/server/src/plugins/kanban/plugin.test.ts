import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KANBAN_METHODS,
  KanbanError,
  PLUGIN_GATEWAY_WS_METHODS,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";
import { thread } from "./writerFixtures.ts";

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
      }),
      Layer.mock(ProjectService.ProjectService)({}),
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

const operate = (method: string, input: unknown) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.operate]({ method, input });
const read = (method: string, input: unknown) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.read]({ method, input });

it.effect(
  "enabled: its file is migrated, the writers sweep records a flag in it, and the stop works",
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
          assert.includeMembers(
            tables.map((table) => table.name),
            ["attention", "stop"],
          );

          const supervisor = yield* PluginSupervisor.PluginSupervisor;
          assert.deepEqual((yield* supervisor.status).sweeps, [
            { plugin: "kanban", name: "writers" },
          ]);
          const tick = yield* supervisor.tick;
          assert.deepEqual(
            tick.sweeps.map((s) => [s.plugin, s.name, s.status, s.examined, s.acted, s.flags]),
            [["kanban", "writers", "ok", 2, 1, 1]],
          );
          const flags = yield* sql<{ readonly thread_id: string; readonly kind: string }>`
            SELECT thread_id, kind FROM attention WHERE cleared_at IS NULL`;
          assert.deepEqual(flags, [{ thread_id: "a", kind: "two_writers" }]);

          assert.isNull(yield* read(KANBAN_METHODS.stopGet.method, {}));
          yield* operate(KANBAN_METHODS.stopSet.method, { reason: "freeze" });
          assert.deepEqual(
            yield* sql<{ readonly set_by: string; readonly reason: string }>`
              SELECT set_by, reason FROM stop`,
            [{ set_by: "user", reason: "freeze" }],
          );
          yield* operate(KANBAN_METHODS.stopClear.method, {});
          assert.isNull(yield* read(KANBAN_METHODS.stopGet.method, {}));
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
        const host = yield* PluginHost.PluginHost;
        const tick = yield* (yield* PluginSupervisor.PluginSupervisor).tick;
        assert.isTrue(tick.dryRun);
        assert.deepEqual(
          tick.sweeps.map((s) => [s.name, s.status, s.acted, s.flags]),
          [["writers", "ok", 0, 1]],
        );
        const sql = host.databases.get("kanban")!;
        assert.deepEqual(yield* sql`SELECT id FROM attention`, []);
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("disabled: no file, no sweep, and the stop methods say the plugin is not active", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", allOff);
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        assert.deepEqual([...host.activeIds], []);
        assert.isFalse(yield* kanbanFileExists);
        assert.deepEqual((yield* (yield* PluginSupervisor.PluginSupervisor).status).sweeps, []);

        const refused = yield* operate(KANBAN_METHODS.stopSet.method, {}).pipe(
          Effect.andThen(Effect.die("expected a failure")),
          Effect.flip,
        );
        if (refused._tag !== "PluginMethodError") return assert.fail(refused.message);
        const error = yield* decodeError(refused.error);
        assert.strictEqual(error.code, "inactive");
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);
