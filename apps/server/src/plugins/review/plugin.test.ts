import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpServer } from "effect/ai";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";

/** The tools `/mcp` offers over `learning` and `review` alone, with `plugins.json` as given. */
const toolsWith = (plugins: string) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(path.join(stateDir, "plugins.json"), plugins);
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
      assert.includeMembers(tools, ["review_verdict", "review_verdicts"]);
    }).pipe(Effect.scoped, Effect.provide(layerConfig)),
  );

  it.effect("registers neither once learning is turned off", () =>
    Effect.gen(function* () {
      const tools = yield* toolsWith('{"learning":false}');
      assert.notInclude(tools, "review_verdict");
      assert.notInclude(tools, "review_verdicts");
    }).pipe(Effect.scoped, Effect.provide(layerConfig)),
  );
});
