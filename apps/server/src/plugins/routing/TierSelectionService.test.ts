import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2RunStatus,
  type OrchestratorMcpTarget,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RoutingRecommendedDetail,
  type RoutingTaskClass,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { migrations } from "./migrations.ts";
import * as TierMapService from "./TierMapService.ts";
import * as TierSelectionService from "./TierSelectionService.ts";

const alpha = ProviderInstanceId.make("alpha");
const beta = ProviderInstanceId.make("beta");
const provider = (
  instanceId: ProviderInstanceId,
  slugs: ReadonlyArray<string>,
): ServerProvider => ({
  driver: ProviderDriverKind.make("codex"),
  instanceId,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-10-01T00:00:00.000Z",
  auth: { status: "authenticated" },
  models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  skills: [],
  slashCommands: [],
});
// Built-in tiers from alpha: strong a-1, standard a-2, cheap a-3.
const providers = [provider(alpha, ["a-1", "a-2", "a-3"]), provider(beta, ["b-1", "b-2"])];

const projectId = ProjectId.make("project-1");
const work = (
  taskClass: RoutingTaskClass,
  earlierThreadIds: ReadonlyArray<ThreadId> = [],
): TierSelectionService.Work => ({ projectId, taskClass, earlierThreadIds });

const decodeDetail = Schema.decodeSync(Schema.fromJsonString(RoutingRecommendedDetail));

/** One boot of the plugin's services on an empty in-memory database, with scripted threads. */
const start = Effect.gen(function* () {
  const catalog = yield* Ref.make(providers);
  // Each known thread's run statuses; any other thread cannot be read.
  const runs = new Map<ThreadId, ReadonlyArray<OrchestrationV2RunStatus>>();
  const services = yield* Layer.build(
    TierSelectionService.layer.pipe(
      Layer.provideMerge(TierMapService.layer),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Ref.get(catalog) }),
      ),
      Layer.provideMerge(ServerSettings.layerTest({})),
      Layer.provideMerge(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({
                    id,
                    title: id,
                    workspaceRoot: "/unused",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-10-01T00:00:00.000Z",
                    updatedAt: "2026-10-01T00:00:00.000Z",
                    deletedAt: null,
                  })
                : Option.none(),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => {
            const statuses = runs.get(threadId);
            return statuses === undefined
              ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }))
              : // Only `runs[].status` is read.
                Effect.succeed({ runs: statuses.map((status) => ({ status })) } as never);
          },
        }),
      ),
      Layer.provideMerge(
        Layer.effect(
          SqlClient.SqlClient,
          Effect.map(
            PluginDatabase.open({ id: "routing", filename: ":memory:", migrations }),
            (opened) => opened.sql,
          ),
        ),
      ),
    ),
  );
  const sql = Context.get(services, SqlClient.SqlClient);

  /** A scripted `t3_thread_launch`: notes the model it was handed and returns a new thread. */
  const handed: Array<ModelSelection | OrchestratorMcpTarget | undefined> = [];
  let launched = 0;
  const nextThread = (statuses: ReadonlyArray<OrchestrationV2RunStatus>) => {
    const threadId = ThreadId.make(`thread-${++launched}`);
    runs.set(threadId, statuses);
    return threadId;
  };
  const launch = (
    input: TierSelectionService.Work,
    statuses: ReadonlyArray<OrchestrationV2RunStatus> = ["completed"],
  ) =>
    TierSelectionService.launch(input, (modelSelection) =>
      Effect.sync(() => {
        handed.push(modelSelection);
        return { threadId: nextThread(statuses) };
      }),
    ).pipe(Effect.provideContext(services));
  const delegate = (input: TierSelectionService.Work) =>
    TierSelectionService.delegate(input, (target) =>
      Effect.sync(() => {
        handed.push(target);
        return { childThreadId: nextThread(["completed"]) };
      }),
    ).pipe(Effect.provideContext(services));

  const rows = Effect.map(
    sql<{
      readonly at: string;
      readonly kind: string;
      readonly project_id: string;
      readonly thread_id: string;
      readonly tier: string | null;
      readonly provider_instance_id: string | null;
      readonly model: string | null;
      readonly detail: string;
    }>`SELECT at, kind, project_id, thread_id, tier, provider_instance_id, model, detail
       FROM routing_events ORDER BY id`,
    (found) => found.map(({ detail, ...row }) => ({ ...row, detail: decodeDetail(detail) })),
  );

  return {
    catalog,
    tiers: Context.get(services, TierMapService.TierMapService),
    sql,
    handed,
    launch,
    delegate,
    rows,
  };
});

