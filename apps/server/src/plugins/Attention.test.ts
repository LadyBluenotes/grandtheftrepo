import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Attention from "./Attention.ts";
import * as HostDatabase from "./HostDatabase.ts";
import * as PluginDatabase from "./PluginDatabase.ts";

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

/** The service over a migrated in-memory host database. */
const fixture = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({
    id: "_host",
    filename: ":memory:",
    migrations: HostDatabase.migrations,
  });
  const attention = yield* Attention.Attention.pipe(
    Effect.provide(
      Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, sql))),
    ),
  );
  return { attention, sql, rows: sql<FlagRow>`SELECT * FROM attention ORDER BY id` };
});

const key = { pluginId: "budget", threadId: "thread-1", kind: "budget_breach" } as const;
const resumeAction = { label: "Open settings", target: "settings" } as const;

it.effect("raising the same flag twice leaves one row with the new text and the first time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { attention, rows } = yield* fixture;
      yield* attention.raise({ ...key, text: "Over budget by $2.", resumeAction });
      const [first] = yield* rows;
      yield* TestClock.adjust("1 minute");
      yield* attention.raise({ ...key, text: "Over budget by $5.", resumeAction });

      const [only, ...rest] = yield* rows;
      assert.strictEqual(rest.length, 0);
      assert.strictEqual(only?.id, first?.id);
      assert.strictEqual(only?.plugin_id, "budget");
      assert.strictEqual(only?.text, "Over budget by $5.");
      assert.strictEqual(only?.raised_at, first?.raised_at);
      assert.deepEqual(JSON.parse(only?.resume_action ?? ""), resumeAction);
      assert.isNull(only?.cleared_at);
      assert.deepEqual(yield* attention.listOpen({ pluginId: "budget", kind: "budget_breach" }), [
        { threadId: "thread-1", text: "Over budget by $5." },
      ]);
    }),
  ),
);

it.effect("clear closes only its own flag, and a later raise opens a new row", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { attention, rows } = yield* fixture;
      yield* attention.raise({ ...key, text: "Over budget.", resumeAction });
      // Same thread and kind, another plugin: a flag of its own.
      yield* attention.raise({ ...key, pluginId: "other", text: "Theirs.", resumeAction });

      yield* attention.clear(key);
      const afterClear = yield* rows;
      const [cleared, theirs] = afterClear;
      assert.isString(cleared?.cleared_at);
      assert.isNull(theirs?.cleared_at);
      assert.deepEqual(
        yield* attention.listOpen({ pluginId: "budget", kind: "budget_breach" }),
        [],
      );

      // Clearing when nothing is open changes nothing.
      yield* attention.clear(key);
      assert.deepEqual(yield* rows, afterClear);

      // The cause came back: a new open row, the cleared one kept as history.
      yield* attention.raise({ ...key, text: "Over budget again.", resumeAction });
      const all = yield* rows;
      assert.strictEqual(all.length, 3);
      assert.deepEqual(all[0], cleared);
      assert.deepEqual(yield* attention.listOpen({ pluginId: "budget", kind: "budget_breach" }), [
        { threadId: "thread-1", text: "Over budget again." },
      ]);
    }),
  ),
);

it.effect("without a plugin or kind, lists every open flag, oldest first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { attention } = yield* fixture;
      yield* attention.raise({ ...key, text: "Over budget.", resumeAction });
      yield* attention.raise({
        pluginId: "kanban",
        threadId: "thread-2",
        kind: "two_writers",
        text: "Two writers.",
        resumeAction,
      });
      yield* attention.raise({ ...key, threadId: "thread-3", text: "Cleared.", resumeAction });
      yield* attention.clear({ ...key, threadId: "thread-3" });

      assert.deepEqual(yield* attention.listOpen({}), [
        { threadId: "thread-1", text: "Over budget." },
        { threadId: "thread-2", text: "Two writers." },
      ]);
      assert.deepEqual(yield* attention.listOpen({ kind: "two_writers" }), [
        { threadId: "thread-2", text: "Two writers." },
      ]);
    }),
  ),
);

it.effect("flags stored before plugin targets decode as they were, beside a plugin target", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { attention, sql } = yield* fixture;
      // The JSON the earlier schema wrote, one row per target it knew.
      for (const [threadId, json] of [
        ["thread-1", '{"label":"Open thread","target":"thread"}'],
        ["thread-2", '{"label":"Open board","target":"board"}'],
        ["thread-3", '{"label":"Open budgets","target":"settings"}'],
      ] as const) {
        yield* sql`
          INSERT INTO attention (plugin_id, thread_id, kind, text, resume_action, raised_at)
          VALUES ('kanban', ${threadId}, 'two_writers', 'Old.', ${json}, '2026-10-01T00:00:00.000Z')
        `;
      }
      const openItem = {
        label: "Open item",
        target: "plugin",
        pluginId: "learning",
        tab: "items",
        recordId: "12",
      } as const;
      yield* attention.raise({
        pluginId: "learning",
        threadId: "promotion:project-1:3",
        kind: "promotion_ineffective",
        text: "The handover did not help.",
        resumeAction: openItem,
      });

      assert.deepEqual(
        (yield* attention.listAllOpen).map((flag) => flag.resumeAction),
        [
          { label: "Open thread", target: "thread" },
          { label: "Open board", target: "board" },
          { label: "Open budgets", target: "settings" },
          openItem,
        ],
      );
    }),
  ),
);
