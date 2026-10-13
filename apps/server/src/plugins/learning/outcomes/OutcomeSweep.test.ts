import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Attention from "../../Attention.ts";
import * as HostDatabase from "../../HostDatabase.ts";
import * as PluginDatabase from "../../PluginDatabase.ts";
import * as PluginReactor from "../../PluginReactor.ts";
import * as CorrectionStore from "../CorrectionStore.ts";
import * as ItemStore from "../items/ItemStore.ts";
import { migrations } from "../migrations.ts";
import * as PromotionStore from "../PromotionStore.ts";
import * as OutcomeSweep from "./OutcomeSweep.ts";

const projectId = ProjectId.make("project:outcomes");
const otherProjectId = ProjectId.make("project:elsewhere");

const DAY = 86_400_000;
/** When the seeded promotion is delivered; its after window is complete 28 days later. */
const DELIVERED = Date.UTC(2026, 9, 1, 12, 0);
const COMPLETE = DELIVERED + 28 * DAY;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

// A real event sink on an in-memory core database, as producers.test does, for the reactor.
const layerCore = SqlitePersistence.layerMemory;
const layerSink = EventSink.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCore,
      EventStore.layer.pipe(Layer.provideMerge(layerCore)),
      ProjectionStore.layer.pipe(Layer.provideMerge(layerCore)),
    ),
  ),
);
const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope | EventSink.EventSinkV2>) =>
  Effect.scoped(body).pipe(Effect.provide(layerSink));

/**
 * Real stores and the sweep over a fresh learning database and an in-memory host database, as the
 * plugin's layer builds them, with the clock at `DELIVERED`.
 */
const setup = (
  options: { readonly caughtUp?: Effect.Effect<void, EventSink.EventSinkV2Error> } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DELIVERED);
    const { sql } = yield* PluginDatabase.open({
      id: "learning",
      filename: ":memory:",
      migrations,
    });
    const host = yield* PluginDatabase.open({
      id: "_host",
      filename: ":memory:",
      migrations: HostDatabase.migrations,
    });
    const attention = yield* Attention.Attention.pipe(
      Effect.provide(
        Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, host.sql))),
      ),
    );
    const context = yield* Layer.build(
      ItemStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
    );
    const items = Context.get(context, ItemStore.ItemStore);
    // The reactor that records the plugin's corrections, which the sweep waits for. It has no
    // handlers here: the tests write corrections themselves. Its drain is the sweep's, unless a
    // test holds the sweep behind a drain of its own.
    const reactor = yield* PluginReactor.start({
      plugin: "learning",
      from: "start",
      handlers: {},
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const sweep = yield* OutcomeSweep.sweep(options.caughtUp ?? reactor.drain).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(Attention.Attention, attention),
    );

    let sourceKey = 0;
    return {
      sql,
      items,
      attention,
      /** Hands the project's item for `mode` over to its rule's owner kind, delivered at `at`. */
      deliver: (mode: string, at = DELIVERED) =>
        Effect.gen(function* () {
          const item = yield* items.strengthen(projectId, mode, `seed:${mode}`, "Seeded.");
          const when = DateTime.makeUnsafe(at);
          yield* PromotionStore.open(
            {
              id: item.id,
              project_id: item.projectId,
              failure_mode: item.failureMode,
              owner_kind: item.ownerKind!,
            },
            when,
          );
          const [promotion] = yield* PromotionStore.forItem(item.id);
          yield* PromotionStore.deliver(promotion!, when);
          return { item, promotion: promotion! };
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      /** One correction declaring `mode`, made at each of `times`. */
      correct: (
        mode: "convention" | "scope_drift" | "defect",
        times: ReadonlyArray<number>,
        project = projectId,
      ) =>
        Effect.forEach(times, (at) =>
          CorrectionStore.insert({
            projectId: project,
            threadId: ThreadId.make("thread:outcomes"),
            failureKind: "review_verdict",
            declaredMode: mode,
            description: "Seeded.",
            sourceEventIds: [],
            sourceKey: `seed:${++sourceKey}`,
            occurredAt: DateTime.makeUnsafe(at),
          }),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      /** One supervisor tick of the sweep. */
      tick: (dryRun = false) => sweep.run({ dryRun }),
      outcomes: sql<{
        readonly promotion_id: number;
        readonly judged_at: string;
        readonly verdict: string;
      }>`SELECT promotion_id, judged_at, verdict FROM promotion_outcome ORDER BY promotion_id`,
      /** Every flag ever raised, open or cleared, oldest first. */
      flagRows: host.sql<{
        readonly plugin_id: string;
        readonly thread_id: string;
        readonly kind: string;
        readonly text: string;
        readonly resume_action: string;
        readonly raised_at: string;
        readonly cleared_at: string | null;
      }>`SELECT plugin_id, thread_id, kind, text, resume_action, raised_at, cleared_at
      FROM attention ORDER BY id`,
    };
  });

/** `count` days before `at`, one correction a day, the nearest first. */
const daysBefore = (at: number, count: number) =>
  Array.from({ length: count }, (_, index) => at - (index + 1) * DAY);
const daysAfter = (at: number, count: number) =>
  Array.from({ length: count }, (_, index) => at + (index + 1) * DAY);

const OPEN_LEARNING = JSON.stringify({ label: "Open learning", target: "settings" });

it.effect("5 before and 4 after raises one ineffective flag on the item's project", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const { promotion } = yield* world.deliver("scope_drift");
      yield* world.correct("scope_drift", [
        ...daysBefore(DELIVERED, 5),
        ...daysAfter(DELIVERED, 4),
      ]);

      yield* TestClock.setTime(COMPLETE);
      assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 1 });
      assert.deepStrictEqual(yield* world.outcomes, [
        { promotion_id: promotion.id, judged_at: iso(COMPLETE), verdict: "ineffective" },
      ]);
      const flags = yield* world.flagRows;
      assert.deepStrictEqual(
        flags.map((flag) => [
          flag.plugin_id,
          flag.thread_id,
          flag.kind,
          flag.text,
          flag.resume_action,
          flag.cleared_at,
        ]),
        [
          [
            "learning",
            `promotion:${projectId}:${promotion.id}`,
            "promotion_ineffective",
            "Scope drift recurred 4 times in the four weeks after its policy handover.",
            OPEN_LEARNING,
            null,
          ],
        ],
      );
    }),
  ),
);

