import { assert, it } from "@effect/vitest";
import { KNOWLEDGE_METHODS, KnowledgeError, type PluginGateway } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PluginRpc from "../PluginRpc.ts";
import { table } from "./handlers.ts";
import { onHost, projectId, world } from "./testkit.ts";

const decodeError = Schema.decodeUnknownEffect(KnowledgeError);
const decodeId = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Int }));
const decodeKeys = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String })));

/** A knowledge call through one gateway, as a client sends it. */
const call = (gateway: PluginGateway, method: string, input: unknown) =>
  PluginRpc.dispatch(gateway, table, { method, input });

const refusal = (gateway: PluginGateway, method: string, input: unknown) =>
  call(gateway, method, input).pipe(Effect.andThen(Effect.die("expected a failure")), Effect.flip);

it.effect("answers with the inactive error while the plugin is off", () =>
  Effect.gen(function* () {
    const refused = yield* refusal("read", KNOWLEDGE_METHODS.list.method, { projectId });
    if (refused._tag !== "PluginMethodError") throw new Error(refused.message);
    const error = yield* decodeError(refused.error);
    assert.strictEqual(error.code, "inactive");
    assert.strictEqual(error.message, 'Plugin "knowledge" is not running.');
  }),
);

it.effect("each method answers through its own gateway and is refused through another", () =>
  Effect.gen(function* () {
    const w = yield* world;
    const page = { projectId, key: "tests", title: "Running the tests", body: "Use vp." };

    const scope = yield* refusal("settingsWrite", KNOWLEDGE_METHODS.propose.method, page);
    assert.strictEqual(scope.message, 'Method "knowledge.propose" needs the operate scope.');
    const draft = yield* call("operate", KNOWLEDGE_METHODS.propose.method, page);
    assert.deepInclude(draft, { key: "tests", state: "draft", source: { kind: "person" } });
    const { id } = yield* decodeId(draft);

    const accept = yield* refusal("operate", KNOWLEDGE_METHODS.accept.method, { id });
    assert.strictEqual(accept.message, 'Method "knowledge.accept" needs the settingsWrite scope.');
    assert.deepInclude(yield* call("settingsWrite", KNOWLEDGE_METHODS.accept.method, { id }), {
      state: "accepted",
    });
    assert.deepStrictEqual(
      yield* call("settingsWrite", KNOWLEDGE_METHODS.install.method, { projectId }),
      [{ agent: "claude", status: "unchanged", path: w.claudeFile }],
    );
    assert.deepStrictEqual(yield* call("read", KNOWLEDGE_METHODS.verify.method, { projectId }), [
      { agent: "claude", status: "ok", path: w.claudeFile },
    ]);
    const listed = yield* call("read", KNOWLEDGE_METHODS.list.method, {
      projectId,
      state: "accepted",
    });
    const keys = yield* decodeKeys(listed);
    assert.deepStrictEqual(
      keys.map((entry) => entry.key),
      ["tests"],
    );
    assert.deepInclude(yield* call("settingsWrite", KNOWLEDGE_METHODS.retire.method, { id }), {
      state: "retired",
    });

    const other = yield* decodeId(
      yield* call("operate", KNOWLEDGE_METHODS.propose.method, { ...page, key: "other" }),
    );
    const discard = yield* refusal("operate", KNOWLEDGE_METHODS.discard.method, other);
    assert.strictEqual(
      discard.message,
      'Method "knowledge.discard" needs the settingsWrite scope.',
    );
    assert.deepInclude(yield* call("settingsWrite", KNOWLEDGE_METHODS.discard.method, other), {
      state: "retired",
    });

    const badKey = yield* refusal("operate", KNOWLEDGE_METHODS.propose.method, {
      ...page,
      key: "Not A Slug",
    });
    assert.strictEqual(badKey._tag, "PluginHostError");
  }).pipe(Effect.provide(onHost(Layer.empty))),
);
