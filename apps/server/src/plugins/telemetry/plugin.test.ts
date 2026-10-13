import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PLUGIN_GATEWAY_WS_METHODS,
  ProjectId,
  TELEMETRY_METHODS,
  TELEMETRY_REPORT_METHODS,
  TelemetryBudget,
  TelemetryBudgetsResult,
  TelemetryError,
  type TelemetryMeasure,
  TelemetryMeasuresResult,
  TelemetryReportResult,
  TelemetryToolOutputResult,
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
import type * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";
import { fakeCore, project } from "./report/testkit.ts";

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
const reportInput = { ...measuresInput, from: "2026-10-01T00:00:00.000Z" };

/** `telemetry.report` through the read gateway. */
const report = (input = reportInput) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.read]({
    method: TELEMETRY_REPORT_METHODS.report.method,
    input,
  });
const decodeReport = Schema.decodeUnknownEffect(TelemetryReportResult);
const decodeReportJson = Schema.decodeUnknownSync(Schema.fromJsonString(TelemetryReportResult));

/** In-memory projects, scheduled tasks and threads, with the one project the tests report on. */
const core = fakeCore({ projects: [project(measuresInput.projectId)] });

/** Any telemetry method through the gateway its scope names. */
const viaGateway = (
  gateway: keyof typeof PLUGIN_GATEWAY_WS_METHODS,
  method: string,
  input: unknown,
) => PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS[gateway]]({ method, input });
const decodeMeasures = Schema.decodeUnknownEffect(TelemetryMeasuresResult);
const decodeBudgets = Schema.decodeUnknownEffect(TelemetryBudgetsResult);
const decodeBudgetsJson = Schema.decodeUnknownSync(Schema.fromJsonString(TelemetryBudgetsResult));
const decodeBudget = Schema.decodeUnknownEffect(TelemetryBudget);
const decodeMeasuresJson = Schema.decodeUnknownSync(Schema.fromJsonString(TelemetryMeasuresResult));
const decodeToolOutputJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(TelemetryToolOutputResult),
);
const decodeTelemetryError = Schema.decodeUnknownEffect(TelemetryError);