describe("TierSelectionService", () => {
  it.effect("a launch carries the project's mapped model and appends one row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tiers, handed, launch, rows } = yield* start;
        yield* tiers.set({
          scope: projectId,
          tier: "cheap",
          entry: { providerInstanceId: beta, model: "b-2" },
        });

        const result = yield* launch(work("mechanical"));

        assert.deepEqual(handed, [{ instanceId: beta, model: "b-2" }]);
        const found = yield* rows;
        assert.lengthOf(found, 1);
        const { at, ...row } = found[0]!;
        assert.match(at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
        assert.deepEqual(row, {
          kind: "routing_recommended",
          project_id: projectId,
          thread_id: result.threadId,
          tier: "cheap",
          provider_instance_id: beta,
          model: "b-2",
          detail: { taskClass: "mechanical", failedRuns: 0, reason: "rule" },
        });
      }),
    ),
  );

  it.effect(
    "each failed run moves the retry one tier up; cancelled and interrupted runs do not",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handed, launch, rows } = yield* start;
          const first = yield* launch(work("mechanical"), ["cancelled", "interrupted"]);
          const second = yield* launch(work("mechanical", [first.threadId]), ["failed"]);
          const third = yield* launch(work("mechanical", [first.threadId, second.threadId]), [
            "completed",
            "failed",
          ]);
          const fourth = yield* launch(
            work("mechanical", [first.threadId, second.threadId, third.threadId]),
            ["failed"],
          );
          yield* launch(
            work("mechanical", [first.threadId, second.threadId, third.threadId, fourth.threadId]),
          );

          assert.deepEqual(handed, [
            { instanceId: alpha, model: "a-3" },
            { instanceId: alpha, model: "a-3" },
            { instanceId: alpha, model: "a-2" },
            { instanceId: alpha, model: "a-1" },
            { instanceId: alpha, model: "a-1" },
          ]);
          assert.deepEqual(
            (yield* rows).map((row) => [row.tier, row.detail]),
            [
              ["cheap", { taskClass: "mechanical", failedRuns: 0, reason: "rule" }],
              ["cheap", { taskClass: "mechanical", failedRuns: 0, reason: "rule" }],
              ["standard", { taskClass: "mechanical", failedRuns: 1, reason: "escalation" }],
              ["strong", { taskClass: "mechanical", failedRuns: 2, reason: "escalation" }],
              ["strong", { taskClass: "mechanical", failedRuns: 3, reason: "escalation" }],
            ],
          );
        }),
      ),
  );

  it.effect("a manual tier is launched as set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handed, launch, rows } = yield* start;
        const failed = yield* launch(work("mechanical"), ["failed"]);
        yield* launch({ ...work("planning", [failed.threadId]), manualTier: "cheap" });

        assert.deepEqual(handed[1], { instanceId: alpha, model: "a-3" });
        assert.deepEqual((yield* rows)[1]?.detail, {
          taskClass: "planning",
          failedRuns: 1,
          reason: "manual",
        });
      }),
    ),
  );

  it.effect("a delegation passes the mapped target and records the child thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handed, delegate, rows } = yield* start;
        const result = yield* delegate(work("risky_review"));

        assert.deepEqual(handed, [{ providerInstanceId: alpha, model: "a-1" }]);
        assert.deepEqual(
          (yield* rows).map((row) => [row.thread_id, row.tier, row.model]),
          [[result.childThreadId, "strong", "a-1"]],
        );
      }),
    ),
  );

  it.effect("an unavailable or missing entry passes no model and records a null one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { catalog, tiers, handed, launch, rows } = yield* start;
        yield* tiers.set({
          scope: "environment",
          tier: "standard",
          entry: { providerInstanceId: beta, model: "b-1" },
        });
        yield* Ref.set(catalog, [provider(alpha, ["a-1"]), provider(beta, ["b-2"])]);
        assert.isFalse((yield* tiers.get({ projectId })).standard.available);
        yield* launch(work("implementation"));

        yield* Ref.set(catalog, []);
        yield* launch(work("mechanical"));

        assert.deepEqual(handed, [undefined, undefined]);
        assert.deepEqual(
          (yield* rows).map((row) => [row.tier, row.provider_instance_id, row.model]),
          [
            ["standard", null, null],
            ["cheap", null, null],
          ],
        );
      }),
    ),
  );

  it.effect("with routing off the service is absent and the launch is unchanged", () =>
    Effect.gen(function* () {
      const handed: Array<ModelSelection | OrchestratorMcpTarget | undefined> = [];
      const threadId = ThreadId.make("unrouted");
      const launched = yield* TierSelectionService.launch(work("planning"), (modelSelection) =>
        Effect.sync(() => {
          handed.push(modelSelection);
          return { threadId };
        }),
      );
      const delegated = yield* TierSelectionService.delegate(work("planning"), (target) =>
        Effect.sync(() => {
          handed.push(target);
          return { childThreadId: threadId };
        }),
      );

      assert.deepEqual(handed, [undefined, undefined]);
      assert.strictEqual(launched.threadId, threadId);
      assert.strictEqual(delegated.childThreadId, threadId);
    }),
  );

  it.effect("a launch stands when its row cannot be appended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, handed, launch } = yield* start;
        yield* sql`DROP TABLE routing_events`;

        const result = yield* launch(work("implementation"));

        assert.strictEqual(result.threadId, ThreadId.make("thread-1"));
        assert.deepEqual(handed, [{ instanceId: alpha, model: "a-2" }]);
      }),
    ),
  );

  it.effect("an earlier thread that cannot be read stops the launch before it starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handed, launch, rows } = yield* start;
        const error = yield* Effect.flip(
          launch(work("mechanical", [ThreadId.make("never-launched")])),
        );

        assert.strictEqual(error.code, "io");
        assert.strictEqual(error.message, 'Could not read the runs of thread "never-launched".');
        assert.deepEqual(handed, []);
        assert.lengthOf(yield* rows, 0);
      }),
    ),
  );
});
