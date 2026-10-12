import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KANBAN_METHODS, KanbanError, KanbanStop } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginRpc from "../PluginRpc.ts";
import { table } from "./handlers.ts";
import { migrations } from "./migrations.ts";
import * as StopGate from "./StopGate.ts";

const REFUSAL = "Emergency stop is set. Clear it to launch tickets.";

/** The gate over a migrated database; building it again over the same `sql` is a rebuilt layer. */
const layerOver = (sql: SqlClient.SqlClient) =>
  StopGate.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)));

const openInMemory = PluginDatabase.open({ id: "kanban", filename: ":memory:", migrations });

it.effect("setting twice and clearing when not set change nothing and succeed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* openInMemory;
      const gate = yield* StopGate.StopGate.pipe(Effect.provide(layerOver(sql)));
      assert.isNull(yield* gate.get);
      yield* gate.clear;

      const first = yield* gate.set({ setBy: "user", reason: "  hold the line  " });
      assert.strictEqual(first.setBy, "user");
      assert.strictEqual(first.reason, "hold the line");
      // A second set is not an error and does not overwrite who set it or why.
      const second = yield* gate.set({ setBy: "thread:other", reason: "something else" });
      assert.deepEqual(second, first);
      assert.deepEqual(yield* gate.get, first);
      assert.strictEqual((yield* sql`SELECT id FROM stop`).length, 1);

      yield* gate.clear;
      assert.isNull(yield* gate.get);
      yield* gate.clear;
      assert.deepEqual(yield* sql`SELECT id FROM stop`, []);

      // No reason, or a blank one, is stored as none.
      assert.isNull((yield* gate.set({ setBy: "user", reason: "   " })).reason);
    }),
  ),
);

it.effect(
  "a sweep that calls the gate for a Ready ticket launches it only when the stop is clear",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql } = yield* openInMemory;
        const gate = yield* StopGate.StopGate.pipe(Effect.provide(layerOver(sql)));
        const ready = yield* Ref.make(["ticket-1"]);
        const launched = yield* Ref.make<ReadonlyArray<string>>([]);
        // What an autonomous launcher must do: ask first, and keep the pending launch when refused.
        const launcherSweep = gate.assertLaunchAllowed.pipe(
          Effect.andThen(
            Ref.getAndSet(ready, []).pipe(
              Effect.flatMap((tickets) => Ref.update(launched, (all) => [...all, ...tickets])),
            ),
          ),
          Effect.catchTags({ KanbanError: () => Effect.void }),
        );

        yield* gate.set({ setBy: "user" });
        const refusal = yield* Effect.flip(gate.assertLaunchAllowed);
        assert.strictEqual(refusal.code, "gated");
        assert.strictEqual(refusal.message, REFUSAL);
        yield* launcherSweep;
        assert.deepEqual(yield* Ref.get(launched), []);
        assert.deepEqual(yield* Ref.get(ready), ["ticket-1"]);

        yield* gate.clear;
        yield* gate.assertLaunchAllowed;
        yield* launcherSweep;
        assert.deepEqual(yield* Ref.get(launched), ["ticket-1"]);
        assert.deepEqual(yield* Ref.get(ready), []);
      }),
    ),
);

it.effect("the stop survives a rebuilt layer and a reopened database file", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kanban-stop-" });
      const filename = path.join(directory, "kanban.sqlite");

      const set = yield* Effect.scoped(
        Effect.gen(function* () {
          const { sql } = yield* PluginDatabase.open({ id: "kanban", filename, migrations });
          const gate = yield* StopGate.StopGate.pipe(Effect.provide(layerOver(sql)));
          const set = yield* gate.set({ setBy: "user", reason: "freeze" });
          // The layer built again over the same database sees it.
          const rebuilt = yield* StopGate.StopGate.pipe(Effect.provide(layerOver(sql)));
          assert.deepEqual(yield* rebuilt.get, set);
          return set;
        }),
      );

      // The process restarts: the file is opened and migrated again.
      const { sql } = yield* PluginDatabase.open({ id: "kanban", filename, migrations });
      const gate = yield* StopGate.StopGate.pipe(Effect.provide(layerOver(sql)));
      assert.deepEqual(yield* gate.get, set);
      const refusal = yield* Effect.flip(gate.assertLaunchAllowed);
      assert.strictEqual(refusal.message, REFUSAL);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const decodeStop = Schema.decodeUnknownEffect(KanbanStop);
const decodeError = Schema.decodeUnknownEffect(KanbanError);

it.effect("the stop methods answer through the gateways their scopes belong to", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* openInMemory;
      const layer = layerOver(sql);
      const call = (gateway: "read" | "operate", method: string, input: unknown) =>
        PluginRpc.dispatch(gateway, table, { method, input }).pipe(Effect.provide(layer));

      assert.isNull(yield* call("read", KANBAN_METHODS.stopGet.method, {}));
      const set = yield* call("operate", KANBAN_METHODS.stopSet.method, { reason: "now" }).pipe(
        Effect.flatMap(decodeStop),
      );
      assert.strictEqual(set.setBy, "user");
      assert.strictEqual(set.reason, "now");
      assert.deepEqual(yield* call("read", KANBAN_METHODS.stopGet.method, {}), set);
      assert.deepEqual(yield* call("operate", KANBAN_METHODS.stopSet.method, {}), set);
      assert.deepEqual(yield* call("operate", KANBAN_METHODS.stopClear.method, {}), {});
      assert.deepEqual(yield* call("operate", KANBAN_METHODS.stopClear.method, {}), {});
      assert.isNull(yield* call("read", KANBAN_METHODS.stopGet.method, {}));

      // Setting needs the write scope; reading the read scope.
      const refusedBy = (gateway: "read" | "operate", method: string) =>
        call(gateway, method, {}).pipe(
          Effect.andThen(Effect.die("expected a failure")),
          Effect.flip,
        );
      assert.strictEqual(
        (yield* refusedBy("read", KANBAN_METHODS.stopSet.method)).message,
        'Method "kanban.stop.set" needs the operate scope.',
      );
      assert.strictEqual(
        (yield* refusedBy("read", KANBAN_METHODS.stopClear.method)).message,
        'Method "kanban.stop.clear" needs the operate scope.',
      );
      assert.strictEqual(
        (yield* refusedBy("operate", KANBAN_METHODS.stopGet.method)).message,
        'Method "kanban.stop.get" needs the read scope.',
      );
    }),
  ),
);

it.effect("answers with the inactive error while the plugin is off", () =>
  Effect.gen(function* () {
    for (const [gateway, method] of [
      ["read", KANBAN_METHODS.stopGet.method],
      ["operate", KANBAN_METHODS.stopSet.method],
      ["operate", KANBAN_METHODS.stopClear.method],
    ] as const) {
      const refused = yield* PluginRpc.dispatch(gateway, table, { method, input: {} }).pipe(
        Effect.andThen(Effect.die("expected a failure")),
        Effect.flip,
      );
      if (refused._tag !== "PluginMethodError") return assert.fail(refused.message);
      assert.strictEqual((yield* decodeError(refused.error)).code, "inactive");
    }
  }),
);
