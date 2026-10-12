import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type SupervisorStatus } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as PluginDatabase from "./PluginDatabase.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

class SweepFailure extends Data.TaggedError("SweepFailure")<{ readonly message: string }> {}

const counts = { examined: 1, acted: 0, flags: 0 };

const layerConfig = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-supervisor-test-" }),
);

/** The supervisor for a registry of plugins `a` then `b`, over a fresh state directory. */
const layerSupervisor = PluginSupervisor.layer(["a", "b"]).pipe(Layer.provideMerge(layerConfig));

it.layer(NodeServices.layer)("plugin supervisor", (it) => {
  it.effect("runs sweeps in registry order and records ok, failed and timed_out", () =>
    Effect.gen(function* () {
      const supervisor = yield* PluginSupervisor.PluginSupervisor;
      const hung = yield* Deferred.make<void>();
      yield* supervisor.register({
        plugin: "b",
        name: "count",
        run: () => Effect.succeed({ examined: 3, acted: 1, flags: 2 }),
      });
      yield* supervisor.register({
        plugin: "a",
        name: "hang",
        run: () => Deferred.succeed(hung, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* supervisor.register({
        plugin: "a",
        name: "throw",
        run: () => Effect.fail(new SweepFailure({ message: "boom" })),
      });

      const tick = yield* Effect.forkChild(supervisor.tick);
      yield* Deferred.await(hung);
      yield* TestClock.adjust("30 seconds");
      const summary = yield* Fiber.join(tick);

      assert.isFalse(summary.dryRun);
      assert.deepEqual(
        summary.sweeps.map((s) => [
          s.plugin,
          s.name,
          s.status,
          s.examined,
          s.acted,
          s.flags,
          s.error,
        ]),
        [
          ["a", "hang", "timed_out", 0, 0, 0, null],
          ["a", "throw", "failed", 0, 0, 0, "boom"],
          ["b", "count", "ok", 3, 1, 2, null],
        ],
      );
      assert.strictEqual(summary.sweeps[0]?.durationMs, 30_000);

      const status = yield* supervisor.status;
      assert.deepEqual(status.latest, summary);
      assert.deepEqual(status.sweeps, [
        { plugin: "a", name: "hang" },
        { plugin: "a", name: "throw" },
        { plugin: "b", name: "count" },
      ]);
    }).pipe(Effect.provide(layerSupervisor)),
  );

  it.effect("records a sweep whose counts are not whole numbers as failed", () =>
    Effect.gen(function* () {
      const supervisor = yield* PluginSupervisor.PluginSupervisor;
      yield* supervisor.register({
        plugin: "a",
        name: "half",
        run: () => Effect.succeed({ examined: 1.5, acted: 0, flags: 0 }),
      });
      const summary = yield* supervisor.tick;
      assert.deepEqual(
        summary.sweeps.map((s) => [s.status, s.examined, s.error]),
        [["failed", 0, "Sweep returned a count that is not a whole number."]],
      );
    }).pipe(Effect.provide(layerSupervisor)),
  );

  it.effect("ticks one interval after activation", () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        yield* supervisor.register({
          plugin: "a",
          name: "ping",
          run: () => Deferred.succeed(ran, undefined).pipe(Effect.as(counts)),
        });
        yield* Deferred.succeed(activation, undefined);
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(ran);
        const { latest } = yield* supervisor.status;
        assert.deepEqual(latest?.sweeps, [
          { plugin: "a", name: "ping", status: "ok", ...counts, durationMs: 0, error: null },
        ]);
      }).pipe(
        Effect.provide(layerSupervisor),
        Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
      );
    }),
  );

  it.effect("a dry run hands every sweep dryRun and writes only the summary", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(stateDir, "supervisor.json"), '{ "dryRun": true }');
      const { sql } = yield* PluginDatabase.open({
        id: "fixture",
        filename: ":memory:",
        migrations: [],
      });
      yield* sql`CREATE TABLE acted (v TEXT)`;

      yield* Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        yield* supervisor.register({
          plugin: "a",
          name: "act",
          run: ({ dryRun }) =>
            (dryRun ? Effect.void : sql`INSERT INTO acted (v) VALUES ('acted')`).pipe(
              Effect.as({ examined: 1, acted: dryRun ? 0 : 1, flags: 0 }),
            ),
        });
        const summary = yield* supervisor.tick;
        assert.isTrue(summary.dryRun);
        assert.deepEqual(
          summary.sweeps.map((s) => [s.status, s.acted]),
          [["ok", 0]],
        );
        assert.deepEqual(yield* sql`SELECT v FROM acted`, []);
        const status = yield* supervisor.status;
        assert.isTrue(status.dryRun);
        assert.deepEqual(status.latest, summary);
      }).pipe(Effect.provide(PluginSupervisor.layer(["a"])));
    }).pipe(Effect.provide(layerConfig)),
  );

  it.effect("refuses a second sweep with the same plugin and name", () =>
    Effect.gen(function* () {
      const supervisor = yield* PluginSupervisor.PluginSupervisor;
      const sweep = { plugin: "a", name: "dup", run: () => Effect.succeed(counts) };
      yield* supervisor.register(sweep);
      const refused = yield* Effect.flip(supervisor.register(sweep));
      assert.strictEqual(refused.message, 'Sweep "a/dup" is already registered.');
    }).pipe(Effect.provide(layerSupervisor)),
  );

  it.effect("falls back to defaults on a bad supervisor.json and clamps a short interval", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filePath = path.join(stateDir, "supervisor.json");
      const settings = Effect.map(PluginSupervisor.PluginSupervisor, (s) => s.status).pipe(
        Effect.flatten,
        Effect.map(({ intervalSeconds, dryRun }) => ({ intervalSeconds, dryRun })),
        Effect.provide(PluginSupervisor.layer([])),
      );

      yield* fs.writeFileString(filePath, "not json");
      assert.deepEqual(yield* settings, { intervalSeconds: 60, dryRun: false });
      yield* fs.writeFileString(filePath, '{ "intervalSeconds": 1, "dryRun": true }');
      assert.deepEqual(yield* settings, { intervalSeconds: 5, dryRun: true });
    }).pipe(Effect.provide(layerConfig)),
  );
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
 * `PluginHost.layerMcp(toolkitRegistration)`, and answers with what the
 * WebSocket handler answers.
 */
