import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";

/** The real host and supervisor with only caveman enabled, over a fresh state directory. */
const layerHost = PluginHost.layerAll.pipe(
  Layer.provide(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      ServerSettings.layerTest(),
    ),
  ),
);

it.effect("enabled: its file is migrated and a tick with no reports records examined 0", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const others = registry.filter((plugin) => plugin.id !== "caveman");
      yield* fs.writeFileString(
        path.join(stateDir, "plugins.json"),
        `{ ${others.map((plugin) => `"${plugin.id}": false`).join(", ")} }`,
      );
      const cavemanHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-caveman-home-" });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        assert.deepEqual([...host.activeIds], ["caveman"]);
        const sql = host.databases.get("caveman")!;
        const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'caveman_%' ORDER BY name
        `;
        assert.deepEqual(
          tables.map((table) => table.name),
          ["caveman_learn_plan", "caveman_learn_sink"],
        );

        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const tick = yield* supervisor.tick.pipe(
          Effect.provideService(HostProcess.Environment, { CAVEMAN_HOME: cavemanHome }),
        );
        assert.deepEqual(
          tick.sweeps.map((s) => [s.plugin, s.name, s.status, s.examined, s.acted, s.flags]),
          [["caveman", "learn", "ok", 0, 0, 0]],
        );
        assert.deepEqual((yield* supervisor.status).latest?.sweeps[0]?.examined, 0);
        assert.deepEqual(yield* sql`SELECT id FROM caveman_learn_plan`, []);
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-caveman-" })).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
