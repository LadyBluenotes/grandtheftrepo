import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as HostDatabase from "../HostDatabase.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as WriterSweep from "./WriterSweep.ts";
import { projectA, projectB, thread } from "./writerFixtures.ts";

interface FlagRow {
  readonly id: number;
  readonly plugin_id: string;
  readonly thread_id: string;
  readonly kind: string;
  readonly text: string;
  readonly resume_action: string;
  readonly raised_at: string;
  readonly cleared_at: string | null;
}

/** The sweep over a migrated in-memory host database and a read model the test rewrites. */
const fixture = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({
    id: "_host",
    filename: ":memory:",
    migrations: HostDatabase.migrations,
  });
  const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]);
  const run = yield* WriterSweep.sweep.pipe(
    Effect.provide(
      Layer.mergeAll(
        Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, sql))),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: () =>
            Ref.get(shells).pipe(
              Effect.map((threads) => ({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads,
                archivedThreads: [],
              })),
            ),
        }),
      ),
    ),
  );
  return {
    run,
    threads: (next: ReadonlyArray<OrchestrationV2ThreadShell>) => Ref.set(shells, next),
    flags: sql<FlagRow>`SELECT * FROM attention ORDER BY id`,
    open: sql<FlagRow>`SELECT * FROM attention WHERE cleared_at IS NULL ORDER BY id`,
    /** Rows this connection has inserted, updated or deleted since it opened. */
    changes: sql<{ readonly n: number }>`SELECT total_changes() AS n`.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
    ),
  };
});

it.effect("two writing runs in one project raise one flag naming both threads, once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, threads, flags, changes } = yield* fixture;
      yield* threads([thread("b", { startedSeconds: 20 }), thread("a", { startedSeconds: 10 })]);

      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 1, flags: 1 });
      const [flag, ...rest] = yield* flags;
      assert.strictEqual(rest.length, 0);
      assert.strictEqual(flag?.plugin_id, "kanban");
      assert.strictEqual(flag?.kind, "two_writers");
      // The oldest writer carries it, and the text names every writing thread.
      assert.strictEqual(flag?.thread_id, "a");
      assert.include(flag?.text ?? "", '"Thread a"');
      assert.include(flag?.text ?? "", '"Thread b"');
      assert.deepEqual(JSON.parse(flag?.resume_action ?? ""), {
        label: "Open thread",
        target: "thread",
      });
      assert.isNull(flag?.cleared_at);

      // The same state again writes nothing: no row touched, none added.
      const before = yield* changes;
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 0, flags: 1 });
      assert.strictEqual(yield* changes, before);
      assert.deepEqual(yield* flags, [flag]);
    }),
  ),
);

it.effect("a third writer rewrites the text; completing runs down to one clears the flag", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, threads, flags, open, changes } = yield* fixture;
      const a = thread("a", { startedSeconds: 10 });
      const b = thread("b", { startedSeconds: 20 });
      const c = thread("c", { startedSeconds: 30 });
      yield* threads([a, b]);
      yield* run({ dryRun: false });
      const [raised] = yield* open;

      yield* threads([a, b, c]);
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 3, acted: 1, flags: 1 });
      const [rewritten, ...others] = yield* open;
      assert.strictEqual(others.length, 0);
      // Same row, same thread: the flag is updated, never doubled.
      assert.strictEqual(rewritten?.id, raised?.id);
      assert.include(rewritten?.text ?? "", '"Thread c"');

      yield* threads([a, b, thread("c", { startedSeconds: 30, status: "completed" })]);
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 3, acted: 1, flags: 1 });
      assert.notInclude((yield* open)[0]?.text ?? "", '"Thread c"');

      yield* threads([a, thread("b", { startedSeconds: 20, status: "completed" })]);
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 1, flags: 0 });
      assert.deepEqual(yield* open, []);
      const [cleared, ...history] = yield* flags;
      assert.strictEqual(history.length, 0);
      assert.strictEqual(cleared?.id, raised?.id);
      assert.isString(cleared?.cleared_at);

      const before = yield* changes;
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 0, flags: 0 });
      assert.strictEqual(yield* changes, before);
    }),
  ),
);

