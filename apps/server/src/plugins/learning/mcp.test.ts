import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, LearningCorrection, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import { migrations } from "./migrations.ts";

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

const decodeCorrection = Schema.decodeUnknownSync(Schema.fromJsonString(LearningCorrection));
const decodeCorrections = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(LearningCorrection)),
);

/**
 * The plugin registers its tools through the host the way the server does:
 * `PluginHost.layerMcp(toolkitRegistration)` with the store in the surrounding
 * context, never declared as a tool dependency.
 */
it.effect(
  "registers learning tools through the plugin host and records a correction over MCP",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql } = yield* PluginDatabase.open({
          id: "learning",
          filename: ":memory:",
          migrations,
        });
        const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
          Layer.provide(
            Layer.mock(PluginHost.PluginHost)({
              activeIds: new Set(["learning"]),
              databases: new Map([["learning", sql]]),
            }),
          ),
          Layer.provide(
            CorrectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
          ),
          Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
          // Kanban's tools need it by type even though only learning is active here.
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(PluginSupervisor.PluginSupervisor)({})),
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
        expect(tools).toContain('"learning_corrections"');
        expect(tools).toContain('"learning_correction"');
        expect(tools).toContain('"learning_correction_add"');

        const added = decodeCorrection(
          resultText(
            yield* rpc(3, "tools/call", {
              name: "learning_correction_add",
              arguments: {
                projectId,
                threadId: "thread-1",
                description: "Shipped without the migration. TOKEN=abc123",
                declaredMode: "incomplete",
              },
            }),
          ),
        );
        expect(added.failureKind).toBe("manual");
        expect(added.declaredMode).toBe("incomplete");
        expect(added.description).toBe("Shipped without the migration. TOKEN=[redacted]");

        const listed = decodeCorrections(
          resultText(
            yield* rpc(4, "tools/call", {
              name: "learning_corrections",
              arguments: {
                projectId,
                from: "1970-01-01T00:00:00.000Z",
                to: "2100-01-01T00:00:00.000Z",
              },
            }),
          ),
        );
        expect(listed).toEqual([added]);

        const one = decodeCorrection(
          resultText(
            yield* rpc(5, "tools/call", {
              name: "learning_correction",
              arguments: { id: added.id },
            }),
          ),
        );
        expect(one).toEqual(added);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-learning-mcp-" }),
          ).pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
        ),
      ),
    ),
);