it.effect("5 before and 0 after raises a settled flag", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const { promotion } = yield* world.deliver("convention");
      yield* world.correct("convention", daysBefore(DELIVERED, 5));

      yield* TestClock.setTime(COMPLETE);
      assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 1 });
      assert.deepStrictEqual(
        (yield* world.outcomes).map((row) => row.verdict),
        ["settled"],
      );
      assert.deepStrictEqual(
        (yield* world.flagRows).map((flag) => [flag.thread_id, flag.kind, flag.text]),
        [
          [
            `promotion:${projectId}:${promotion.id}`,
            "promotion_settled",
            "Convention has not recurred in four weeks; close the item if it is done.",
          ],
        ],
      );
    }),
  ),
);

it.effect("5 before and 1 after is recorded as improved and raises nothing", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      yield* world.deliver("scope_drift");
      yield* world.correct("scope_drift", [
        ...daysBefore(DELIVERED, 5),
        ...daysAfter(DELIVERED, 1),
      ]);

      yield* TestClock.setTime(COMPLETE);
      assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 0 });
      assert.deepStrictEqual(
        (yield* world.outcomes).map((row) => row.verdict),
        ["improved"],
      );
      assert.deepStrictEqual(yield* world.flagRows, []);
    }),
  ),
);

it.effect("2 before is inconclusive and raises nothing, even with many after", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      yield* world.deliver("scope_drift");
      yield* world.correct("scope_drift", [
        ...daysBefore(DELIVERED, 2),
        ...daysAfter(DELIVERED, 6),
      ]);

      yield* TestClock.setTime(COMPLETE);
      assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 0 });
      assert.deepStrictEqual(
        (yield* world.outcomes).map((row) => row.verdict),
        ["inconclusive"],
      );
      assert.deepStrictEqual(yield* world.flagRows, []);
    }),
  ),
);