it.effect("a plan-mode run beside one writer raises nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, threads, flags } = yield* fixture;
      yield* threads([thread("writer"), thread("planner", { mode: "plan" })]);
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 0, flags: 0 });
      assert.deepEqual(yield* flags, []);
    }),
  ),
);

it.effect(
  "counts waiting runs, and not idle threads, finished runs or a provider's subagents",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { run, threads, open } = yield* fixture;
        yield* threads([
          thread("running"),
          thread("idle", { status: "idle" }),
          thread("done", { status: "completed" }),
          thread("queued", { status: "queued" }),
          thread("subagent", { nativeSubagent: true }),
        ]);
        assert.deepEqual(yield* run({ dryRun: false }), { examined: 5, acted: 0, flags: 0 });

        yield* threads([thread("running"), thread("waiting", { status: "waiting" })]);
        assert.strictEqual((yield* run({ dryRun: false })).flags, 1);
        assert.strictEqual((yield* open).length, 1);
      }),
    ),
);

it.effect("keeps one flag per project and ignores writers in different projects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, threads, open } = yield* fixture;
      yield* threads([
        thread("a1", { projectId: projectA, startedSeconds: 1 }),
        thread("b1", { projectId: projectB, startedSeconds: 2 }),
      ]);
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 2, acted: 0, flags: 0 });

      yield* threads([
        thread("a1", { projectId: projectA, startedSeconds: 1 }),
        thread("a2", { projectId: projectA, startedSeconds: 3 }),
        thread("b1", { projectId: projectB, startedSeconds: 2 }),
        thread("b2", { projectId: projectB, startedSeconds: 4 }),
      ]);
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 4, acted: 2, flags: 2 });
      assert.deepEqual(
        (yield* open).map((flag) => flag.thread_id),
        ["a1", "b1"],
      );
    }),
  ),
);

it.effect("moves the flag to the new oldest writer when the oldest one ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, threads, open, flags } = yield* fixture;
      const b = thread("b", { startedSeconds: 20 });
      const c = thread("c", { startedSeconds: 30 });
      yield* threads([thread("a", { startedSeconds: 10 }), b, c]);
      yield* run({ dryRun: false });
      assert.deepEqual(
        (yield* open).map((flag) => flag.thread_id),
        ["a"],
      );

      yield* threads([thread("a", { startedSeconds: 10, status: "completed" }), b, c]);
      assert.deepEqual(yield* run({ dryRun: false }), { examined: 3, acted: 2, flags: 1 });
      const stillOpen = yield* open;
      assert.deepEqual(
        stillOpen.map((flag) => flag.thread_id),
        ["b"],
      );
      assert.notInclude(stillOpen[0]?.text ?? "", '"Thread a"');
      // The old flag is kept, cleared; only one is open.
      assert.strictEqual((yield* flags).length, 2);
    }),
  ),
);

it.effect("a dry run writes nothing, to raise or to clear", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, threads, flags, open, changes } = yield* fixture;
      const a = thread("a", { startedSeconds: 10 });
      const b = thread("b", { startedSeconds: 20 });
      yield* threads([a, b]);

      const before = yield* changes;
      assert.deepEqual(yield* run({ dryRun: true }), { examined: 2, acted: 0, flags: 1 });
      assert.deepEqual(yield* flags, []);
      assert.strictEqual(yield* changes, before);

      yield* run({ dryRun: false });
      yield* threads([a, thread("b", { startedSeconds: 20, status: "completed" })]);
      const settled = yield* changes;
      assert.deepEqual(yield* run({ dryRun: true }), { examined: 2, acted: 0, flags: 0 });
      assert.strictEqual((yield* open).length, 1);
      assert.strictEqual(yield* changes, settled);
    }),
  ),
);
