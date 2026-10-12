import { assert, it } from "@effect/vitest";
import {
  LEARNING_METHODS,
  LearningCorrection,
  LearningError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginRpc from "../PluginRpc.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import { table } from "./handlers.ts";
import { migrations } from "./migrations.ts";

const projectId = ProjectId.make("project:learning");
const threadId = ThreadId.make("thread:learning");
const range = { projectId, from: "1970-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

/** A learning read through the read gateway, as a client sends it. */
const read = (method: string, input: unknown) =>
  PluginRpc.dispatch("read", table, { method, input });
const decodeError = Schema.decodeUnknownEffect(LearningError);
const decodeCorrection = Schema.decodeUnknownEffect(LearningCorrection);
const decodeCorrections = Schema.decodeUnknownEffect(Schema.Array(LearningCorrection));

it.effect("answers with the inactive error while the plugin is off", () =>
  Effect.gen(function* () {
    const refused = yield* read(LEARNING_METHODS.corrections.method, range).pipe(
      Effect.andThen(Effect.die("expected a failure")),
      Effect.flip,
    );
    if (refused._tag !== "PluginMethodError") throw new Error(refused.message);
    const error = yield* decodeError(refused.error);
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
      // As `thread.created` leaves it: a manual row needs a thread the plugin has seen.
      yield* sql`INSERT INTO threads (thread_id, project_id) VALUES (${threadId}, ${projectId})`;
      const recorded = yield* store.record({
        projectId,
        threadId,
        failureKind: "manual",
        description: "Wrong file.",
        sourceEventIds: [],
        sourceKey: null,
      });
      const listed = yield* read(LEARNING_METHODS.corrections.method, range).pipe(
        Effect.flatMap(decodeCorrections),
        Effect.provide(layer),
      );
      assert.deepEqual(listed, [recorded]);
      const one = yield* read(LEARNING_METHODS.correction.method, { id: recorded.id }).pipe(
        Effect.flatMap(decodeCorrection),
        Effect.provide(layer),
      );
      assert.deepEqual(one, recorded);
    }),
  ),
);
