import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const clientToken = "client-payload.client-signature";
const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const layerPolicy = PolicyService.layer.pipe(
  Layer.provide(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.map(
        PluginDatabase.open({ id: "policy", filename: ":memory:", migrations }),
        (opened) => opened.sql,
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);

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
 * `PluginHost.layerMcp(toolkitRegistration)` with the service in the surrounding
 * context, never declared as a tool dependency.
 */
it.effect(
  "registers policy_list through the plugin host and lists policies with their deliveries",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(layerPolicy);
        const policies = Context.get(services, PolicyService.PolicyService);
        const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
          Layer.provide(
            Layer.mock(PluginHost.PluginHost)({
              activeIds: new Set(["policy"]),
              databases: new Map(),
            }),
          ),
          Layer.provide(Layer.mock(PluginSupervisor.PluginSupervisor)({})),
        Layer.provide(Layer.succeedContext(services)),
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
                  request.headers.authorization === `Bearer ${clientToken}`
                    ? clientScope
                    : undefined,
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

        const tools = yield* rpc(2, "tools/list", {});
        expect(tools).toContain('"policy_list"');

        const empty = resultText(
          yield* rpc(3, "tools/call", { name: "policy_list", arguments: { projectId } }),
        );
        expect(empty).toBe("No policies.");

        yield* policies.create({
          projectId,
          key: "review",
          title: "Review",
          body: "Run the tests.",
        });
        yield* policies.create({
          projectId: ProjectId.make("*"),
          key: "tone",
          title: "Tone",
          body: "Be brief.",
        });
        yield* policies.accept({ projectId: ProjectId.make("*"), key: "tone", version: 1 });
        const listed = resultText(
          yield* rpc(4, "tools/call", { name: "policy_list", arguments: { projectId } }),
        );
        expect(listed).toBe(
          "*/tone · v1 · accepted · Tone\nproject-1/review · v1 · draft · Review",
        );

        const noProject = resultText(
          yield* rpc(5, "tools/call", { name: "policy_list", arguments: {} }),
        );
        expect(noProject).toContain("Pass projectId");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-policy-mcp-" })).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
);
