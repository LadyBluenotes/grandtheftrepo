import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  POLICY_ENVIRONMENT_PROJECT_ID,
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
import { findBlock } from "../InstructionBlocks.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as Caveman from "./caveman.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";
import { policyMarkers } from "./Render.ts";

const projectId = POLICY_ENVIRONMENT_PROJECT_ID;
const key = Caveman.CAVEMAN_KEY;

/** A temp home holding Claude's custom config dir and Codex's dir. */
const layerHome = Layer.effect(
  HostProcess.HomeDirectory,
  Effect.gen(function* () {
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(baseDir, "home");
    yield* fs.makeDirectory(path.join(home, "claude-config"), { recursive: true });
    yield* fs.makeDirectory(path.join(home, ".codex"), { recursive: true });
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

/** A fresh database and a temp home with Claude's and Codex's directories, for each test. */
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
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-caveman-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** The `caveman` rows of the `policies` table. */
const stored = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly project_id: string;
    readonly version: number;
    readonly state: string;
    readonly body: string;
    readonly title: string;
  }>`SELECT project_id, version, state, body, title FROM policies WHERE "key" = ${key}`;
});

it("keeps the default body within the config tax limit", () => {
  assert.isAtMost(Caveman.CAVEMAN_TEXT.length, 1200);
});

it.effect("seeds the style once as an accepted policy of the whole environment", () =>
  Effect.gen(function* () {
    yield* Caveman.seed();
    const seeded = [
      {
        project_id: projectId,
        version: 1,
        state: "accepted",
        body: Caveman.CAVEMAN_TEXT,
        title: "Terse replies",
      },
    ];
    assert.deepStrictEqual(yield* stored, seeded);

    yield* Caveman.seed();
    assert.deepStrictEqual(yield* stored, seeded);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves an edited style alone when the plugin starts again", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    yield* Caveman.seed();
    yield* policies.create({ projectId, key, title: "Plain", body: "Reply in full sentences." });
    yield* policies.accept({ projectId, key, version: 2 });

    yield* Caveman.seed();
    assert.deepStrictEqual(
      (yield* stored).map(({ version, state, body }) => ({ version, state, body })),
      [{ version: 2, state: "accepted", body: "Reply in full sentences." }],
    );
    assert.strictEqual((yield* policies.list(projectId)).length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not accept a caveman policy that exists only as a draft", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    yield* policies.create({ projectId, key, title: "Mine", body: "Not reviewed yet." });

    yield* Caveman.seed();
    assert.deepStrictEqual(
      (yield* stored).map(({ version, state, body }) => ({ version, state, body })),
      [{ version: 1, state: "draft", body: "Not reviewed yet." }],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves nothing behind when the accept fails, and the next start seeds it whole", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const acceptFails = PolicyService.PolicyService.of({
      ...policies,
      accept: () => Effect.fail(new PolicyError({ code: "io", message: "Could not accept." })),
    });
    yield* Caveman.seed().pipe(Effect.provideService(PolicyService.PolicyService, acceptFails));
    // The draft the create wrote was rolled back with the failed accept.
    assert.deepStrictEqual(yield* stored, []);

    yield* Caveman.seed();
    assert.deepStrictEqual(
      (yield* stored).map(({ version, state, body }) => ({ version, state, body })),
      [{ version: 1, state: "accepted", body: Caveman.CAVEMAN_TEXT }],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("installs one block into Claude's and Codex's files and touches nothing else", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const claudeFile = path.join(home, "claude-config", "CLAUDE.md");
    const codexFile = path.join(home, ".codex", "AGENTS.md");
    const files = [claudeFile, codexFile];
    const mine = "# Mine\n\nKeep this.\n";
    for (const file of files) yield* fs.writeFileString(file, mine);

    yield* Caveman.seed();
    const results = yield* policies.install({ projectId, key, agents: ["claude", "codex"] });
    assert.deepStrictEqual(
      results.map(({ agent, status }) => ({ agent, status })),
      [
        { agent: "claude", status: "installed" },
        { agent: "codex", status: "installed" },
      ],
    );

    for (const file of files) {
      const text = yield* fs.readFileString(file);
      assert.strictEqual(text.split("<!-- fork-policy:start key=caveman -->").length, 2);
      assert.strictEqual(text.split("<!-- fork-policy:end key=caveman -->").length, 2);
      assert.include(text, Caveman.CAVEMAN_TEXT);
      const found = findBlock(text, policyMarkers(key));
      if (found.kind !== "found") return assert.fail(`${file} has no caveman block`);
      // The blank line before the block and the newline after it are the only bytes added.
      assert.strictEqual(text.slice(0, found.start), `${mine}\n`);
      assert.strictEqual(text.slice(found.end), "\n");
    }

    // A person edits around the block; installing again changes none of those bytes or the block.
    const edited: Array<string> = [];
    for (const file of files) {
      const text = `# Top\n\n${yield* fs.readFileString(file)}\n## Below\n\nAnd this.\n`;
      yield* fs.writeFileString(file, text);
      edited.push(text);
    }
    yield* policies.install({ projectId, key, agents: ["claude", "codex"] });
    for (const [index, file] of files.entries()) {
      assert.strictEqual(yield* fs.readFileString(file), edited[index]);
    }
  }).pipe(Effect.provide(layerTest)),
);
