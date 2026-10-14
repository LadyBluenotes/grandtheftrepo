import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KnowledgeEntry,
  KNOWLEDGE_METHODS,
  LEARNING_METHODS,
  LearningItem,
  PLUGIN_GATEWAY_WS_METHODS,
  ProjectId,
  Prompt,
  PROMPT_METHODS,
  ThreadId,
  type Project,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginHost from "../PluginHost.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { registry } from "../registry.ts";
import * as CorrectionStore from "./CorrectionStore.ts";

const projectId = ProjectId.make("project:promoters");

const project: Project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/nonexistent/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
};

const layerProjects = Layer.mock(ProjectService.ProjectService)({
  getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
});

/** The real host and supervisor, with a project the knowledge plugin can find. */
const layerHost = PluginHost.layerAll.pipe(
  Layer.provide(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      layerProjects,
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      ServerSettings.layerTest(),
    ),
  ),
);

/**
 * Runs `body` with only `plugins` on, over a fresh state directory and an empty home, so the policy
 * plugin's delivery sweep finds no agent to write for.
 */
const withPlugins = <A, E, R>(plugins: ReadonlyArray<string>, body: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const off = registry.filter((plugin) => !plugins.includes(plugin.id));
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "plugins.json"),
        `{ ${off.map((plugin) => `"${plugin.id}": false`).join(", ")} }`,
      );
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-promoters-home-" });
      // The server's own tick has the host's services; a test's has only what is provided here.
      return yield* body.pipe(
        Effect.provide(Layer.merge(layerHost, layerProjects)),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-promoters-" })).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  );

const readCall = (method: string, input: unknown) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.read]({ method, input });
const operateCall = (method: string, input: unknown) =>
  PluginHost.handlers[PLUGIN_GATEWAY_WS_METHODS.operate]({ method, input });

const decodeItems = Schema.decodeUnknownEffect(Schema.Array(LearningItem));
const decodePages = Schema.decodeUnknownEffect(Schema.Array(KnowledgeEntry));
const decodePrompts = Schema.decodeUnknownEffect(Schema.Array(Prompt));

/** The running host: a tick, the learning database, and the reads a test makes. */
const running = Effect.gen(function* () {
  const host = yield* PluginHost.PluginHost;
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  const learning = host.databases.get("learning")!;
  let sourceKey = 0;
  return {
    host,
    learning,
    correction: (declaredMode: "convention" | "scope_drift", description: string) =>
      CorrectionStore.insert({
        projectId,
        threadId: ThreadId.make("thread:promoters"),
        failureKind: "review_verdict",
        declaredMode,
        description,
        sourceEventIds: [],
        sourceKey: `verdict:${++sourceKey}`,
      }).pipe(Effect.provideService(SqlClient.SqlClient, learning)),
    /** One supervisor tick; answers the learning promote sweep's summary. */
    tick: Effect.map(supervisor.tick, (tick) =>
      tick.sweeps.find((sweep) => sweep.plugin === "learning" && sweep.name === "promote"),
    ),
    items: readCall(LEARNING_METHODS.items.method, { projectId }).pipe(
      Effect.flatMap(decodeItems),
      // Newest first, which ties at the test clock's one instant; the tests compare by mode.
      Effect.map((items) =>
        items
          .map((item) => [item.failureMode, item.ownerKind, item.state] as const)
          .toSorted(([a], [b]) => a.localeCompare(b)),
      ),
    ),
    promotions: learning<{
      readonly owner_kind: string;
      readonly state: string;
      readonly attempts: number;
      readonly next_attempt_at: string | null;
      readonly last_error: string | null;
    }>`SELECT owner_kind, state, attempts, next_attempt_at, last_error
      FROM learning_promotions ORDER BY id`,
    pages: readCall(KNOWLEDGE_METHODS.list.method, { projectId }).pipe(Effect.flatMap(decodePages)),
    /** The policy database's versions; none while the policy plugin is off. */
    policyVersions: Effect.suspend(() => {
      const policy = host.databases.get("policy");
      return policy === undefined
        ? Effect.succeed([])
        : policy<{
            readonly key: string;
            readonly version: number;
            readonly state: string;
            readonly title: string;
          }>`SELECT "key", version, state, title FROM policy_versions
            WHERE "key" LIKE '%learned-%' ORDER BY id`;
    }),
  };
});

