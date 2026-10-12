import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { POLICY_ENVIRONMENT_PROJECT_ID, POLICY_METHODS, PolicyError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginRpc from "../PluginRpc.ts";
import { table } from "./handlers.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";

const projectId = POLICY_ENVIRONMENT_PROJECT_ID;
const decodeError = Schema.decodeUnknownEffect(PolicyError);

/** A policy call through the operate gateway, as a client sends it. */
const operate = (method: string, input: unknown) =>
  PluginRpc.dispatch("operate", table, { method, input });

/** A temp home with only Codex's directory, so Claude and Copilot are skipped. */
const layerHome = Layer.effect(
  HostProcess.HomeDirectory,
  Effect.gen(function* () {
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(baseDir, "home");
    yield* fs.makeDirectory(path.join(home, ".codex"), { recursive: true });
    return home;
  }),
);

const layerTest = PolicyService.layer.pipe(
  Layer.provideMerge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.map(
        PluginDatabase.open({ id: "policy", filename: ":memory:", migrations }),
        (opened) => opened.sql,
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(layerHome),
  // The runner's own CLAUDE_CONFIG_DIR, CODEX_HOME or COPILOT_HOME must not pick the targets.
  Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-policy-handlers-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("answers with the inactive error while the plugin is off", () =>
  Effect.gen(function* () {
    const refused = yield* operate(POLICY_METHODS.create.method, {
      projectId,
      key: "review",
      title: "Review",
      body: "Run the tests.",
    }).pipe(Effect.andThen(Effect.die("expected a failure")), Effect.flip);
    if (refused._tag !== "PluginMethodError") throw new Error(refused.message);
    const error = yield* decodeError(refused.error);
    assert.strictEqual(error.code, "inactive");
    assert.strictEqual(error.message, 'Plugin "policy" is not running.');
  }),
);

it.layer(layerTest)("policy methods through the operate gateway", (it) => {
  it.effect("create, accept, install and verify answer with their own results", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const codexFile = path.join(home, ".codex", "AGENTS.md");

      const created = yield* operate(POLICY_METHODS.create.method, {
        projectId,
        key: "review",
        title: "Review",
        body: "Run the tests.",
      });
      assert.deepEqual(created, { key: "review", version: 1, state: "draft" });
      const accepted = yield* operate(POLICY_METHODS.accept.method, {
        projectId,
        key: "review",
        version: 1,
      });
      assert.deepEqual(accepted, { key: "review", version: 1, state: "accepted" });
      const installed = yield* operate(POLICY_METHODS.install.method, { projectId, key: "review" });
      assert.deepEqual(installed, [
        { agent: "claude", status: "skipped", path: path.join(home, ".claude", "CLAUDE.md") },
        { agent: "codex", status: "installed", path: codexFile },
        {
          agent: "copilot",
          status: "skipped",
          path: path.join(home, ".copilot", "copilot-instructions.md"),
        },
      ]);
      const verified = yield* operate(POLICY_METHODS.verify.method, {
        projectId,
        key: "review",
        agents: ["codex"],
      });
      assert.deepEqual(verified, [
        { agent: "codex", status: "ok", path: codexFile, blockMatches: true, rulesCurrent: true },
      ]);
    }),
  );
});