it.effect(
  "counts the project's corrections with the item's mode inside the half-open windows",
  () =>
    scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        yield* world.deliver("scope_drift");
        yield* world.correct("scope_drift", [
          // Before: the first instant of the window counts, the one ahead of it does not.
          DELIVERED - 28 * DAY,
          DELIVERED - 28 * DAY - 1,
          DELIVERED - 10 * DAY,
          DELIVERED - 5 * DAY,
          DELIVERED - 1,
          // After: the delivery instant counts, the last instant of the window is the first outside.
          DELIVERED,
          DELIVERED + 10 * DAY,
          DELIVERED + 28 * DAY - 1,
          DELIVERED + 28 * DAY,
        ]);
        // Another mode in this project, and this mode in another project, are not recurrences.
        yield* world.correct("defect", [...daysBefore(DELIVERED, 5), ...daysAfter(DELIVERED, 5)]);
        yield* world.correct("scope_drift", daysAfter(DELIVERED, 8), otherProjectId);

        yield* TestClock.setTime(COMPLETE);
        yield* world.tick();
        // Four before and three after: ineffective, and the text carries the three.
        assert.deepStrictEqual(
          (yield* world.flagRows).map((flag) => [flag.kind, flag.text]),
          [
            [
              "promotion_ineffective",
              "Scope drift recurred 3 times in the four weeks after its policy handover.",
            ],
          ],
        );
      }),
    ),
);

it.effect("skips a promotion whose after window is not complete, and judges it later", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      yield* world.deliver("scope_drift");
      yield* world.correct("scope_drift", daysBefore(DELIVERED, 5));

      yield* TestClock.setTime(COMPLETE - 1);
      assert.deepStrictEqual(yield* world.tick(), { examined: 0, acted: 0, flags: 0 });
      assert.deepStrictEqual(yield* world.outcomes, []);
      assert.deepStrictEqual(yield* world.flagRows, []);

      yield* TestClock.setTime(COMPLETE);
      assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 1 });
      assert.deepStrictEqual(
        (yield* world.outcomes).map((row) => row.verdict),
        ["settled"],
      );
    }),
  ),
);

it.effect("never judges a promotion to local_only: there is no handover", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      // The rules send a defect to local_only, so this record is delivered by hand.
      const { promotion } = yield* world.deliver("defect");
      assert.strictEqual(promotion.ownerKind, "local_only");
      yield* world.correct("defect", daysBefore(DELIVERED, 5));

      yield* TestClock.setTime(COMPLETE);
      assert.deepStrictEqual(yield* world.tick(), { examined: 0, acted: 0, flags: 0 });
      assert.deepStrictEqual(yield* world.outcomes, []);
    }),
  ),
);

it.effect("a second tick with nothing new writes nothing", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      yield* world.deliver("scope_drift");
      yield* world.correct("scope_drift", [
        ...daysBefore(DELIVERED, 5),
        ...daysAfter(DELIVERED, 4),
      ]);
      yield* TestClock.setTime(COMPLETE);
      yield* world.tick();
      const outcomes = yield* world.outcomes;
      const flags = yield* world.flagRows;

      yield* TestClock.adjust("1 day");
      // The standing flag is looked at and stays; nothing is judged again.
      assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 0, flags: 1 });
      assert.deepStrictEqual(yield* world.outcomes, outcomes);
      assert.deepStrictEqual(yield* world.flagRows, flags);
    }),
  ),
);

it.effect("a dry run counts what it would do and writes nothing", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      yield* world.deliver("scope_drift");
      yield* world.correct("scope_drift", [
        ...daysBefore(DELIVERED, 5),
        ...daysAfter(DELIVERED, 4),
      ]);
      yield* TestClock.setTime(COMPLETE);

      assert.deepStrictEqual(yield* world.tick(true), { examined: 1, acted: 1, flags: 1 });
      assert.deepStrictEqual(yield* world.outcomes, []);
      assert.deepStrictEqual(yield* world.flagRows, []);
      // The dry run left the promotion unjudged, so the real tick still has it.
      assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 1 });
      assert.lengthOf(yield* world.outcomes, 1);
    }),
  ),
);

/** What a person does to the item that answers its flag. */
const RESPONSES = { close: { state: "closed" }, reroute: { ownerKind: "prompt" } } as const;

it.effect.each(["close", "reroute"] as const)(
  "a person's %s of the item clears its flag on the next tick",
  (response) =>
    scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        const { item } = yield* world.deliver("scope_drift");
        yield* world.correct("scope_drift", [
          ...daysBefore(DELIVERED, 5),
          ...daysAfter(DELIVERED, 4),
        ]);
        yield* TestClock.setTime(COMPLETE);
        yield* world.tick();
        assert.lengthOf(yield* world.attention.listAllOpen, 1);

        yield* TestClock.adjust("1 hour");
        yield* world.items.setDisposition({ id: item.id, ...RESPONSES[response] });
        // A dry run counts the clear and leaves the flag open.
        assert.deepStrictEqual(yield* world.tick(true), { examined: 1, acted: 1, flags: 0 });
        assert.lengthOf(yield* world.attention.listAllOpen, 1);

        assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 0 });
        assert.deepStrictEqual(yield* world.attention.listAllOpen, []);
        const [flag, ...rest] = yield* world.flagRows;
        assert.lengthOf(rest, 0);
        assert.strictEqual(flag?.cleared_at, iso(COMPLETE + 3_600_000));
        // The verdict stands: the promotion is not judged again.
        assert.deepStrictEqual(
          (yield* world.outcomes).map((row) => row.verdict),
          ["ineffective"],
        );
        assert.deepStrictEqual(yield* world.tick(), { examined: 0, acted: 0, flags: 0 });
      }),
    ),
);

