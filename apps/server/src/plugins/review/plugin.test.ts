import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PLUGIN_GATEWAY_WS_METHODS,
  REVIEW_METHODS,
  ReviewRequest,
  ReviewVerdictError,
  SecurityModeSetting,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpServer } from "effect/ai";

import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Attention from "../Attention.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";
import { later, projectId, readModel, ready, reviewed } from "./testkit.ts";

const REVIEW_TOOLS = [
  "review_verdict",
  "review_verdicts",
  "review_request",
  "review_requests",
  "review_security_ack",
  "review_security_findings",
];

const writePluginsJson = (plugins: string) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(path.join(stateDir, "plugins.json"), plugins);
  });

/** The tools `/mcp` offers over `learning` and `review` alone, with `plugins.json` as given. */
const toolsWith = (plugins: string) =>
  Effect.gen(function* () {
    yield* writePluginsJson(plugins);
    const host = yield* PluginHost.make(
      registry.filter((plugin) => plugin.id === "learning" || plugin.id === "review"),
    );
    const services = yield* Layer.build(
      PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(Layer.succeed(PluginHost.PluginHost, host)),
        Layer.provide(Layer.mock(PluginSupervisor.PluginSupervisor)({})),
        Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
        // Every registered plugin's requirements are in the MCP layer's type; neither uses these.
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(ServerSettings.layerTest()),
      ),
    );
    return Context.get(services, McpServer.McpServer).tools.map(({ tool }) => tool.name);
  });

const layerConfig = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-review-plugin-" }),
);

it.layer(NodeServices.layer)("review plugin gating", (it) => {
  it.effect("registers the review tools while learning runs", () =>
    Effect.gen(function* () {
      const tools = yield* toolsWith("{}");
      assert.includeMembers(tools, REVIEW_TOOLS);
    }).pipe(Effect.scoped, Effect.provide(layerConfig)),
  );

  it.effect("registers none once review or learning is turned off", () =>
    Effect.gen(function* () {
      for (const plugins of ['{"review":false}', '{"learning":false}']) {
        const tools = yield* toolsWith(plugins);
        for (const tool of REVIEW_TOOLS) assert.notInclude(tools, tool);
      }
    }).pipe(Effect.scoped, Effect.provide(layerConfig)),
  );
});

/** Every registered plugin off but those named. */
const only = (ids: ReadonlyArray<string>) =>
  `{ ${registry
    .filter((plugin) => !ids.includes(plugin.id))
    .map((plugin) => `"${plugin.id}": false`)
    .join(", ")} }`;

/** The real host and supervisor over a fresh state directory and the review read model. */
const withHost = <A, E, R>(
  plugins: string,
  body: (model: Effect.Success<typeof readModel>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* writePluginsJson(plugins);
    const model = yield* readModel;
    return yield* body(model).pipe(
      Effect.provide(
        PluginHost.layerAll.pipe(
          Layer.provide(
            Layer.mergeAll(
              SqlitePersistence.layerMemory,
              model.layer,
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
              ServerSettings.layerTest(),
            ),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(layerConfig.pipe(Layer.provide(NodeServices.layer)), NodeServices.layer),
    ),
  );

const call = (gateway: keyof typeof PLUGIN_GATEWAY_WS_METHODS, method: string, input: unknown) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS[gateway]]({ method, input });
const decodeRequest = Schema.decodeUnknownEffect(ReviewRequest);
const decodeRequests = Schema.decodeUnknownEffect(Schema.Array(ReviewRequest));
const decodeError = Schema.decodeUnknownEffect(ReviewVerdictError);
const decodeMode = Schema.decodeUnknownEffect(SecurityModeSetting);

it.effect("enabled: a request over the gateway goes stale on the supervisor's tick", () =>
  withHost(only(["learning", "review"]), (model) =>
    Effect.gen(function* () {
      const supervisor = yield* PluginSupervisor.PluginSupervisor;
      const registered = (yield* supervisor.status).sweeps;
      assert.deepInclude(registered, { plugin: "review", name: "invalidation" });
      assert.deepInclude(registered, { plugin: "review", name: "security" });

      // A project's security mode is `warn` until it is set over the settings gateway. `off` leaves
      // the request below free of the scan.
      const getMode = call("read", REVIEW_METHODS.securityGetMode.method, { projectId }).pipe(
        Effect.flatMap(decodeMode),
      );
      assert.deepEqual(yield* getMode, { projectId, mode: "warn" });
      yield* call("settingsWrite", REVIEW_METHODS.securitySetMode.method, {
        projectId,
        mode: "off",
      });
      assert.deepEqual(yield* getMode, { projectId, mode: "off" });

      const asked = yield* call("operate", REVIEW_METHODS.request.method, {
        threadId: reviewed,
      }).pipe(Effect.flatMap(decodeRequest));
      assert.strictEqual(asked.checkpointId, ready);
      assert.strictEqual(asked.requestedBy, "user");

      yield* model.captureLater;
      const tick = yield* supervisor.tick;
      assert.deepEqual(
        tick.sweeps
          .filter((sweep) => sweep.plugin === "review")
          .map((s) => [s.name, s.status, s.examined, s.acted, s.flags]),
        [
          ["invalidation", "ok", 1, 2, 1],
          ["security", "ok", 0, 0, 0],
        ],
      );
      const listed = yield* call("read", REVIEW_METHODS.requestsList.method, {
        threadId: reviewed,
      }).pipe(Effect.flatMap(decodeRequests));
      assert.deepEqual(
        listed.map((request) => [request.checkpointId, request.status]),
        [
          [later, "open"],
          [ready, "stale"],
        ],
      );
      const flags = yield* (yield* Attention.Attention).listOpen({
        pluginId: "review",
        kind: "stale_review",
      });
      assert.deepEqual(flags, [
        { threadId: reviewed, text: `Review of checkpoint ${ready} is out of date` },
      ]);
    }),
  ),
);

it.effect(
  "disabled: no sweep, and the request and security methods say the plugin is not running",
  () =>
    withHost(only(["learning"]), () =>
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const registered = (yield* supervisor.status).sweeps;
        assert.notDeepInclude(registered, { plugin: "review", name: "invalidation" });
        assert.notDeepInclude(registered, { plugin: "review", name: "security" });
        for (const [gateway, method, input] of [
          ["operate", REVIEW_METHODS.request.method, { threadId: reviewed }],
          ["read", REVIEW_METHODS.requestsList.method, { threadId: reviewed }],
          [
            "operate",
            REVIEW_METHODS.securityAck.method,
            { threadId: reviewed, reason: "Fixture." },
          ],
          ["read", REVIEW_METHODS.securityFindings.method, { threadId: reviewed }],
          ["read", REVIEW_METHODS.securityGetMode.method, { projectId }],
          ["settingsWrite", REVIEW_METHODS.securitySetMode.method, { projectId, mode: "off" }],
        ] as const) {
          const refused = yield* call(gateway, method, input).pipe(
            Effect.andThen(Effect.die("expected a failure")),
            Effect.flip,
          );
          if (refused._tag !== "PluginMethodError") return assert.fail(refused.message);
          const error = yield* decodeError(refused.error);
          assert.strictEqual(error.code, "inactive");
        }
      }),
    ),
);
