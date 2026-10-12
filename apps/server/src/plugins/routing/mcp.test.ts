import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ROUTING_METHODS,
  type Project,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as RoutingHandlers from "./handlers.ts";
import { migrations } from "./migrations.ts";
import * as TierMapService from "./TierMapService.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("alpha");
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
const provider: ServerProvider = {
  driver: ProviderDriverKind.make("codex"),
  instanceId,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-10-01T00:00:00.000Z",
  auth: { status: "authenticated" },
  models: ["a-1", "a-2", "a-3"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  skills: [],
  slashCommands: [],
};
const layerProviders = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([provider]),
});
const layerSettings = ServerSettings.layerTest();
const layerProjects = Layer.mock(ProjectService.ProjectService)({
  getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
});
const clientToken = "client-payload.client-signature";
const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** The text an MCP tool call returned, from a JSON or SSE response body. */
function resultText(body: string): string {
  const json = body.startsWith("{")
    ? body
    : (body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length) ?? "{}");
  const parsed = JSON.parse(json) as { result?: { content?: Array<{ text?: string }> } };
  return parsed.result?.content?.[0]?.text ?? body;
}

/**
 * The plugin registers its tool through the host the way the server does:
 * `PluginHost.layerMcp(toolkitRegistration)` with the service in the surrounding context.
 */
it.effect("the MCP tool and the plugin method return the same tiers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "routing",
        filename: ":memory:",
        migrations,
      });
      const services = yield* Layer.build(
        TierMapService.layer.pipe(
          Layer.provideMerge(layerProviders),
          Layer.provideMerge(layerSettings),
          Layer.provideMerge(layerProjects),
          Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)),
        ),
      );
      const tierMap = Context.get(services, TierMapService.TierMapService);
      yield* tierMap.set({
        scope: "environment",
        tier: "cheap",
        entry: { providerInstanceId: instanceId, model: "a-2" },
      });
      yield* tierMap.set({
        scope: projectId,
        tier: "strong",
        entry: { providerInstanceId: instanceId, model: "a-3" },
      });

      const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
        Layer.provide(
          Layer.mock(PluginHost.PluginHost)({
            activeIds: new Set(["routing"]),
            databases: new Map([["routing", sql]]),
          }),
        ),
        Layer.provide(Layer.mock(PluginSupervisor.PluginSupervisor)({})),
        Layer.provide(Layer.succeed(TierMapService.TierMapService, tierMap)),
        Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
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
        Layer.provide(layerProjects),
        Layer.provide(layerProviders),
        Layer.provide(layerSettings),
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
      expect(initialize.status).toBe(200);
      const session = {
        ...headers,
        "mcp-session-id": initialize.headers["mcp-session-id"]!,
        "mcp-protocol-version": "2025-06-18",
      };
      const rpc = (id: number, method: string, params: unknown) =>
        httpClient
          .post("/mcp", {
            headers: session,
            body: HttpBody.text(
              JSON.stringify({ jsonrpc: "2.0", id, method, params }),
              "application/json",
            ),
          })
          .pipe(Effect.flatMap((response) => response.text));

      expect(yield* rpc(2, "tools/list", {})).toContain('"routing_tiers"');

      const fromTool = JSON.parse(
        resultText(
          yield* rpc(3, "tools/call", { name: "routing_tiers", arguments: { projectId } }),
        ),
      );
      const fromHandler = yield* RoutingHandlers.handlers[ROUTING_METHODS.tiersGet.method]({
        projectId,
      }).pipe(Effect.provideService(TierMapService.TierMapService, tierMap));
      expect(fromTool).toEqual(fromHandler);
      expect(fromHandler.cheap.source).toBe("environment");
      expect(fromHandler.strong.source).toBe("project");
      expect(fromHandler.standard.source).toBe("builtin");

      // Outside a T3 thread there is no project to fall back to.
      expect(
        resultText(yield* rpc(4, "tools/call", { name: "routing_tiers", arguments: {} })),
      ).toContain("Pass projectId");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-routing-mcp-" })).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("the plugin methods answer with the plugin's own error while it is not running", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(RoutingHandlers.handlers[ROUTING_METHODS.tiersGet.method]({}));
    expect(error.message).toBe('Plugin "routing" is not running.');
    expect(error.code).toBe("inactive");
  }),
);
