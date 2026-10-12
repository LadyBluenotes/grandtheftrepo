import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PLUGIN_GATEWAY_WS_METHODS,
  ProjectId,
  TELEMETRY_METHODS,
  TelemetryError,
  TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

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
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";

const measuresInput = {
  projectId: ProjectId.make("project:telemetry"),
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-12T00:00:00.000Z",
};

/** `telemetry.measures` through the read gateway, as a client calls it. */
const measures = (input = measuresInput) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.read]({
    method: TELEMETRY_METHODS.measures.method,
    input,
  });
const decodeMeasures = Schema.decodeUnknownEffect(TelemetryMeasuresResult);
const decodeMeasuresJson = Schema.decodeUnknownSync(Schema.fromJsonString(TelemetryMeasuresResult));
const decodeTelemetryError = Schema.decodeUnknownEffect(TelemetryError);

/** The `TelemetryError` a gateway call failed with. */
const refusal = (call: ReturnType<typeof measures>) =>
  Effect.gen(function* () {
    const refused = yield* call.pipe(Effect.andThen(Effect.die("expected a failure")), Effect.flip);
    if (refused._tag !== "PluginMethodError") return assert.fail(refused.message);
    return yield* decodeTelemetryError(refused.error);
  });

const environmentId = EnvironmentId.make("env-1");
const clientToken = "client-payload.client-signature";
const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** The JSON-RPC result of an MCP call, from a JSON or SSE response body. */
function mcpResult(body: string): {
  readonly tools?: ReadonlyArray<{ readonly name: string }>;
  readonly content?: ReadonlyArray<{ readonly text?: string }>;
} {
  const json = body.startsWith("{")
    ? body
    : (body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length) ?? "{}");
  return (JSON.parse(json) as { result?: ReturnType<typeof mcpResult> }).result ?? {};
}

/** `plugins.json` that switches off every registered plugin except `keep`, whatever the registry holds. */
const onlyPlugins = (keep: ReadonlyArray<string>) =>
  `{ ${registry
    .filter((plugin) => !keep.includes(plugin.id))
    .map((plugin) => `"${plugin.id}": false`)
    .join(", ")} }`;

/**
 * The real host and supervisor over a fresh state directory, with the core
 * services the plugins and the host's sink need. The sink runs on an empty
 * in-memory core database, so the reactor has nothing to replay.
 */
const layerHost = PluginHost.layerAll.pipe(
  Layer.provide(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      // Inactive routing still types its catalog and settings reads through `layerAll`.
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      ServerSettings.layerTest(),
    ),
  ),
);

/** `/mcp` the way the server builds it, over whatever host is in the context; calls return the result. */
const mcp = Effect.gen(function* () {
  const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
    // Inactive here, but the kanban tools' static requirements still type through `layerMcp`.
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
          JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          "application/json",
        ),
      })
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.map(mcpResult),
      );
});

const tableNames = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    (rows) => rows.map((row) => row.name),
  );

const writeStateFile = (name: string, contents: string) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(stateDir, name), contents);
  });

const telemetryFileExists = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(stateDir, "plugins", "telemetry.sqlite"));
});

