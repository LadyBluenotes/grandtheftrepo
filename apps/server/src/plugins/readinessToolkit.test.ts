import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  HOST_METHODS,
  PLUGIN_GATEWAY_WS_METHODS,
  PluginReadiness,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import * as Readiness from "./Readiness.ts";

/** A plugin service whose one check names the project it was asked about. */
class Probe extends Context.Service<Probe, Readiness.Checks>()(
  "t3/plugins/readinessToolkit.test/Probe",
) {}
const probe = Probe.of({
  checks: (projectId) =>
    Effect.succeed([
      Readiness.ready(
        { id: "probe", label: "Probe", target: null },
        projectId === null ? "Asked about the environment." : `Asked about ${projectId}.`,
      ),
    ]),
});
const plugins = [
  { id: "probe", dependsOn: [], readiness: Readiness.fromService(Probe) },
  { id: "idle", dependsOn: ["ghost"] },
];

const projectId = ProjectId.make("project-1");
const clientToken = "client-payload.client-signature";
const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-1"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** The structured result of an MCP tool call, from a JSON or SSE response body. */
function structuredResult(body: string): unknown {
  const json = body.startsWith("{")
    ? body
    : (body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length) ?? "{}");
  const parsed = JSON.parse(json) as { result?: { structuredContent?: unknown } };
  return parsed.result?.structuredContent;
}

/**
 * The tool registers through the host the way the server does, over
 * `PluginHost.layerMcp(toolkitRegistration)`, and answers with what `plugins.readiness` answers.
 */
it.effect("the plugins_readiness tool and the plugins.readiness method agree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = Context.get(
        yield* Layer.build(Layer.effect(PluginHost.PluginHost, PluginHost.make(plugins))),
        PluginHost.PluginHost,
      );
      const fromMethod = (input: { readonly projectId?: ProjectId }) =>
        PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.read]({
          method: HOST_METHODS.readiness.method,
          input,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PluginReadiness))),
          Effect.provideService(PluginHost.PluginHost, host),
          Effect.provideService(Probe, probe),
        );

      const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
        Layer.provide(Layer.succeed(PluginHost.PluginHost, host)),
        Layer.provide(Layer.succeed(Probe, probe)),
        Layer.provide(Layer.mock(PluginSupervisor.PluginSupervisor)({})),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(null),
          }),
        ),
        // The registry's plugins are inactive here, but their tools' requirements type through.
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.succeed(undefined),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}` ? clientScope : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${clientToken}`,
      };
      const initialize = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      assert.strictEqual(initialize.status, 200);
      const call = (id: number, args: object) =>
        httpClient
          .post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name: "plugins_readiness", arguments: args },
              }),
              "application/json",
            ),
          })
          .pipe(
            Effect.flatMap((response) => response.text),
            Effect.map(structuredResult),
          );

      const forProject = yield* fromMethod({ projectId });
      assert.deepEqual(yield* call(2, { projectId }), { plugins: forProject });
      assert.deepEqual(
        forProject.map(({ plugin, checks }) => [plugin, checks.map((check) => check.sentence)]),
        [
          ["probe", ["Asked about project-1."]],
          ["idle", ["It needs ghost, which is off."]],
        ],
      );

      // Outside a T3 thread and without a project, both answer for the environment alone.
      const forEnvironment = yield* fromMethod({});
      assert.deepEqual(yield* call(3, {}), { plugins: forEnvironment });
      assert.deepEqual(forEnvironment[0]?.checks[0]?.sentence, "Asked about the environment.");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-readiness-test-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  ),
);