/** The `TelemetryError` a gateway call failed with. */
const refusal = (gatewayCall: ReturnType<typeof measures>) =>
  Effect.gen(function* () {
    const refused = yield* gatewayCall.pipe(
      Effect.andThen(Effect.die("expected a failure")),
      Effect.flip,
    );
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
 * services the plugins and the host's sink need: `fakes` for projects, tasks and
 * threads. The sink runs on an empty in-memory core database, so the reactor
 * has nothing to replay.
 */
const layerHost = (
  fakes: Layer.Layer<
    | ProjectService.ProjectService
    | ScheduledTaskService.ScheduledTaskService
    | ThreadManagementService.ThreadManagementService
  >,
) =>
  PluginHost.layerAll.pipe(
    Layer.provide(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        fakes,
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
 * window, one run in it that read the same file twice, returning 100 and 300 estimated tokens.
 */
const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO telemetry_threads
        (thread_id, project_id, created_at, settled_at, settled_by_sweep)
      VALUES ('thread:1', ${measuresInput.projectId}, '2026-10-02T00:00:00.000Z',
        '2026-10-03T00:00:00.000Z', 0)`;
    yield* sql`INSERT INTO telemetry_runs
        (run_id, thread_id, turn_id, ordinal, status, model, started_at, completed_at,
         event_sequence)
      VALUES ('run:1', 'thread:1', 'message:1', 1, 'completed', 'test-model',
        '2026-10-02T00:00:00.000Z', '2026-10-02T00:10:00.000Z', 1)`;
    yield* sql`INSERT INTO telemetry_tool_calls
        (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, output_tokens, status,
         event_sequence)
      VALUES
        ('item:1', 'run:1', 'thread:1', 1, 'dynamic_tool', 'Read', 'src/a.ts', 100, 'completed', 1),
        ('item:2', 'run:1', 'thread:1', 2, 'dynamic_tool', 'Read', 'src/a.ts', 300, 'completed', 1)`;
  });

/**
 * The review plugin's rows for the window. Four threads count: thread:b was sent back before it
 * was approved, so three of the four were approved the first time. thread:d was first reviewed
 * before the window, so its approval inside it is not a first review.
 */
const seedReview = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const give = (id: string, thread: string, outcome: string, createdAt: string) =>
      sql`INSERT INTO review_verdicts
          (id, project_id, reviewed_thread_id, reviewer_thread_id, checkpoint_id, outcome,
           failure_mode, summary, created_at)
        VALUES (${id}, ${measuresInput.projectId}, ${thread}, 'thread:reviewer',
          ${`checkpoint:${id}`}, ${outcome}, ${outcome === "approve" ? null : "defect"},
          'Reviewed.', ${createdAt})`;
    yield* give("1", "thread:a", "approve", "2026-10-02T00:00:00.000Z");
    yield* give("2", "thread:b", "changes_requested", "2026-10-03T00:00:00.000Z");
    yield* give("3", "thread:b", "approve", "2026-10-04T00:00:00.000Z");
    yield* give("4", "thread:c", "approve", "2026-10-05T00:00:00.000Z");
    yield* give("5", "thread:d", "changes_requested", "2026-09-30T00:00:00.000Z");
    yield* give("6", "thread:d", "approve", "2026-10-06T00:00:00.000Z");
    yield* give("7", "thread:e", "approve", "2026-10-07T00:00:00.000Z");
  });

/**
 * The learning plugin's rows for the window. The `defect` item was handed over on 10-04, then a
 * person closed it, and a later piece of evidence moved its own `updated_at` to 10-09, so only
 * the promotion says when, and a closed item still counts as known.
 * Of the six corrections with a declared mode in the window, two are `defect` after 10-04.
 */
const seedLearning = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const { projectId } = measuresInput;
    const item = (id: number, project: string, mode: string, state: string, updatedAt: string) =>
      sql`INSERT INTO learning_items
          (id, project_id, failure_mode, occurrences, state, owner_kind, disposition_by, reason,
           created_at, updated_at)
        VALUES (${id}, ${project}, ${mode}, 2, ${state}, 'prompt', 'rule', 'Routed by rule.',
          '2026-10-01T00:00:00.000Z', ${updatedAt})`;
    yield* item(1, projectId, "defect", "closed", "2026-10-09T00:00:00.000Z");
    yield* item(2, projectId, "incomplete", "open", "2026-10-09T00:00:00.000Z");
    // Another project's promoted item for a mode this project has not handed over.
    yield* item(3, "project:elsewhere", "convention", "promoted", "2026-10-02T00:00:00.000Z");
    yield* sql`INSERT INTO learning_promotions
        (id, item_id, project_id, failure_mode, owner_kind, state, attempts, created_at, updated_at)
      VALUES (1, 1, ${projectId}, 'defect', 'prompt', 'delivered', 0, '2026-10-02T00:00:00.000Z',
        '2026-10-04T00:00:00.000Z'),
        (2, 3, 'project:elsewhere', 'convention', 'prompt', 'delivered', 0,
        '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`;

    const give = (id: number, mode: string | null, createdAt: string) =>
      sql`INSERT INTO corrections
          (id, project_id, thread_id, failure_kind, cause_class, declared_mode, description,
           source_event_ids, created_at, updated_at)
        VALUES (${id}, ${projectId}, 'thread:a', 'review_verdict', 'unclassified', ${mode},
          'Wrong.', '[]', ${createdAt}, ${createdAt})`;
    yield* give(1, "defect", "2026-10-03T00:00:00.000Z");
    yield* give(2, "defect", "2026-10-05T00:00:00.000Z");
    // At the moment of the promotion, which is not before it.
    yield* give(3, "defect", "2026-10-04T00:00:00.000Z");
    yield* give(4, "incomplete", "2026-10-06T00:00:00.000Z");
    yield* give(5, "defect", "2026-10-08T00:00:00.000Z");
    yield* give(6, null, "2026-10-06T00:00:00.000Z");
    // At the window's end, which the window excludes and the learning plugin lists.
    yield* give(7, "defect", measuresInput.to);
    yield* give(8, "convention", "2026-10-07T00:00:00.000Z");
  });

/**
 * `telemetry.measures` through the gateway and through the MCP tool, which must agree. One MCP
 * server answers per test, so a test that asks twice builds `call` once and uses `answersWith`.
 */
const answersWith = (call: Effect.Success<typeof mcp>) =>
  Effect.gen(function* () {
    const fromGateway = yield* measures().pipe(Effect.flatMap(decodeMeasures));
    const called = yield* call("tools/call", {
      name: "telemetry_measures",
      arguments: measuresInput,
    });
    assert.deepEqual(decodeMeasuresJson(called.content?.[0]?.text ?? ""), fromGateway);
    return new Map(fromGateway.map((measure) => [measure.measure, measure]));
  });
const answers = Effect.flatMap(mcp, answersWith);

it.effect(
  "enabled: its file is migrated, the reactor and sweep run, and the tool and RPC agree",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* writeStateFile("plugins.json", onlyPlugins(["telemetry", "learning"]));
        const fakes = yield* core;
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          assert.deepEqual([...host.activeIds], ["telemetry", "learning"]);
          assert.isTrue(yield* telemetryFileExists);
          // The reactor made its cursor table in the plugin's own file next to the migrated ones.
          assert.deepEqual(yield* tableNames(host.databases.get("telemetry")!), [
            "budget_events",
            "budgets",
            "effect_sql_migrations",
            "host_reactor_cursor",
            "host_reactor_failure",
            "sqlite_sequence",
            "telemetry_runs",
            "telemetry_threads",
            "telemetry_tool_calls",
            "telemetry_turn_usage",
          ]);

          const supervisor = yield* PluginSupervisor.PluginSupervisor;
          const tick = yield* supervisor.tick;
          assert.isFalse(tick.dryRun);
          // The learning plugin registers sweeps of its own; only telemetry's are checked here.
          assert.deepEqual(
            tick.sweeps
              .filter((s) => s.plugin === "telemetry")
              .map((s) => [s.plugin, s.name, s.status, s.examined, s.acted, s.flags]),
            [
              ["telemetry", "heartbeat", "ok", 0, 0, 0],
              ["telemetry", "budgets", "ok", 0, 0, 0],
            ],
          );
          assert.deepEqual(
            (yield* supervisor.status).sweeps.filter((s) => s.plugin === "telemetry"),
            [
              { plugin: "telemetry", name: "heartbeat" },
              { plugin: "telemetry", name: "budgets" },
            ],
          );

          yield* seed(host.databases.get("telemetry")!);
          const fromHandler = yield* measures().pipe(Effect.flatMap(decodeMeasures));
          const byName = new Map(fromHandler.map((measure) => [measure.measure, measure]));
          assert.strictEqual(fromHandler.length, 16);
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

          // The tool output tool is a fold over those two measures' detail, and needs no tier.
          assert.include(tools, "telemetry_tool_output");
          const toolOutput = decodeToolOutputJson(
            (yield* call("tools/call", {
              name: "telemetry_tool_output",
              arguments: measuresInput,
            })).content?.[0]?.text ?? "",
          );
          assert.deepEqual(toolOutput, {
            byTool: [
              { tool: "Read", calls: 2, estimatedTokens: 400, share: 1, p50: 100, p95: 300 },
            ],
            largest: [
              {
                tool: "Read",
                threadId: "thread:1",
                runId: "run:1",
                itemId: "item:2",
                estimatedTokens: 300,
              },
              {
                tool: "Read",
                threadId: "thread:1",
                runId: "run:1",
                itemId: "item:1",
                estimatedTokens: 100,
              },
            ],
            missingReason: null,
          });
          // The same rows ride on the measures the RPC returns.
          assert.deepEqual(byName.get("tool_output_total")?.detail?.byTool, toolOutput.byTool);
          assert.deepEqual(
            byName.get("tool_output_max_per_call")?.detail?.largest,
            toolOutput.largest,
          );
          assert.deepEqual(
            ["tool_output_total", "tool_output_max_per_call"].map((name) => [
              byName.get(name)?.state,
              byName.get(name)?.value,
              byName.get(name)?.sampleSize,
            ]),
            [
              ["ok", 400, 2],
              ["ok", 300, 2],
            ],
          );

          // The report: the RPC and the tool answer the same, with a page to render.
          const fromGateway = yield* report().pipe(Effect.flatMap(decodeReport));
          assert.include(tools, "telemetry_report");
          const reported = yield* call("tools/call", {
            name: "telemetry_report",
            arguments: reportInput,
          });
          assert.deepEqual(decodeReportJson(reported.content?.[0]?.text ?? ""), fromGateway);
          assert.deepEqual(
            [fromGateway.report.projectTitle, fromGateway.report.efficiency.count],
            [`Project ${measuresInput.projectId}`, 16],
          );
          assert.deepEqual(
            [fromGateway.report.failures.state, fromGateway.report.findings.missingReason],
            ["ok", "The review plugin is not running."],
          );
          assert.include(fromGateway.html, "<h1>Activity report: Project project:telemetry</h1>");
          const backwards = yield* refusal(report({ ...reportInput, to: reportInput.from }));
          assert.strictEqual(backwards.message, "Report range is invalid");

          // Seeding ran once the plugin started: one task for the project, bound to its thread.
          yield* fakes.upserted;
          const [task, ...others] = yield* fakes.tasks;
          const [created] = yield* fakes.commands;
          assert.strictEqual(others.length, 0);
          assert.strictEqual(task?.id, `telemetry-weekly-report:${measuresInput.projectId}`);
          assert.isTrue(created?.type === "thread.create" && created.threadId === task?.threadId);
        }).pipe(Effect.provide(layerHost(fakes.layer)));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("review and learning on: both review measures answer ok on a fixture", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyPlugins(["telemetry", "learning", "review"]));
      const fakes = yield* core;
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* seedReview(host.databases.get("review")!);
        yield* seedLearning(host.databases.get("learning")!);
        const byName = yield* answers;
        const pick = (name: string) => {
          const measure = byName.get(name);
          return [measure?.state, measure?.value, measure?.sampleSize, measure?.missingReason];
        };
        assert.deepEqual(pick("first_review_acceptance"), ["ok", 0.75, 4, null]);
        assert.deepEqual(pick("known_error_recurrence"), ["ok", 2 / 6, 6, null]);
      }).pipe(Effect.provide(layerHost(fakes.layer)));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("review off: its measure names the review plugin, and learning's still answers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyPlugins(["telemetry", "learning"]));
      const fakes = yield* core;
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* seedLearning(host.databases.get("learning")!);
        const byName = yield* answers;
        const review = byName.get("first_review_acceptance");
        assert.deepEqual(
          [review?.state, review?.value, review?.sampleSize],
          ["unavailable", null, 0],
        );
        assert.match(review?.missingReason ?? "", /review plugin/);
        assert.strictEqual(byName.get("known_error_recurrence")?.state, "ok");
      }).pipe(Effect.provide(layerHost(fakes.layer)));
    }),
  ).pipe(Effect.provide(layerTest)),
);