const layerTest = Layer.mergeAll(
  NodeHttpServer.layerTest,
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-telemetry-" })).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

/**
 * One window's rows, as the reactor would have stored them: a thread settled by hand in the
 * window, one run in it that read the same file twice.
 */
const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO telemetry_threads
        (thread_id, project_id, created_at, settled_at, settled_by_sweep)
      VALUES ('thread:1', ${measuresInput.projectId}, '2026-10-02T00:00:00.000Z',
        '2026-10-03T00:00:00.000Z', 0)`;
    yield* sql`INSERT INTO telemetry_runs
        (run_id, thread_id, turn_id, ordinal, status, model, started_at, completed_at)
      VALUES ('run:1', 'thread:1', 'message:1', 1, 'completed', 'test-model',
        '2026-10-02T00:00:00.000Z', '2026-10-02T00:10:00.000Z')`;
    yield* sql`INSERT INTO telemetry_tool_calls
        (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, status)
      VALUES
        ('item:1', 'run:1', 'thread:1', 1, 'dynamic_tool', 'Read', 'src/a.ts', 'completed'),
        ('item:2', 'run:1', 'thread:1', 2, 'dynamic_tool', 'Read', 'src/a.ts', 'completed')`;
  });

it.effect(
  "enabled: its file is migrated, the reactor and sweep run, and the tool and RPC agree",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* writeStateFile("plugins.json", onlyPlugins(["telemetry", "learning"]));
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          assert.deepEqual([...host.activeIds], ["telemetry", "learning"]);
          assert.isTrue(yield* telemetryFileExists);
          // The reactor made its cursor table in the plugin's own file next to the migrated ones.
          assert.deepEqual(yield* tableNames(host.databases.get("telemetry")!), [
            "effect_sql_migrations",
            "host_reactor_cursor",
            "host_reactor_failure",
            "telemetry_runs",
            "telemetry_threads",
            "telemetry_tool_calls",
            "telemetry_turn_usage",
          ]);

          const supervisor = yield* PluginSupervisor.PluginSupervisor;
          const tick = yield* supervisor.tick;
          assert.isFalse(tick.dryRun);
          assert.deepEqual(
            tick.sweeps.map((s) => [s.plugin, s.name, s.status, s.examined, s.acted, s.flags]),
            [["telemetry", "heartbeat", "ok", 0, 0, 0]],
          );
          assert.deepEqual((yield* supervisor.status).sweeps, [
            { plugin: "telemetry", name: "heartbeat" },
          ]);

          yield* seed(host.databases.get("telemetry")!);
          const fromHandler = yield* measures().pipe(Effect.flatMap(decodeMeasures));
          const byName = new Map(fromHandler.map((measure) => [measure.measure, measure]));
          assert.strictEqual(fromHandler.length, 14);
          assert.deepEqual(
            ["time_to_accepted_outcome", "repeated_reads", "material_correction_burden"].map(
              (name) => [byName.get(name)?.state, byName.get(name)?.value],
            ),
            // The learning plugin runs and has no corrections: zero is its answer.
            [
              ["ok", 86_400],
              ["ok", 0.5],
              ["ok", 0],
            ],
          );
          const invalid = yield* refusal(measures({ ...measuresInput, from: "last week" }));
          assert.strictEqual(invalid.message, "The window's from and to must be ISO instants.");

          const call = yield* mcp;
          const tools = (yield* call("tools/list", {})).tools?.map((tool) => tool.name) ?? [];
          assert.include(tools, "telemetry_measures");
          const called = yield* call("tools/call", {
            name: "telemetry_measures",
            arguments: measuresInput,
          });
          // MCP carries a list as JSON text; the server keeps `structuredContent` for objects.
          assert.deepEqual(decodeMeasuresJson(called.content?.[0]?.text ?? ""), fromHandler);
        }).pipe(Effect.provide(layerHost));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("a dry run runs the heartbeat the same way", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyPlugins(["telemetry"]));
      yield* writeStateFile("supervisor.json", '{ "dryRun": true }');
      yield* Effect.gen(function* () {
        const tick = yield* (yield* PluginSupervisor.PluginSupervisor).tick;
        assert.isTrue(tick.dryRun);
        assert.deepEqual(
          tick.sweeps.map((s) => [s.plugin, s.name, s.status]),
          [["telemetry", "heartbeat", "ok"]],
        );
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("disabled: no file, no sweep, no tool, and the RPC says it is not running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyPlugins([]));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        assert.deepEqual([...host.activeIds], []);
        assert.isFalse(yield* telemetryFileExists);
        assert.deepEqual((yield* (yield* PluginSupervisor.PluginSupervisor).status).sweeps, []);

        const error = yield* refusal(measures());
        assert.strictEqual(error._tag, "TelemetryError");
        assert.strictEqual(error.message, 'Plugin "telemetry" is not running.');

        const call = yield* mcp;
        const tools = (yield* call("tools/list", {})).tools?.map((tool) => tool.name) ?? [];
        assert.include(tools, "supervisor_status");
        assert.notInclude(tools, "telemetry_measures");
      }).pipe(Effect.provide(layerHost));
    }),
  ).pipe(Effect.provide(layerTest)),
);
