import { assert, it } from "@effect/vitest";
import {
  PluginMethodError,
  definePluginMethods,
  type PluginGateway,
  type PluginMethodCall,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PluginRpc from "./PluginRpc.ts";

class NoteError extends Schema.TaggedError<NoteError>()("NoteError", {
  message: Schema.String,
}) {}
const decodeNoteError = Schema.decodeUnknownEffect(NoteError);

const NOTE_METHODS = definePluginMethods({
  double: {
    method: "notes.double",
    gateway: "read",
    input: Schema.Struct({ n: Schema.NumberFromString }),
    output: Schema.Struct({ doubled: Schema.NumberFromString }),
  },
  write: {
    method: "notes.write",
    gateway: "operate",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ length: Schema.Number }),
    error: NoteError,
  },
});

const table = PluginRpc.defineHandlers(NOTE_METHODS)({
  double: ({ n }) => Effect.succeed({ doubled: n * 2 }),
  write: ({ text }) =>
    text.length === 0
      ? Effect.fail(new NoteError({ message: "A note needs text." }))
      : Effect.succeed({ length: text.length }),
});

/** What `call` fails with; a success fails the test. */
const failure = (gateway: PluginGateway, call: PluginMethodCall) =>
  PluginRpc.dispatch(gateway, table, call).pipe(
    Effect.andThen(Effect.die("expected a failure")),
    Effect.flip,
  );

it.effect("decodes the input and encodes the output with the method's schemas", () =>
  Effect.gen(function* () {
    const output = yield* PluginRpc.dispatch("read", table, {
      method: "notes.double",
      input: { n: "21" },
    });
    assert.deepEqual(output, { doubled: "42" });
  }),
);

it.effect("refuses an unknown method and a method behind another gateway", () =>
  Effect.gen(function* () {
    for (const method of ["notes.delete", "constructor"]) {
      const unknown = yield* failure("read", { method, input: {} });
      assert.strictEqual(unknown.message, `Unknown plugin method "${method}".`);
    }
    const wrong = yield* failure("read", { method: "notes.write", input: { text: "hi" } });
    assert.strictEqual(wrong._tag, "PluginHostError");
    assert.strictEqual(wrong.message, 'Method "notes.write" needs the operate scope.');
  }),
);

it.effect("answers an input its schema rejects with the schema's message", () =>
  Effect.gen(function* () {
    const invalid = yield* failure("operate", { method: "notes.write", input: { text: 1 } });
    assert.strictEqual(invalid._tag, "PluginHostError");
    assert.strictEqual(invalid.message, 'Expected string\n  at ["text"]');
  }),
);

it.effect("carries a typed failure through PluginMethodError back to its own type", () =>
  Effect.gen(function* () {
    const failed = yield* failure("operate", { method: "notes.write", input: { text: "" } });
    assert.instanceOf(failed, PluginMethodError);
    if (failed._tag !== "PluginMethodError") return;
    assert.strictEqual(failed.method, "notes.write");
    const decoded = yield* decodeNoteError(failed.error);
    assert.instanceOf(decoded, NoteError);
    assert.strictEqual(decoded.message, "A note needs text.");
  }),
);