/**
 * Four runs in the window that edited a file, two of which read `.knowledge/testing.md` first, one
 * of them after its edit instead; and a fifth that only read the page.
 */
const seedKnowledgeRuns = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO telemetry_threads (thread_id, project_id, created_at)
      VALUES ('thread:1', ${measuresInput.projectId}, '2026-10-02T00:00:00.000Z')`;
    for (const [index, name] of ["a", "b", "c", "d", "e"].entries()) {
      yield* sql`INSERT INTO telemetry_runs
          (run_id, thread_id, turn_id, ordinal, status, model, started_at, completed_at,
           event_sequence)
        VALUES (${`run:${name}`}, 'thread:1', ${`message:${name}`}, ${index + 1}, 'completed',
          'test-model', '2026-10-02T00:00:00.000Z', '2026-10-02T00:10:00.000Z', 1)`;
    }
    const call = (
      item: string,
      run: string,
      ordinal: number,
      type: "Read" | "Edit",
      path: string,
    ) =>
      sql`INSERT INTO telemetry_tool_calls
          (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, status, event_sequence)
        VALUES (${item}, ${`run:${run}`}, 'thread:1', ${ordinal},
          ${type === "Read" ? "dynamic_tool" : "file_change"},
          ${type === "Read" ? "Read" : null}, ${path}, 'completed', 1)`;
    yield* call("item:1", "a", 1, "Read", ".knowledge/testing.md");
    yield* call("item:2", "a", 2, "Edit", "src/a.ts");
    yield* call("item:3", "b", 3, "Read", "/work/project/.knowledge/testing.md");
    yield* call("item:4", "b", 4, "Edit", "src/a.ts");
    yield* call("item:5", "c", 5, "Read", "src/b.ts");
    yield* call("item:6", "c", 6, "Edit", "src/a.ts");
    yield* call("item:7", "d", 7, "Edit", "src/a.ts");
    yield* call("item:8", "d", 8, "Read", ".knowledge/testing.md");
    yield* call("item:9", "e", 9, "Read", ".knowledge/testing.md");
  });

const givePage = (sql: SqlClient.SqlClient, state: string) =>
  sql`INSERT INTO knowledge_entry
      (project_id, "key", title, body, state, source, created_at, accepted_at, retired_at)
    VALUES (${measuresInput.projectId}, 'testing', 'Testing', 'Run vp test.', ${state},
      '{"kind":"person"}', '2026-10-01T00:00:00.000Z', NULL, NULL)`;

it.effect(
  "knowledge on: knowledge_reuse answers from the page reads before an edit, and the tool agrees",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* writeStateFile("plugins.json", onlyPlugins(["telemetry", "knowledge"]));
        const fakes = yield* core;
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          assert.deepEqual([...host.activeIds], ["telemetry", "knowledge"]);
          const answered = answersWith(yield* mcp);
          const pick = (byName: ReadonlyMap<string, TelemetryMeasure>) => {
            const measure = byName.get("knowledge_reuse");
            return [measure?.state, measure?.value, measure?.sampleSize, measure?.missingReason];
          };

          const telemetryDb = host.databases.get("telemetry")!;
          const knowledgeDb = host.databases.get("knowledge")!;

          // A draft is not a page the index lists.
          yield* givePage(knowledgeDb, "draft");
          assert.deepEqual(pick(yield* answered), [
            "unavailable",
            null,
            0,
            "The project has no knowledge page yet.",
          ]);

          yield* knowledgeDb`UPDATE knowledge_entry SET state = 'accepted'`;
          assert.deepEqual(pick(yield* answered), [
            "unavailable",
            null,
            0,
            "No run in the window edited a file.",
          ]);

          yield* seedKnowledgeRuns(telemetryDb);
          assert.deepEqual(pick(yield* answered), ["ok", 0.5, 4, null]);
        }).pipe(Effect.provide(layerHost(fakes.layer)));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("knowledge off: its measure names the knowledge plugin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyPlugins(["telemetry"]));
      const fakes = yield* core;
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* seedKnowledgeRuns(host.databases.get("telemetry")!);
        const reuse = (yield* answers).get("knowledge_reuse");
        assert.deepEqual([reuse?.state, reuse?.value, reuse?.sampleSize], ["unavailable", null, 0]);
        assert.match(reuse?.missingReason ?? "", /knowledge plugin/);
      }).pipe(Effect.provide(layerHost(fakes.layer)));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("learning off: its measure names the learning plugin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyPlugins(["telemetry"]));
      const fakes = yield* core;
      yield* Effect.gen(function* () {
        const byName = yield* answers;
        const learning = byName.get("known_error_recurrence");
        assert.deepEqual(
          [learning?.state, learning?.value, learning?.sampleSize],
          ["unavailable", null, 0],
        );
        assert.match(learning?.missingReason ?? "", /learning plugin/);

        const { report: folded } = yield* report().pipe(Effect.flatMap(decodeReport));
        assert.deepEqual(
          [folded.failures.state, folded.failures.missingReason],
          ["unavailable", "The learning plugin is not running."],
        );
      }).pipe(Effect.provide(layerHost(fakes.layer)));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("budgets: the RPC and the tool agree, a save is checked, and a removal sticks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyPlugins(["telemetry"]));
      const fakes = yield* core;
      yield* Effect.gen(function* () {
        const listed = yield* viaGateway("read", TELEMETRY_METHODS.budgets.method, {}).pipe(
          Effect.flatMap(decodeBudgets),
        );
        assert.deepEqual(
          listed.map((budget) => [budget.tier, budget.threshold, budget.state]),
          [
            ["cheap", 800, "ok"],
            ["standard", 1500, "ok"],
            ["strong", 3000, "ok"],
            // The measure reads no tier, so this one row on `standard` judges every run.
            ["standard", 8000, "ok"],
          ],
        );
        assert.deepEqual(
          listed.map((budget) => budget.measure),
          [
            "context_efficiency",
            "context_efficiency",
            "context_efficiency",
            "tool_output_max_per_call",
          ],
        );
        const tool = yield* mcp;
        const tools = (yield* tool("tools/list", {})).tools?.map((t) => t.name) ?? [];
        assert.include(tools, "telemetry_budgets");
        const called = yield* tool("tools/call", { name: "telemetry_budgets", arguments: {} });
        assert.deepEqual(decodeBudgetsJson(called.content?.[0]?.text ?? ""), listed);

        // A patch names only the field it changes.
        const saved = yield* viaGateway("settingsWrite", TELEMETRY_METHODS.budgetsSet.method, {
          id: listed[1]!.id,
          threshold: 1800,
        }).pipe(Effect.flatMap(decodeBudget));
        assert.deepEqual(
          [saved.tier, saved.threshold, saved.minSample, saved.enabled],
          ["standard", 1800, 20, true],
        );
        // A new budget has every field and no id.
        const added = yield* viaGateway("settingsWrite", TELEMETRY_METHODS.budgetsSet.method, {
          measure: "context_efficiency",
          tier: "cheap",
          threshold: 600,
          direction: "lower_is_better",
          projectId: measuresInput.projectId,
          minSample: 10,
          enabled: true,
        }).pipe(Effect.flatMap(decodeBudget));
        assert.deepEqual([added.id, added.projectId], [5, measuresInput.projectId]);

        const invalid = yield* refusal(
          viaGateway("settingsWrite", TELEMETRY_METHODS.budgetsSet.method, {
            id: saved.id,
            tier: "premium",
          }),
        );
        assert.strictEqual(invalid.message, "Budget is invalid: tier");
        const infinite = yield* refusal(
          viaGateway("settingsWrite", TELEMETRY_METHODS.budgetsSet.method, {
            id: saved.id,
            threshold: Number.POSITIVE_INFINITY,
          }),
        );
        assert.strictEqual(infinite.message, "Budget is invalid: threshold");

        yield* viaGateway("settingsWrite", TELEMETRY_METHODS.budgetsRemove.method, {
          id: added.id,
        });
        yield* viaGateway("settingsWrite", TELEMETRY_METHODS.budgetsRemove.method, {
          id: saved.id,
        });
        const after = yield* viaGateway("read", TELEMETRY_METHODS.budgets.method, {}).pipe(
          Effect.flatMap(decodeBudgets),
        );
        // The one patched and the one added are gone; the rest keep their order.
        assert.deepEqual(
          after.map((budget) => [budget.measure, budget.tier]),
          [
            ["context_efficiency", "cheap"],
            ["context_efficiency", "strong"],
            ["tool_output_max_per_call", "standard"],
          ],
        );
        assert.deepEqual(
          yield* viaGateway("read", TELEMETRY_METHODS.budgetEvents.method, {
            projectId: measuresInput.projectId,
            from: measuresInput.from,
            to: measuresInput.to,
          }),
          [],
        );
      }).pipe(Effect.provide(layerHost(fakes.layer)));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("a dry run runs the heartbeat the same way", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* writeStateFile("plugins.json", onlyPlugins(["telemetry"]));
      const fakes = yield* core;
      yield* writeStateFile("supervisor.json", '{ "dryRun": true }');
      yield* Effect.gen(function* () {
        const tick = yield* (yield* PluginSupervisor.PluginSupervisor).tick;
        assert.isTrue(tick.dryRun);
        assert.deepEqual(
          tick.sweeps.map((s) => [s.plugin, s.name, s.status]),
          [
            ["telemetry", "heartbeat", "ok"],
            ["telemetry", "budgets", "ok"],
          ],
        );
      }).pipe(Effect.provide(layerHost(fakes.layer)));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "disabled: no file, no sweep, no tools, no seeding, and the RPCs say it is not running",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* writeStateFile("plugins.json", onlyPlugins([]));
        const fakes = yield* core;
        yield* Effect.gen(function* () {
          const host = yield* PluginHost.PluginHost;
          assert.deepEqual([...host.activeIds], []);
          assert.isFalse(yield* telemetryFileExists);
          assert.deepEqual((yield* (yield* PluginSupervisor.PluginSupervisor).status).sweeps, []);

          const error = yield* refusal(measures());
          assert.strictEqual(error._tag, "TelemetryError");
          assert.strictEqual(error.message, 'Plugin "telemetry" is not running.');
          for (const [gateway, method, input] of [
            ["read", TELEMETRY_METHODS.budgets.method, {}],
            ["settingsWrite", TELEMETRY_METHODS.budgetsRemove.method, { id: 1 }],
            [
              "read",
              TELEMETRY_METHODS.budgetEvents.method,
              {
                projectId: measuresInput.projectId,
                from: measuresInput.from,
                to: measuresInput.to,
              },
            ],
            ["read", TELEMETRY_REPORT_METHODS.report.method, reportInput],
          ] as const) {
            const off = yield* refusal(viaGateway(gateway, method, input));
            assert.strictEqual(off.message, 'Plugin "telemetry" is not running.');
          }

          const call = yield* mcp;
          const tools = (yield* call("tools/list", {})).tools?.map((tool) => tool.name) ?? [];
          assert.include(tools, "supervisor_status");
          assert.notInclude(tools, "telemetry_measures");
          assert.notInclude(tools, "telemetry_budgets");
          assert.notInclude(tools, "telemetry_tool_output");
          assert.notInclude(tools, "telemetry_report");

          // Nothing seeds: no task, no thread.
          assert.deepEqual(yield* fakes.tasks, []);
          assert.deepEqual(yield* fakes.commands, []);
        }).pipe(Effect.provide(layerHost(fakes.layer)));
      }),
    ).pipe(Effect.provide(layerTest)),
);
