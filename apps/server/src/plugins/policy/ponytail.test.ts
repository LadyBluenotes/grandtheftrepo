import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  POLICY_ENVIRONMENT_PROJECT_ID,
  PONYTAIL_RUNG_IDS,
  PolicyError,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";
import * as Ponytail from "./ponytail.ts";

const projectId = POLICY_ENVIRONMENT_PROJECT_ID;
const key = Ponytail.PONYTAIL_KEY;

const layerHome = Layer.effect(
  HostProcess.HomeDirectory,
  Effect.gen(function* () {
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(baseDir, "home");
    yield* fs.makeDirectory(path.join(home, "claude-config"), { recursive: true });
    return home;
  }),
);

const layerDatabase = Layer.effect(
  SqlClient.SqlClient,
  Effect.map(
    PluginDatabase.open({ id: "policy", filename: ":memory:", migrations }),
    (opened) => opened.sql,
  ),
);

/** A fresh database and a temp home with only Claude's directory, for each test. */
const layerTest = PolicyService.layer.pipe(
  Layer.provideMerge(layerDatabase),
  Layer.provideMerge(
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: "~/claude-config" },
        },
      },
    }),
  ),
  Layer.provideMerge(layerHome),
  // The runner's own CLAUDE_CONFIG_DIR, CODEX_HOME or COPILOT_HOME must not pick the targets.
  Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-ponytail-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** The `ponytail` rows of the `policies` table. */
const stored = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly project_id: string;
    readonly version: number;
    readonly state: string;
    readonly body: string;
  }>`SELECT project_id, version, state, body FROM policies WHERE "key" = ${key}`;
});

it.effect("seeds the ladder as an accepted policy that installs into an agent's file", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    yield* Ponytail.seed();
    assert.deepStrictEqual(yield* stored, [
      { project_id: projectId, version: 1, state: "accepted", body: Ponytail.PONYTAIL_TEXT },
    ]);

    const fs = yield* FileSystem.FileSystem;
    const [claude] = yield* policies.install({ projectId, key });
    assert.strictEqual(claude?.status, "installed");
    const text = yield* fs.readFileString(claude!.path);
    assert.include(text, "## Before you add anything");
    // Every rung id, in code and in order, one line each.
    const positions = PONYTAIL_RUNG_IDS.map((id) => text.indexOf(`\`${id}\`:`));
    assert.isTrue(positions.every((at, index) => at > (positions[index - 1] ?? -1)));
    assert.isTrue(
      text
        .trimEnd()
        .endsWith(
          "https://github.com/DietrichGebert/ponytail\n<!-- fork-policy:end key=ponytail -->",
        ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("seeds the ladder even when a delivered instruction file cannot be read", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const fs = yield* FileSystem.FileSystem;
    yield* policies.create({ projectId, key: "other", title: "Other", body: "Another policy." });
    yield* policies.accept({ projectId, key: "other", version: 1 });
    const [claude] = yield* policies.install({ projectId, key: "other", agents: ["claude"] });
    // A directory where the delivered file was: it exists and cannot be read as text.
    yield* fs.remove(claude!.path);
    yield* fs.makeDirectory(claude!.path);

    yield* Ponytail.seed();
    assert.deepStrictEqual(yield* stored, [
      { project_id: projectId, version: 1, state: "accepted", body: Ponytail.PONYTAIL_TEXT },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves an edited ladder alone when the plugin starts again", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    yield* Ponytail.seed();
    yield* policies.create({ projectId, key, title: "Ponytail ladder", body: "Ours." });
    yield* policies.accept({ projectId, key, version: 2 });

    yield* Ponytail.seed();
    assert.deepStrictEqual(yield* stored, [
      { project_id: projectId, version: 2, state: "accepted", body: "Ours." },
    ]);
    assert.strictEqual((yield* policies.list(projectId)).length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not accept a ponytail policy that exists only as a draft", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    yield* policies.create({ projectId, key, title: "Mine", body: "Not reviewed yet." });

    yield* Ponytail.seed();
    assert.deepStrictEqual(yield* stored, [
      { project_id: projectId, version: 1, state: "draft", body: "Not reviewed yet." },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves nothing behind when the accept fails, and the next start seeds it whole", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const acceptFails = PolicyService.PolicyService.of({
      ...policies,
      accept: () => Effect.fail(new PolicyError({ code: "io", message: "Could not accept." })),
    });
    yield* Ponytail.seed().pipe(Effect.provideService(PolicyService.PolicyService, acceptFails));
    // The draft the create wrote was rolled back with the failed accept.
    assert.deepStrictEqual(yield* stored, []);

    yield* Ponytail.seed();
    assert.deepStrictEqual(yield* stored, [
      { project_id: projectId, version: 1, state: "accepted", body: Ponytail.PONYTAIL_TEXT },
    ]);
  }).pipe(Effect.provide(layerTest)),
);
