import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as PluginHost from "../PluginHost.ts";
import * as KanbanStore from "./KanbanStore.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
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
 * The plugin registers its tools through the host the way the server does:
 * `PluginHost.layerMcp(toolkitRegistration)` with the store in the surrounding
 * context, never declared as a tool dependency.
 */
it.effect("registers kanban tools through the plugin host and files an issue over MCP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
        Layer.provide(Layer.mock(PluginHost.PluginHost)({ activeIds: new Set(["kanban"]) })),
        Layer.provide(KanbanStore.layer),
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
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
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
      expect(tools).toContain('"kanban_list"');
      expect(tools).toContain('"kanban_write"');

      const created = resultText(
        yield* rpc(3, "tools/call", {
          name: "kanban_write",
          arguments: {
            projectId,
            action: "issue.create",
            title: "Found a bug",
            verification: "partial",
          },
        }),
      );
      expect(created).toBe("found-a-bug");

      const listed = resultText(
        yield* rpc(4, "tools/call", {
          name: "kanban_list",
          arguments: { projectId, kind: "issue" },
        }),
      );
      expect(listed).toContain("found-a-bug · triage · p3 · Found a bug · partial");

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      expect(
        yield* fs.exists(
          path.join(baseDir, "wiki", "grand-theft-repo", "issues", "found-a-bug.md"),
        ),
      ).toBe(true);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kanban-mcp-" })).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
