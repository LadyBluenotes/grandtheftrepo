import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PLUGIN_GATEWAY_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ROUTING_METHODS,
  RoutingAdherence,
  RoutingError,
  RoutingObservedDetail,
  RoutingRecommendedDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginHost from "../PluginHost.ts";
import { registry } from "../registry.ts";

const input = {
  projectId: ProjectId.make("project:routing"),
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-12T00:00:00.000Z",
};

/** `routing.adherence` through the read gateway, as a client calls it. */
const adherence = PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.read]({
  method: ROUTING_METHODS.adherence.method,
  input,
});
const decodeAdherence = Schema.decodeUnknownEffect(RoutingAdherence);
const decodeAdherenceJson = Schema.decodeUnknownSync(Schema.fromJsonString(RoutingAdherence));
const decodeRoutingError = Schema.decodeUnknownEffect(RoutingError);
const encodeRecommended = Schema.encodeSync(Schema.fromJsonString(RoutingRecommendedDetail));
const encodeObserved = Schema.encodeSync(Schema.fromJsonString(RoutingObservedDetail));

const clientToken = "client-payload.client-signature";
const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-1"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const McpResult = Schema.Struct({
  tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
});
const decodeMcpResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ result: Schema.optional(McpResult) })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The JSON-RPC result of an MCP call, from a JSON or SSE response body. */
const mcpResult = (body: string): typeof McpResult.Type =>
  decodeMcpResponse(
    body.startsWith("{")
      ? body
      : (body
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length) ?? "{}"),
  ).result ?? {};

/** `plugins.json` that switches off every registered plugin except `keep`, whatever the registry holds. */
const onlyPlugins = (keep: ReadonlyArray<string>) =>
  `{ ${registry
    .filter((plugin) => !keep.includes(plugin.id))
    .map((plugin) => `"${plugin.id}": false`)
    .join(", ")} }`;

const writePluginsFile = (contents: string) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(stateDir, "plugins.json"), contents);
  });

/**
 * The real host over a fresh state directory, with the core services the plugins and the host's
 * sink need. The sink runs on an empty in-memory core database, so the reactor has nothing to replay.
 */
const layerHost = PluginHost.layerAll.pipe(
  Layer.provide(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
      ServerSettings.layerTest(),
    ),
  ),
);

/** `/mcp` the way the server builds it, over whatever host is in the context; calls return the result. */
const mcp = Effect.gen(function* () {
  const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
    Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
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
  const session = {
    ...headers,
    "mcp-session-id": initialize.headers["mcp-session-id"]!,
    "mcp-protocol-version": "2025-06-18",
  };
  let id = 1;
  return (method: string, params: unknown) =>
    httpClient
      .post("/mcp", {
        headers: session,
        body: HttpBody.text(
          encodeJson({ jsonrpc: "2.0", id: ++id, method, params }),
          "application/json",
        ),
      })
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.map(mcpResult),
      );
});

/**
 * Five launches in the window as the reactor leaves them: four ran as recommended, one did not.
 * The recommendations come first, so their ids are 1 to 5.
 */
const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const ns = [1, 2, 3, 4, 5];
    for (const n of ns) {
      yield* sql`
        INSERT INTO routing_events
          (at, kind, project_id, thread_id, tier, provider_instance_id, model, detail)
        VALUES
          (${`2026-10-0${n}T12:00:00.000Z`}, 'routing_recommended', ${input.projectId},
           ${`thread:${n}`}, 'cheap', 'alpha', 'a-3',
           ${encodeRecommended({ taskClass: "mechanical", failedRuns: 0, reason: "rule" })})
      `;
    }
    for (const n of ns) {
      const detail =
        n === 5
          ? ({
              recommendationId: n,
              observed: { providerInstanceId: ProviderInstanceId.make("beta"), model: "b-1" },
              matched: false,
              flag: `Thread thread:${n} was recommended the cheap tier but ran b-1 on beta.`,
            } satisfies RoutingObservedDetail)
          : ({
              recommendationId: n,
              observed: { providerInstanceId: ProviderInstanceId.make("alpha"), model: "a-3" },
              matched: true,
              flag: null,
            } satisfies RoutingObservedDetail);
      yield* sql`
        INSERT INTO routing_events
          (at, kind, project_id, thread_id, tier, provider_instance_id, model, recommendation_id,
           detail)
        VALUES
          (${`2026-10-0${n}T12:00:01.000Z`}, 'routing_observed', ${input.projectId},
           ${`thread:${n}`}, 'cheap', 'alpha', 'a-3', ${n}, ${encodeObserved(detail)})
      `;
    }
  });

const layerTest = Layer.mergeAll(
  NodeHttpServer.layerTest,
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-routing-" })).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

it.effect("enabled: the RPC and the MCP tool return the same adherence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writePluginsFile(onlyPlugins(["routing"]));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        assert.deepEqual([...host.activeIds], ["routing"]);
        yield* seed(host.databases.get("routing")!);

        const fromRpc = yield* adherence.pipe(Effect.flatMap(decodeAdherence));
        assert.strictEqual(fromRpc.measure.measure, "routing_adherence");
        assert.strictEqual(fromRpc.measure.state, "ok");
        assert.strictEqual(fromRpc.measure.value, 0.8);
        assert.strictEqual(fromRpc.measure.sampleSize, 5);
        assert.deepEqual(
          fromRpc.mismatches.map((mismatch) => [mismatch.threadId, mismatch.observed.model]),
          [["thread:5", "b-1"]],
        );

        const call = yield* mcp;
        const tools = (yield* call("tools/list", {})).tools?.map((tool) => tool.name) ?? [];
        assert.includeMembers(tools, ["routing_tiers", "routing_adherence"]);
        const called = yield* call("tools/call", { name: "routing_adherence", arguments: input });
        assert.deepEqual(decodeAdherenceJson(called.content?.[0]?.text ?? ""), fromRpc);
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("disabled: no tool, and the RPC says the plugin is not running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writePluginsFile(onlyPlugins([]));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        assert.deepEqual([...host.activeIds], []);

        const refused = yield* adherence.pipe(
          Effect.andThen(Effect.die("expected a failure")),
          Effect.flip,
        );
        if (refused._tag !== "PluginMethodError") return assert.fail(refused.message);
        const error = yield* decodeRoutingError(refused.error);
        assert.strictEqual(error.code, "inactive");
        assert.strictEqual(error.message, 'Plugin "routing" is not running.');

        const call = yield* mcp;
        const tools = (yield* call("tools/list", {})).tools?.map((tool) => tool.name) ?? [];
        assert.include(tools, "supervisor_status");
        assert.notInclude(tools, "routing_adherence");
        assert.notInclude(tools, "routing_tiers");
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);
