import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { PluginHost, make, resolve } from "./PluginHost.ts";

const plugins = [
  { id: "telemetry", dependsOn: [] },
  { id: "learning", dependsOn: ["telemetry", "review"] },
  { id: "review", dependsOn: [] },
];

const layerHost = Layer.effect(PluginHost, make(plugins)).pipe(
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-host-test-" })),
  ),
);

it("runs a plugin only when it and every dependency are enabled, in any registry order", () => {
  const statusOf = (enabled: Record<string, boolean>, id: string) => {
    const status = resolve(plugins, enabled).find((candidate) => candidate.id === id);
    if (!status) throw new Error(`no status for ${id}`);
    return status;
  };

  assert.isTrue(statusOf({}, "learning").active);
  assert.isFalse(statusOf({ review: false }, "review").active);
  const learning = statusOf({ review: false }, "learning");
  assert.isTrue(learning.enabled);
  assert.isFalse(learning.active);
  assert.deepEqual(learning.missing, ["review"]);
  assert.deepEqual(statusOf({ learning: false }, "learning"), {
    id: "learning",
    dependsOn: ["telemetry", "review"],
    enabled: false,
    active: false,
    missing: [],
  });
  assert.deepEqual(resolve([{ id: "kanban", dependsOn: ["ghost"] }], {})[0]?.missing, ["ghost"]);
});

it.layer(NodeServices.layer)("plugin host", (it) => {
  it.effect("saves the choice to plugins.json without changing what runs until restart", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost;
      assert.deepEqual([...host.activeIds], ["telemetry", "learning", "review"]);

      const after = yield* host.setEnabled("review", false);
      assert.deepEqual(
        after.map((status) => [status.id, status.enabled, status.active]),
        [
          ["telemetry", true, true],
          ["learning", true, false],
          ["review", false, false],
        ],
      );
      assert.deepEqual([...host.activeIds], ["telemetry", "learning", "review"]);

      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.strictEqual(
        yield* fs.readFileString(path.join(stateDir, "plugins.json")),
        '{\n  "review": false\n}\n',
      );
      assert.deepEqual(
        (yield* host.statuses).map((status) => status.active),
        [true, false, false],
      );
    }).pipe(Effect.provide(layerHost)),
  );

  it.effect("refuses an unknown plugin and a plugin whose dependency is off", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost;
      const unknown = yield* Effect.flip(host.setEnabled("ghost", true));
      assert.strictEqual(unknown.message, 'Unknown plugin "ghost".');

      yield* host.setEnabled("telemetry", false);
      const refused = yield* Effect.flip(host.setEnabled("learning", true));
      assert.strictEqual(refused.message, "Enable telemetry before learning.");
    }).pipe(Effect.provide(layerHost)),
  );
});