it.effect("the supervisor_status tool and the supervisor.status handler agree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const supervisor = yield* PluginSupervisor.PluginSupervisor;
      yield* supervisor.register({ plugin: "a", name: "ping", run: () => Effect.succeed(counts) });
      yield* supervisor.tick;
      const fromHandler: SupervisorStatus = yield* PluginHost.handlers["supervisor.status"]();
      assert.strictEqual(fromHandler.latest?.sweeps.length, 1);

      const layerServer = PluginHost.layerMcp(McpHttpServer.toolkitRegistration).pipe(
        Layer.provide(
          Layer.mock(PluginHost.PluginHost)({ activeIds: new Set<string>(), databases: new Map() }),
        ),
        Layer.provide(Layer.succeed(PluginSupervisor.PluginSupervisor, supervisor)),
        // Inactive here, but the kanban tools' static requirements still type through `layerMcp`.
        Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        // The routing plugin's tools are inactive too; their requirements type through the same way.
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
      const called = yield* httpClient
        .post("/mcp", {
          headers: {
            ...headers,
            "mcp-session-id": initialize.headers["mcp-session-id"]!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "supervisor_status", arguments: {} },
            }),
            "application/json",
          ),
        })
        .pipe(Effect.flatMap((response) => response.text));
      assert.deepEqual(structuredResult(called), fromHandler);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        layerSupervisor.pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
      ),
    ),
  ),
);
