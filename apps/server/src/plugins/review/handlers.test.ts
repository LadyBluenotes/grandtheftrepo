import { assert, it } from "@effect/vitest";
import { REVIEW_METHODS, ReviewVerdict, ReviewVerdictError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PluginRpc from "../PluginRpc.ts";
import * as VerdictStore from "./VerdictStore.ts";
import { table } from "./handlers.ts";
import { harness, reviewed, reviewer, sendBack } from "./testkit.ts";

/** A review read through the read gateway, as a client sends it. */
const read = (input: unknown) =>
  PluginRpc.dispatch("read", table, { method: REVIEW_METHODS.verdicts.method, input });
const decodeError = Schema.decodeUnknownEffect(ReviewVerdictError);
const decodeVerdicts = Schema.decodeUnknownEffect(Schema.Array(ReviewVerdict));

it.effect("answers with the inactive error while the plugin is off", () =>
  Effect.gen(function* () {
    const refused = yield* read({ threadId: reviewed }).pipe(
      Effect.andThen(Effect.die("expected a failure")),
      Effect.flip,
    );
    if (refused._tag !== "PluginMethodError") throw new Error(refused.message);
    const error = yield* decodeError(refused.error);
    assert.strictEqual(error.code, "inactive");
    assert.strictEqual(error.message, 'Plugin "review" is not running.');
  }),
);

it.effect("lists a thread's verdicts through the store while the plugin runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, record } = yield* harness;
      const recorded = [yield* record(reviewer, sendBack)];
      const listed = yield* read({ threadId: reviewed }).pipe(
        Effect.flatMap(decodeVerdicts),
        Effect.provideService(VerdictStore.VerdictStore, store),
      );
      assert.deepEqual(
        listed.map(({ id, correctionId }) => ({ verdictId: id, correctionId })),
        recorded,
      );
    }),
  ),
);