it.effect("a person who closed the item before the judgment gets a verdict and no flag", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const { item } = yield* world.deliver("scope_drift");
      yield* world.correct("scope_drift", [
        ...daysBefore(DELIVERED, 5),
        ...daysAfter(DELIVERED, 4),
      ]);
      yield* TestClock.setTime(DELIVERED + 10 * DAY);
      yield* world.items.setDisposition({ id: item.id, state: "closed" });

      yield* TestClock.setTime(COMPLETE);
      assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 0 });
      assert.deepStrictEqual(
        (yield* world.outcomes).map((row) => row.verdict),
        ["ineffective"],
      );
      assert.deepStrictEqual(yield* world.flagRows, []);
    }),
  ),
);

it.effect("clears an open flag that names no judged promotion", () =>
  scoped(
    Effect.gen(function* () {
      const world = yield* setup();
      const resumeAction = { label: "Open learning", target: "settings" } as const;
      yield* world.attention.raise({
        pluginId: "learning",
        threadId: `promotion:${projectId}:99`,
        kind: "promotion_settled",
        text: "Gone.",
        resumeAction,
      });
      yield* world.attention.raise({
        pluginId: "learning",
        threadId: "promotion",
        kind: "promotion_ineffective",
        text: "Unreadable.",
        resumeAction,
      });

      assert.deepStrictEqual(yield* world.tick(), { examined: 2, acted: 2, flags: 0 });
      assert.deepStrictEqual(yield* world.attention.listAllOpen, []);
    }),
  ),
);

it.effect(
  "judges nothing while the reactor is behind the event log, and judges once it is not",
  () =>
    scoped(
      Effect.gen(function* () {
        // The reactor's drain completes when it holds every committed event; this one is let go by hand.
        const caught = yield* Deferred.make<void>();
        const world = yield* setup({ caughtUp: Deferred.await(caught) });
        yield* world.deliver("scope_drift");
        yield* world.correct("scope_drift", daysBefore(DELIVERED, 5));

        yield* TestClock.setTime(COMPLETE);
        // The corrections may be missing some, so the due promotion is counted, not judged, and no
        // flag is raised.
        const waiting = yield* Effect.forkChild(world.tick());
        yield* TestClock.adjust("3 seconds");
        assert.deepStrictEqual(yield* Fiber.join(waiting), { examined: 1, acted: 0, flags: 0 });
        assert.deepStrictEqual(yield* world.outcomes, []);
        assert.deepStrictEqual(yield* world.flagRows, []);

        yield* Deferred.succeed(caught, undefined);
        assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 1 });
        assert.deepStrictEqual(
          (yield* world.outcomes).map((row) => row.verdict),
          ["settled"],
        );
      }),
    ),
);

it.effect(
  "judges nothing while the reactor has a failed event, and judges once it is cleared",
  () =>
    scoped(
      Effect.gen(function* () {
        const world = yield* setup();
        yield* world.deliver("scope_drift");
        yield* world.correct("scope_drift", daysBefore(DELIVERED, 5));
        // The reactor's own shape for an event it moved past; it retries only rows under five
        // attempts, so nothing clears this one mid-test.
        yield* world.sql`INSERT INTO host_reactor_failure (sequence, type, attempts, last_error, failed_at)
        VALUES (1, 'thread.created', 5, 'database is locked', '2026-10-02T12:00:00.000Z')`;

        yield* TestClock.setTime(COMPLETE);
        assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 0, flags: 0 });
        assert.deepStrictEqual(yield* world.outcomes, []);

        yield* world.sql`DELETE FROM host_reactor_failure`;
        assert.deepStrictEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 1 });
        assert.lengthOf(yield* world.outcomes, 1);
      }),
    ),
);
