import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  LEARNING_METHODS,
  LearningItem,
  PLUGIN_GATEWAY_WS_METHODS,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";
import * as CorrectionStore from "./CorrectionStore.ts";

const projectId = ProjectId.make("project:learning");

/** The real host and supervisor with only learning enabled, over a fresh state directory. */
const layerHost = PluginHost.layerAll.pipe(
  Layer.provide(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      ServerSettings.layerTest(),
    ),
  ),
);

const onlyLearning = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const disabled = registry.filter((plugin) => plugin.id !== "learning").map((p) => p.id);
  yield* fs.writeFileString(
    path.join(stateDir, "plugins.json"),
    `{ ${disabled.map((id) => `"${id}": false`).join(", ")} }`,
  );
});

it.effect(
  "both sweeps run on the supervisor tick and turn a verdict into an item and a record",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* onlyLearning;
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          const supervisor = yield* PluginSupervisor.PluginSupervisor;
          assert.deepEqual((yield* supervisor.status).sweeps, [
            { plugin: "learning", name: "classify" },
            { plugin: "learning", name: "promote" },
          ]);
          const sql = host.databases.get("learning")!;
          yield* CorrectionStore.insert({
            projectId,
            threadId: ThreadId.make("thread:learning"),
            failureKind: "review_verdict",
            declaredMode: "scope_drift",
            description: "Touched files outside the issue.",
            sourceEventIds: [],
            sourceKey: "verdict:1",
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

          const tick = yield* supervisor.tick;
          assert.deepEqual(
            tick.sweeps.map((s) => [s.name, s.status, s.examined, s.acted, s.flags]),
            [
              ["classify", "ok", 1, 1, 0],
              ["promote", "ok", 1, 1, 0],
            ],
          );
          const items = yield* PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.read]({
            method: LEARNING_METHODS.items.method,
            input: { projectId },
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LearningItem))));
          assert.deepEqual(
            items.map((item) => [item.failureMode, item.ownerKind, item.state]),
            [["scope_drift", "policy", "candidate"]],
          );
          assert.deepEqual(
            yield* sql`SELECT owner_kind, state, attempts FROM learning_promotions`,
            [{ owner_kind: "policy", state: "pending", attempts: 0 }],
          );
        }).pipe(Effect.provide(layerHost));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-learning-" })).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
);
