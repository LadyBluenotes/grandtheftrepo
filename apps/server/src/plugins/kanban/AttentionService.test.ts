import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  type RoutingAdherence,
  type RoutingAdherenceInput,
  RoutingError,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as HostDatabase from "../HostDatabase.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { unavailableAdherence } from "../routing/adherence.ts";
import * as AdherenceService from "../routing/AdherenceService.ts";
import * as AttentionService from "./AttentionService.ts";
import { projectA, projectB, thread } from "./writerFixtures.ts";

/** Thread fixtures are stamped from this instant; flags are raised a minute later. */
const epoch = Date.parse("2026-10-12T00:00:00.000Z");

/** Thread "a" in project A, waiting on the person's answer since the epoch. */
const asking: OrchestrationV2ThreadShell = {
  ...thread("a", { status: "waiting" }),
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("request-1"),
    kind: "user_input",
    createdAt: DateTime.makeUnsafe(epoch),
  },
};

const budgetBreach = {
  pluginId: "telemetry",
  threadId: `budget:1:${projectA}`,
  kind: "budget_breach",
} as const;

/** The service over a migrated in-memory host database and project shells the test rewrites. */
const fixture = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({
    id: "_host",
    filename: ":memory:",
    migrations: HostDatabase.migrations,
  });
  const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]);
  const { attention, service } = yield* Effect.all({
    attention: Attention.Attention,
    service: AttentionService.AttentionService,
  }).pipe(
    Effect.provide(
      AttentionService.layer.pipe(
        Layer.provideMerge(
          Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, sql))),
        ),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            listProjectThreads: ({ projectId }) =>
              Ref.get(shells).pipe(
                Effect.map((all) => all.filter((shell) => shell.projectId === projectId)),
              ),
          }),
        ),
      ),
    ),
  );
  yield* TestClock.setTime(epoch + 60_000);
  return {
    attention,
    list: service.list(projectA),
    threads: (next: ReadonlyArray<OrchestrationV2ThreadShell>) => Ref.set(shells, next),
  };
});

it.effect("a pending question and a budget breach show until each clears", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { attention, list, threads } = yield* fixture;
      yield* threads([asking, { ...asking, id: ThreadId.make("b"), projectId: projectB }]);
      yield* attention.raise({
        ...budgetBreach,
        text: "context_efficiency for the cheap tier is 900 over its budget of 800 in A.",
        resumeAction: { label: "Open budgets", target: "settings" },
      });
      // Another project's budget: not this board's.
      yield* attention.raise({
        ...budgetBreach,
        threadId: `budget:1:${projectB}`,
        text: "Over budget in B.",
        resumeAction: { label: "Open budgets", target: "settings" },
      });

      assert.deepEqual(
        (yield* list).map((row) => [
          row.source,
          row.kind,
          row.threadTitle,
          row.text,
          row.resumeAction.label,
        ]),
        [
          ["request", "question", "Thread a", "The agent asked you a question.", "Open thread"],
          [
            "flag",
            "budget_breach",
            null,
            "context_efficiency for the cheap tier is 900 over its budget of 800 in A.",
            "Open budgets",
          ],
        ],
      );

      yield* attention.clear(budgetBreach);
      assert.deepEqual(
        (yield* list).map((row) => row.kind),
        ["question"],
      );

      // The question was answered.
      yield* threads([{ ...asking, pendingRuntimeRequest: null }]);
      assert.deepEqual(yield* list, []);
    }),
  ),
);

it.effect(
  "raising the same flag twice leaves one row with the new text since the first raise",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { attention, list, threads } = yield* fixture;
        yield* threads([thread("a"), thread("b")]);
        const key = { pluginId: "kanban", threadId: "a", kind: "two_writers" } as const;
        const resumeAction = { label: "Open thread", target: "thread" } as const;
        yield* attention.raise({ ...key, text: "2 threads are writing.", resumeAction });
        yield* TestClock.adjust("1 minute");
        yield* attention.raise({ ...key, text: "3 threads are writing.", resumeAction });

        const [only, ...rest] = yield* list;
        assert.strictEqual(rest.length, 0);
        assert.strictEqual(only?.text, "3 threads are writing.");
        assert.strictEqual(only?.since, DateTime.formatIso(DateTime.makeUnsafe(epoch + 60_000)));
      }),
    ),
);

it.effect("a settled or archived thread's stale request gives no row", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { list, threads } = yield* fixture;
      const at = DateTime.makeUnsafe(epoch);
      yield* threads([
        { ...asking, settledOverride: "settled", settledAt: at },
        { ...asking, id: ThreadId.make("archived"), archivedAt: at },
      ]);
      assert.deepEqual(yield* list, []);
    }),
  ),
);

it.effect("routing mismatches show while routing runs, over the last seven whole UTC days", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { list, threads } = yield* fixture;
      yield* threads([asking]);
      yield* TestClock.setTime(Date.parse("2026-10-12T15:30:00.000Z"));
      const asked = yield* Ref.make<ReadonlyArray<RoutingAdherenceInput>>([]);
      const mismatch = {
        threadId: ThreadId.make("a"),
        tier: "cheap",
        recommended: { providerInstanceId: ProviderInstanceId.make("codex"), model: "mini" },
        observed: { providerInstanceId: ProviderInstanceId.make("codex"), model: "large" },
        at: "2026-10-08T09:00:00.000Z",
        flag: "Thread a was recommended the cheap tier but ran large on codex.",
      } as const;
      const routing = (answer: Effect.Effect<RoutingAdherence, RoutingError>) =>
        AdherenceService.AdherenceService.of({
          adherence: (input) =>
            Ref.update(asked, (inputs) => [...inputs, input]).pipe(Effect.andThen(answer)),
        });
      // Below the minimum sample the measure is unavailable, and the mismatch is still listed.
      const working = routing(Effect.succeed(unavailableAdherence("Few launches.", 1, [mismatch])));

      const kinds = (rows: ReadonlyArray<{ readonly kind: string }>) => rows.map((row) => row.kind);

      // Routing off: only the question.
      assert.deepEqual(kinds(yield* list), ["question"]);

      const on = yield* list.pipe(
        Effect.provideService(AdherenceService.AdherenceService, working),
      );
      assert.deepEqual(on[0], {
        source: "flag",
        id: "routing:a:2026-10-08T09:00:00.000Z",
        threadId: ThreadId.make("a"),
        threadTitle: "Thread a",
        kind: "routing_mismatch",
        text: "Thread a was recommended the cheap tier but ran large on codex.",
        resumeAction: { label: "Open thread", target: "thread" },
        since: "2026-10-08T09:00:00.000Z",
      });
      assert.deepEqual(kinds(on), ["routing_mismatch", "question"]);
      assert.deepEqual(yield* Ref.get(asked), [
        { projectId: projectA, from: "2026-10-05T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" },
      ]);

      // A routing failure leaves its rows out and the strip still answers.
      const failing = routing(Effect.fail(new RoutingError({ code: "io", message: "unreadable" })));
      assert.deepEqual(
        kinds(yield* list.pipe(Effect.provideService(AdherenceService.AdherenceService, failing))),
        ["question"],
      );
    }),
  ),
);
