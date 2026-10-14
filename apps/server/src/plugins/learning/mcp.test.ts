import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  LearningCorrection,
  LearningItem,
  LearningItemDetail,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as ClassifySweep from "./ClassifySweep.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import { plugin } from "./index.ts";
import * as ItemStore from "./items/ItemStore.ts";
import { migrations } from "./migrations.ts";
import * as PromotionStore from "./PromotionStore.ts";

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
const decodeItems = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(LearningItem)));
const decodeItemDetail = Schema.decodeUnknownSync(Schema.fromJsonString(LearningItemDetail));

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
        // As `thread.created` leaves it: the plugin knows thread-1 belongs to project-1.
        yield* sql`INSERT INTO threads (thread_id, project_id) VALUES ('thread-1', ${projectId})`;
        const stores = yield* Layer.build(
          Layer.mergeAll(CorrectionStore.layer, ItemStore.layer).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          ),
        );
        const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
          Layer.provide(
            Layer.mock(PluginHost.PluginHost)({
              activeIds: new Set(["learning"]),
              databases: new Map([["learning", sql]]),
            }),
          ),
          Layer.provide(Layer.succeedContext(stores)),
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
        expect(tools).toContain('"learning_items"');
        expect(tools).toContain('"learning_item"');
        expect(tools).toContain('"learning_promotion_review"');
        expect(tools).toContain('"learning_promotion_rollback"');

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

        const mismatched = yield* rpc(6, "tools/call", {
          name: "learning_correction_add",
          arguments: {
            projectId: "project-2",
            threadId: "thread-1",
            description: "Wrong project.",
          },
        });
        expect(JSON.parse(resultText(mismatched))).toMatchObject({
          code: "invalid_request",
          message: 'Thread "thread-1" belongs to project "project-1".',
        });

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

        // The classify sweep turns the declared mode into an item the read tools show.
        const classify = yield* ClassifySweep.sweep.pipe(
          Effect.provide(stores),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        yield* classify.run({ dryRun: false });
        const items = decodeItems(
          resultText(
            yield* rpc(7, "tools/call", { name: "learning_items", arguments: { projectId } }),
          ),
        );
        expect(
          items.map((item) => [item.failureMode, item.ownerKind, item.state, item.occurrences]),
        ).toEqual([["incomplete", "local_only", "open", 1]]);
        const item = decodeItemDetail(
          resultText(
            yield* rpc(8, "tools/call", { name: "learning_item", arguments: { id: items[0]!.id } }),
          ),
        );
        expect(item.evidence.map((e) => e.evidenceKey)).toEqual([`correction:${added.id}`]);
        expect(item.promotions).toEqual([]);
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

/** A provider session T3 Code launched for `threadId`. */
const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
    // The instance `liveThreadShell` gives every thread.
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "learning", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "learning", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("an agent reviews and rolls back a promotion it did not propose, as its thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "learning",
        filename: ":memory:",
        migrations,
      });
      const stores = yield* Layer.build(
        Layer.mergeAll(CorrectionStore.layer, ItemStore.layer).pipe(
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
        ),
      );
      const services = yield* Layer.build(
        plugin.mcp(McpHttpServer.toolkitRegistration).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(Layer.succeedContext(stores)),
          Layer.provide(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            }),
          ),
        ),
      );
      const server = Context.get(services, McpServer.McpServer);
      const call = (scope: McpInvocationContext.McpInvocationScope, name: string, args: object) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
          );
      const failureOf = (result: {
        readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      }) => JSON.parse(result.content[0]?.text ?? "{}") as { code?: string; message?: string };

      // Two drafts in review: one the rules proposed, one an agent's own thread proposed.
      const items = Context.get(stores, ItemStore.ItemStore);
      const inReview = (mode: string) =>
        Effect.gen(function* () {
          const item = yield* items.strengthen(projectId, mode, `${mode}:1`, "Seeded.");
          const now = yield* DateTime.now;
          yield* PromotionStore.open(
            {
              id: item.id,
              project_id: projectId,
              failure_mode: mode,
              owner_kind: item.ownerKind!,
              disposition_by: "rule",
            },
            now,
          );
          const [promotion] = yield* PromotionStore.forItem(item.id);
          yield* PromotionStore.deliver(promotion!, now);
          return promotion!.id;
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const byRules = yield* inReview("scope_drift");
      const byAgent = yield* inReview("missing_verification");
      yield* sql`UPDATE learning_promotions SET proposed_by = 'thread:reviewer' WHERE id = ${byAgent}`;
      const reviewer = threadScope(ThreadId.make("reviewer"));

      const own = yield* call(reviewer, "learning_promotion_review", {
        promotionId: byAgent,
        verdict: "adopt",
      });
      expect(own.isError).toBe(true);
      expect(failureOf(own)).toEqual({
        _tag: "OrchestratorMcpFailure",
        code: "invalid_request",
        message: `Promotion ${byAgent} was proposed by thread:reviewer, so someone else reviews it.`,
      });
      const other = yield* call(threadScope(ThreadId.make("other")), "learning_promotion_review", {
        promotionId: byAgent,
        verdict: "reject",
        note: "Not a policy matter.",
      });
      expect(other.structuredContent).toMatchObject({ state: "rejected" });

      const outside = yield* call(clientScope, "learning_promotion_review", {
        promotionId: byRules,
        verdict: "adopt",
      });
      expect(outside.isError).toBe(true);
      expect(failureOf(outside).code).toBe("thread_credential_required");

      const adopted = yield* call(reviewer, "learning_promotion_review", {
        promotionId: byRules,
        verdict: "adopt",
      });
      expect(adopted.structuredContent).toMatchObject({ state: "adopted" });
      const rolledBack = yield* call(reviewer, "learning_promotion_rollback", {
        promotionId: byRules,
      });
      expect(rolledBack.structuredContent).toMatchObject({
        state: "rolled_back",
        rolledBackBy: "thread:reviewer",
      });
      expect(
        (yield* items.get(
          (yield* items.list({ projectId })).find((i) => i.failureMode === "scope_drift")!.id,
        )).reviews.map((review) => [review.verdict, review.reviewer]),
      ).toEqual([["adopt", "thread:reviewer"]]);
    }),
  ),
);