it.effect(
  "knowledge on: a convention item becomes one draft page; policy off, scope drift waits",
  () =>
    withPlugins(
      ["learning", "knowledge"],
      Effect.gen(function* () {
        const world = yield* running;
        yield* world.correction("convention", "Used tabs.");
        yield* world.correction("convention", "Used a default export.");
        yield* world.correction("convention", "Named a file in camelCase.");
        yield* world.correction("scope_drift", "Touched files outside the issue.");

        // Each candidate gets its record, then its promoter is asked; policy's is not there.
        assert.deepInclude(yield* world.tick, { status: "ok", examined: 3, acted: 3, flags: 0 });
        const [page, ...rest] = yield* world.pages;
        assert.deepStrictEqual(rest, []);
        assert.deepInclude(page, {
          projectId,
          key: "learned-convention-1",
          title: "Learned: convention",
          state: "draft",
          source: { kind: "item", itemId: 1, promotionId: 1 },
          body: [
            "Rule: convention goes to project_knowledge.",
            "",
            "- Used tabs.",
            "- Used a default export.",
            "- Named a file in camelCase.",
          ].join("\n"),
        });
        assert.deepStrictEqual(yield* world.items, [
          ["convention", "project_knowledge", "promoted"],
          ["scope_drift", "policy", "candidate"],
        ]);
        assert.deepStrictEqual(
          (yield* world.promotions).map((p) => [p.owner_kind, p.state, p.attempts, p.last_error]),
          [
            ["project_knowledge", "delivered", 0, null],
            ["policy", "pending", 0, null],
          ],
        );

        // Nothing is due, so a second tick offers nothing and writes nothing.
        assert.deepInclude(yield* world.tick, { status: "ok", examined: 0, acted: 0, flags: 0 });
        assert.strictEqual((yield* world.pages).length, 1);
      }),
    ),
);

it.effect(
  "policy on: scope drift becomes a policy draft, and a person's prompt a proposed prompt",
  () =>
    withPlugins(
      ["learning", "policy"],
      Effect.gen(function* () {
        const world = yield* running;
        yield* world.correction("scope_drift", "Touched files outside the issue.");
        yield* world.correction("convention", "Used tabs.");

        // Knowledge is off: the convention item waits, and its record counts no attempt.
        assert.deepInclude(yield* world.tick, { status: "ok", examined: 3, acted: 3, flags: 0 });
        assert.deepStrictEqual(yield* world.policyVersions, [
          { key: "learned-scope-drift", version: 1, state: "draft", title: "Learned: scope drift" },
        ]);
        assert.deepStrictEqual(yield* world.items, [
          ["convention", "project_knowledge", "candidate"],
          ["scope_drift", "policy", "promoted"],
        ]);
        assert.deepStrictEqual(
          (yield* world.promotions).map((p) => [p.owner_kind, p.state, p.attempts]),
          [
            ["policy", "delivered", 0],
            ["project_knowledge", "pending", 0],
          ],
        );

        // A person hands the convention to the prompt instead.
        const convention = (yield* readCall(LEARNING_METHODS.items.method, { projectId }).pipe(
          Effect.flatMap(decodeItems),
        )).find((item) => item.failureMode === "convention");
        yield* operateCall(LEARNING_METHODS.itemsSetDisposition.method, {
          id: convention!.id,
          ownerKind: "prompt",
        });
        assert.deepInclude(yield* world.tick, { status: "ok", examined: 2, acted: 2, flags: 0 });
        // The prompt library is learning's own: no policy draft, a proposed prompt instead.
        assert.deepStrictEqual(
          (yield* world.policyVersions).map((v) => [v.key, v.version, v.state]),
          [["learned-scope-drift", 1, "draft"]],
        );
        const prompts = yield* readCall(PROMPT_METHODS.list.method, { projectId }).pipe(
          Effect.flatMap(decodePrompts),
        );
        assert.deepStrictEqual(
          prompts.map((p) => [p.kind, p.state, p.origin, p.title, p.body, p.version]),
          [
            [
              "prompt",
              "proposed",
              "learning",
              "Learned: convention",
              "Set by a person.\n\n- Used tabs.",
              1,
            ],
          ],
        );
        assert.deepStrictEqual(yield* world.items, [
          ["convention", "prompt", "promoted"],
          ["scope_drift", "policy", "promoted"],
        ]);
      }),
    ),
);

it.effect("a promoter that fails leaves its record pending, and the next attempt delivers", () =>
  withPlugins(
    ["learning", "knowledge"],
    Effect.gen(function* () {
      const world = yield* running;
      const knowledge = world.host.databases.get("knowledge")!;
      yield* world.correction("convention", "Used tabs.");

      yield* knowledge`ALTER TABLE knowledge_entry RENAME TO knowledge_entry_away`;
      assert.deepInclude(yield* world.tick, { status: "ok", examined: 2, acted: 2, flags: 0 });
      assert.deepStrictEqual(yield* world.promotions, [
        {
          owner_kind: "project_knowledge",
          state: "pending",
          attempts: 1,
          next_attempt_at: "1970-01-01T06:00:00.000Z",
          last_error: "Could not save the page.",
        },
      ]);
      assert.deepStrictEqual(yield* world.items, [
        ["convention", "project_knowledge", "candidate"],
      ]);

      yield* knowledge`ALTER TABLE knowledge_entry_away RENAME TO knowledge_entry`;
      // Moving the clock lets the host's own supervisor loop tick as well, so the retry may be
      // made by it or by this tick; either way it is made once.
      yield* TestClock.adjust("6 hours");
      yield* world.tick;
      assert.deepStrictEqual(
        (yield* world.pages).map((page) => [page.key, page.state]),
        [["learned-convention-1", "draft"]],
      );
      assert.deepStrictEqual(yield* world.items, [["convention", "project_knowledge", "promoted"]]);
      assert.deepStrictEqual(
        (yield* world.promotions).map((p) => [p.state, p.attempts]),
        [["delivered", 1]],
      );
    }),
  ),
);
