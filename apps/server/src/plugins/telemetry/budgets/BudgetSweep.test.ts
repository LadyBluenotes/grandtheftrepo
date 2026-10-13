import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type RoutingEntry,
  type RoutingTier,
  TelemetryError,
  type TelemetryMeasure,
  type TelemetryMeasuresInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as Attention from "../../Attention.ts";
import * as HostDatabase from "../../HostDatabase.ts";
import * as PluginDatabase from "../../PluginDatabase.ts";
import * as TierMapService from "../../routing/TierMapService.ts";
import { migrations } from "../migrations.ts";
import * as BudgetStore from "./BudgetStore.ts";
import * as BudgetSweep from "./BudgetSweep.ts";

const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");

/** Midday on 2026-10-12, so the window is 10-05 to 10-12. */
const NOW = Date.UTC(2026, 9, 12, 15, 30);
const day = (date: string) => `${date}T00:00:00.000Z`;

const shell = (id: ProjectId) => ({
  id,
  title: id === projectA ? "Project A" : "Project B",
  workspaceRoot: `/repos/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const measure = (name: string, value: number | null, sampleSize: number): TelemetryMeasure => ({
  measure: name,
  state: value === null ? "unavailable" : "ok",
  value,
  unit: "tokens",
  direction: "lower_is_better",
  sampleSize,
  missingReason: value === null ? "No turn on the tier's model in the window." : null,
  provenance: [],
});

/**
 * The budget store and sweep over a fresh telemetry database with its three default budgets, the
 * host's attention flags over a fresh host database, `projects` listed, and a fake measure
 * service. It answers `context_efficiency` by window and tier as `answer` set it, unavailable
 * otherwise, next to another measure that always answers, and fails for projects in `failing`.
 * `state.during` runs inside each measure request, as a save could while the sweep waits on one;
 * `state.standard`, when set, is what a running routing plugin resolves the standard tier to.
 */
const setup = (projects: ReadonlyArray<ProjectId> = [projectA]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const { sql } = yield* PluginDatabase.open({
      id: "telemetry",
      filename: ":memory:",
      migrations,
    });
    const host = yield* PluginDatabase.open({
      id: "_host",
      filename: ":memory:",
      migrations: HostDatabase.migrations,
    });
    const answers = new Map<string, TelemetryMeasure>();
    const requests: Array<TelemetryMeasuresInput> = [];
    const failing = new Set<ProjectId>();
    const state: {
      replaying: boolean;
      during: ((input: TelemetryMeasuresInput) => Effect.Effect<void, TelemetryError>) | undefined;
      standard: RoutingEntry | undefined;
      projects: ReadonlyArray<ProjectId>;
    } = { replaying: false, during: undefined, standard: undefined, projects };
    const context = yield* Layer.build(
      Layer.mergeAll(
        BudgetStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
        Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, host.sql))),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.sync(() => state.projects.map(shell)),
        }),
      ),
    );
    const tierMap = TierMapService.TierMapService.of({
      get: () =>
        Effect.sync(() => {
          const tier = (resolved: RoutingEntry | null) => ({
            resolved,
            source: resolved === null ? null : ("environment" as const),
            available: true,
            environment: resolved,
            project: null,
          });
          return { cheap: tier(null), standard: tier(state.standard ?? null), strong: tier(null) };
        }),
      set: () => Effect.die("not used"),
    });
    const sweep = yield* BudgetSweep.sweep((input) =>
      Effect.suspend(() => {
        requests.push(input);
        return state.during?.(input) ?? Effect.void;
      }).pipe(
        Effect.andThen(() => {
          if (failing.has(input.projectId)) {
            return Effect.fail(
              new TelemetryError({ message: "The telemetry database is locked." }),
            );
          }
          if (state.replaying) {
            // As `unavailableMeasures` answers: every measure, one reason.
            return Effect.succeed(
              ["context_efficiency", "repeated_reads"].map((name) => ({
                ...measure(name, null, 0),
                missingReason: "Telemetry is still replaying the event log.",
              })),
            );
          }
          return Effect.succeed([
            answers.get(`${input.projectId} ${input.from} ${input.tier}`) ??
              measure("context_efficiency", null, 0),
            measure("repeated_reads", 0.1, 4),
          ]);
        }),
      ),
    ).pipe(Effect.provide(context));
    return {
      store: Context.get(context, BudgetStore.BudgetStore),
      requests,
      failing,
      state,
      /** `context_efficiency` for the window starting `from` on `tier` in `projectId`. */
      answer: (
        from: string,
        tier: RoutingTier,
        value: number | null,
        sampleSize = 30,
        projectId = projectA,
      ) =>
        answers.set(
          `${projectId} ${day(from)} ${tier}`,
          measure("context_efficiency", value, sampleSize),
        ),
      sweep: (dryRun = false) =>
        state.standard === undefined
          ? sweep.run({ dryRun })
          : sweep
              .run({ dryRun })
              .pipe(Effect.provideService(TierMapService.TierMapService, tierMap)),
      events: sql<{
        readonly budget_id: number;
        readonly project_id: string;
        readonly kind: string;
        readonly window_from: string;
        readonly window_to: string;
        readonly value: number;
        readonly threshold: number;
        readonly sample_size: number;
      }>`SELECT budget_id, project_id, kind, window_from, window_to, value, threshold, sample_size
        FROM budget_events ORDER BY id`,
      flags: host.sql<{
        readonly plugin_id: string;
        readonly thread_id: string;
        readonly kind: string;
        readonly text: string;
        readonly resume_action: string;
        readonly cleared_at: string | null;
      }>`SELECT plugin_id, thread_id, kind, text, resume_action, cleared_at
        FROM attention ORDER BY id`,
    };
  });

/** The default `standard` budget, the second the migration adds. */
const STANDARD = 2;

it.effect("an over-threshold window writes one breach and raises one flag", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.answer("2026-10-05", "standard", 1900);

      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 1 });
      // The last seven whole UTC days, once per tier the three defaults name.
      assert.deepEqual(
        budgets.requests.map(({ tier, from, to }) => [tier, from, to]),
        (["cheap", "standard", "strong"] as const).map((tier) => [
          tier,
          day("2026-10-05"),
          day("2026-10-12"),
        ]),
      );
      assert.deepEqual(yield* budgets.events, [
        {
          budget_id: STANDARD,
          project_id: projectA,
          kind: "breach",
          window_from: day("2026-10-05"),
          window_to: day("2026-10-12"),
          value: 1900,
          threshold: 1500,
          sample_size: 30,
        },
      ]);
      const [flag, ...rest] = yield* budgets.flags;
      assert.strictEqual(rest.length, 0);
      assert.deepEqual(
        [flag?.plugin_id, flag?.thread_id, flag?.kind, flag?.text, flag?.cleared_at],
        [
          "telemetry",
          `budget:${STANDARD}:${projectA}`,
          "budget_breach",
          "context_efficiency for the standard tier is 1900 over its budget of 1500 in Project A.",
          null,
        ],
      );
      assert.deepEqual(JSON.parse(flag?.resume_action ?? ""), {
        label: "Open budgets",
        target: "settings",
      });
      const [, standard] = yield* budgets.store.list({});
      assert.deepEqual([standard?.id, standard?.state], [STANDARD, "breach"]);
    }),
  ),
);

it.effect("the same window swept again writes nothing, even when judged again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.answer("2026-10-05", "standard", 1900);
      yield* budgets.sweep();
      const asked = budgets.requests.length;

      // Neither the window nor a budget changed: nothing is measured again.
      assert.deepEqual(yield* budgets.sweep(), { examined: 0, acted: 0, flags: 0 });
      assert.strictEqual(budgets.requests.length, asked);

      // The budget's terms changed, so the window is judged again, and the breach stands.
      yield* budgets.store.set({
        id: STANDARD,
        measure: "context_efficiency",
        tier: "standard",
        threshold: 1500,
        direction: "lower_is_better",
        projectId: null,
        minSample: 25,
        enabled: true,
      });
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 0, flags: 0 });
      assert.strictEqual(budgets.requests.length, asked + 1);
      assert.strictEqual((yield* budgets.events).length, 1);
      assert.strictEqual((yield* budgets.flags).length, 1);
    }),
  ),
);

it.effect("a later breaching window writes nothing; one back inside writes a recovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.answer("2026-10-05", "standard", 1900);
      budgets.answer("2026-10-06", "standard", 2000);
      budgets.answer("2026-10-07", "standard", 1200);
      yield* budgets.sweep();

      yield* TestClock.adjust("1 day");
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 0, flags: 0 });
      assert.strictEqual((yield* budgets.events).length, 1);

      yield* TestClock.adjust("1 day");
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 0 });
      const events = yield* budgets.events;
      assert.deepEqual(
        events.map((event) => [event.kind, event.window_from, event.value]),
        [
          ["breach", day("2026-10-05"), 1900],
          ["recovery", day("2026-10-07"), 1200],
        ],
      );
      const flags = yield* budgets.flags;
      assert.strictEqual(flags.length, 1);
      assert.isNotNull(flags[0]?.cleared_at);
      const [, standard] = yield* budgets.store.list({ projectId: projectA });
      assert.deepEqual(
        [standard?.state, standard?.latest.map((event) => event.kind)],
        ["ok", ["recovery"]],
      );
    }),
  ),
);

it.effect("breach, recovery, breach writes three events in order and raises a new flag", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.answer("2026-10-05", "standard", 1900);
      budgets.answer("2026-10-06", "standard", 1400);
      budgets.answer("2026-10-07", "standard", 1700);
      yield* budgets.sweep();
      yield* TestClock.adjust("1 day");
      yield* budgets.sweep();
      yield* TestClock.adjust("1 day");
      yield* budgets.sweep();

      assert.deepEqual(
        (yield* budgets.events).map((event) => event.kind),
        ["breach", "recovery", "breach"],
      );
      // The first flag was cleared by the recovery; the second breach raised a new one.
      assert.deepEqual(
        (yield* budgets.flags).map((flag) => [flag.text, flag.cleared_at === null]),
        [
          [
            "context_efficiency for the standard tier is 1900 over its budget of 1500 in Project A.",
            false,
          ],
          [
            "context_efficiency for the standard tier is 1700 over its budget of 1500 in Project A.",
            true,
          ],
        ],
      );
    }),
  ),
);

it.effect("a sample under the minimum, or an unavailable measure, writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      // Five turns against the default minimum of twenty; cheap and strong are unavailable.
      budgets.answer("2026-10-05", "standard", 1900, 5);

      assert.deepEqual(yield* budgets.sweep(), { examined: 0, acted: 0, flags: 0 });
      assert.deepEqual(yield* budgets.events, []);
      assert.deepEqual(yield* budgets.flags, []);
    }),
  ),
);

it.effect("an unmeasured window writes nothing, and is asked again on the next tick", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.answer("2026-10-05", "standard", 1900);
      budgets.state.replaying = true;

      assert.deepEqual(yield* budgets.sweep(), { examined: 0, acted: 0, flags: 0 });
      assert.deepEqual(yield* budgets.events, []);
      assert.deepEqual(yield* budgets.flags, []);

      budgets.state.replaying = false;
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 1 });
      assert.strictEqual(budgets.requests.length, 6);
    }),
  ),
);

it.effect("higher_is_better breaches below its threshold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      const added = yield* budgets.store.set({
        measure: "repeated_reads",
        tier: "strong",
        threshold: 0.25,
        direction: "higher_is_better",
        projectId: projectA,
        minSample: 1,
        enabled: true,
      });

      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(
        (yield* budgets.events).map((event) => [event.budget_id, event.kind, event.value]),
        [[added.id, "breach", 0.1]],
      );
      assert.strictEqual(
        (yield* budgets.flags)[0]?.text,
        "repeated_reads for the strong tier is 0.1 under its budget of 0.25 in Project A.",
      );
    }),
  ),
);

it.effect("a project whose measures fail is skipped, and judged on the next tick", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup([projectA, projectB]);
      budgets.answer("2026-10-05", "standard", 1900);
      budgets.answer("2026-10-05", "standard", 1600, 30, projectB);
      budgets.failing.add(projectA);

      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(
        (yield* budgets.events).map((event) => event.project_id),
        [projectB],
      );

      budgets.failing.clear();
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(
        (yield* budgets.events).map((event) => event.project_id),
        [projectB, projectA],
      );
    }),
  ),
);

it.effect("a dry run counts, writes nothing and remembers nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.answer("2026-10-05", "standard", 1900);

      assert.deepEqual(yield* budgets.sweep(true), { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(yield* budgets.sweep(true), { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(yield* budgets.events, []);
      assert.deepEqual(yield* budgets.flags, []);

      // A real tick after them still judges the window.
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 1 });
      assert.strictEqual((yield* budgets.events).length, 1);
      assert.strictEqual((yield* budgets.flags).length, 1);
    }),
  ),
);

it.effect("a budget removed or edited while it is measured gets no event and no flag", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.answer("2026-10-05", "standard", 1900);
      budgets.state.during = (input) =>
        input.tier === "standard" ? budgets.store.remove(STANDARD) : Effect.void;

      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 0, flags: 0 });
      assert.deepEqual(yield* budgets.events, []);
      assert.deepEqual(yield* budgets.flags, []);
      assert.deepEqual(
        (yield* budgets.store.list({})).map((budget) => budget.tier),
        ["cheap", "strong"],
      );

      // The strong budget's threshold moves above the value while it is measured.
      budgets.answer("2026-10-05", "strong", 3500);
      const strong = (yield* budgets.store.list({}))[1]!;
      budgets.state.during = (input) =>
        input.tier === "strong"
          ? budgets.store
              .set({
                id: strong.id,
                measure: strong.measure,
                tier: strong.tier,
                threshold: 4000,
                direction: strong.direction,
                projectId: strong.projectId,
                minSample: strong.minSample,
                enabled: strong.enabled,
              })
              .pipe(Effect.asVoid)
          : Effect.void;
      yield* TestClock.adjust("1 day");
      budgets.answer("2026-10-06", "strong", 3500);
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 0, flags: 0 });
      assert.deepEqual(yield* budgets.events, []);
      assert.deepEqual(yield* budgets.flags, []);
    }),
  ),
);

it.effect("a change to what a tier resolves to is judged on the next tick", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.state.standard = {
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-a",
      };
      budgets.answer("2026-10-05", "standard", 1200);
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 0, flags: 0 });
      const asked = budgets.requests.length;
      assert.deepEqual(yield* budgets.sweep(), { examined: 0, acted: 0, flags: 0 });
      assert.strictEqual(budgets.requests.length, asked);

      // The standard tier now runs another model, whose week is over budget.
      budgets.state.standard = {
        providerInstanceId: ProviderInstanceId.make("claude"),
        model: "gpt-b",
      };
      budgets.answer("2026-10-05", "standard", 1900);
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(
        budgets.requests.slice(asked).map((request) => request.tier),
        ["standard"],
      );
      assert.deepEqual(
        (yield* budgets.events).map((event) => [event.kind, event.value]),
        [["breach", 1900]],
      );
    }),
  ),
);

it.effect(
  "a project-scoped budget whose project is gone is not measured, and its flag clears",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const budgets = yield* setup([projectA, projectB]);
        const scoped = yield* budgets.store.set({
          measure: "context_efficiency",
          tier: "cheap",
          threshold: 500,
          direction: "lower_is_better",
          projectId: projectB,
          minSample: 20,
          enabled: true,
        });
        budgets.answer("2026-10-05", "cheap", 700, 30, projectB);
        // The default cheap budget judges the same week, within its 800.
        assert.deepEqual(yield* budgets.sweep(), { examined: 2, acted: 1, flags: 1 });
        const open = Effect.map(budgets.flags, (flags) =>
          flags.filter((flag) => flag.cleared_at === null).map((flag) => flag.thread_id),
        );
        assert.deepEqual(yield* open, [`budget:${scoped.id}:${projectB}`]);

        budgets.state.projects = [projectA];
        yield* TestClock.adjust("1 day");
        const asked = budgets.requests.length;
        assert.deepEqual(yield* budgets.sweep(), { examined: 0, acted: 1, flags: 0 });
        assert.deepEqual(
          budgets.requests.slice(asked).map((request) => request.projectId),
          [projectA, projectA, projectA],
        );
        assert.deepEqual(yield* open, []);
      }),
    ),
);

it.effect("disabling or removing a budget clears its flag; enabling it again raises it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budgets = yield* setup();
      budgets.answer("2026-10-05", "standard", 1900);
      yield* budgets.sweep();
      const standard = {
        id: STANDARD,
        measure: "context_efficiency",
        tier: "standard",
        threshold: 1500,
        direction: "lower_is_better",
        projectId: null,
        minSample: 20,
      };
      const open = Effect.map(budgets.flags, (flags) =>
        flags.filter((flag) => flag.cleared_at === null).map((flag) => flag.thread_id),
      );

      yield* budgets.store.set({ ...standard, enabled: false });
      assert.deepEqual(yield* budgets.sweep(), { examined: 0, acted: 1, flags: 0 });
      assert.deepEqual(yield* open, []);

      // Still over, and its state is still the breach: the flag comes back, with no new event.
      yield* budgets.store.set({ ...standard, enabled: true });
      assert.deepEqual(yield* budgets.sweep(), { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(yield* open, [`budget:${STANDARD}:${projectA}`]);
      assert.strictEqual((yield* budgets.events).length, 1);

      yield* budgets.store.remove(STANDARD);
      assert.deepEqual(yield* budgets.sweep(), { examined: 0, acted: 1, flags: 0 });
      assert.deepEqual(yield* open, []);
      assert.deepEqual(yield* budgets.events, []);
    }),
  ),
);
