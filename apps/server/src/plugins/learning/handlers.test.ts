import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import { handlers } from "./handlers.ts";
import { migrations } from "./migrations.ts";

const projectId = ProjectId.make("project:learning");
const range = { projectId, from: "1970-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

it.effect("answers with the inactive error while the plugin is off", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(handlers["learning.corrections"](range));
    assert.strictEqual(error.code, "inactive");
    assert.strictEqual(error.message, 'Plugin "learning" is not running.');
  }),
);

it.effect("lists and reads corrections through the store while the plugin runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "learning",
        filename: ":memory:",
        migrations,
      });
      const layer = CorrectionStore.layer.pipe(
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      );
      const store = yield* CorrectionStore.CorrectionStore.pipe(Effect.provide(layer));
      const recorded = yield* store.record({
        projectId,
        threadId: ThreadId.make("thread:learning"),
        failureKind: "manual",
        description: "Wrong file.",
        sourceEventIds: [],
        sourceKey: null,
      });
      const listed = yield* handlers["learning.corrections"](range).pipe(Effect.provide(layer));
      assert.deepEqual(listed, [recorded]);
      const one = yield* handlers["learning.correction"]({ id: recorded.id }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(one, recorded);
    }),
  ),
);
