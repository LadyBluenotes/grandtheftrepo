import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CAVEMAN_METHODS,
  CavemanError,
  CavemanStatus,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginRpc from "../PluginRpc.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as CavemanService from "./CavemanService.ts";
import * as CavemanHandlers from "./handlers.ts";

const decodeStatus = Schema.decodeUnknownEffect(CavemanStatus);
const decodeError = Schema.decodeUnknownEffect(CavemanError);

/** `caveman.status` through the read gateway, as a client calls it. */
const statusCall = PluginRpc.dispatch("read", CavemanHandlers.table, {
  method: CAVEMAN_METHODS.status.method,
  input: {},
});

const clientToken = "client-payload.client-signature";
const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-1"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const status: CavemanStatus = {
  installed: true,
  version: "9.9.9",
  proxy: { origin: "http://127.0.0.1:8787", listening: true },
  agents: [
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      agent: "claude",
      route: "routed",
      detail: null,
      configPath: "/home/user/.claude/settings.json",
    },
  ],
};
const caveman: CavemanService.CavemanService["Service"] = {
  status: Effect.succeed(status),
  setRoute: () => Effect.succeed(status),
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
it.effect("the MCP tool returns what the plugin method returns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
        Layer.provide(
          Layer.mock(PluginHost.PluginHost)({
            activeIds: new Set(["caveman"]),
            databases: new Map(),
          }),
        ),
        Layer.provide(Layer.mock(PluginSupervisor.PluginSupervisor)({})),
        Layer.provide(Layer.succeed(CavemanService.CavemanService, caveman)),
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
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(ServerSettings.layerTest()),
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

      expect(yield* rpc(2, "tools/list", {})).toContain('"caveman_status"');

      const fromTool = JSON.parse(
        resultText(yield* rpc(3, "tools/call", { name: "caveman_status", arguments: {} })),
      );
      const fromHandler = yield* statusCall.pipe(
        Effect.flatMap(decodeStatus),
        Effect.provideService(CavemanService.CavemanService, caveman),
      );
      expect(fromTool).toEqual(fromHandler);
      expect(fromHandler.agents[0]?.route).toBe("routed");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-caveman-mcp-" })).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("the plugin methods answer with the plugin's own error while it is not running", () =>
  Effect.gen(function* () {
    const refused = yield* statusCall.pipe(
      Effect.andThen(Effect.die("expected a failure")),
      Effect.flip,
    );
    if (refused._tag !== "PluginMethodError") throw new Error(refused.message);
    const error = yield* decodeError(refused.error);
    expect(error.code).toBe("inactive");
    expect(error.message).toBe('Plugin "caveman" is not running.');
  }),
);
