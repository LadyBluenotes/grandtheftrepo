import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  POLICY_ENVIRONMENT_PROJECT_ID,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type PolicyError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as InstructionBlocks from "../InstructionBlocks.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";

const projectId = POLICY_ENVIRONMENT_PROJECT_ID;

/** A temp home holding Claude's custom config dir and Codex's dir, and no Copilot dir. */
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

/** Every path a text read asked for, so a test can count how often a file is read. */
const reads: Array<string> = [];

const layerCountedReads = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) =>
    FileSystem.FileSystem.of({
      ...fs,
      readFileString: (filePath, encoding) =>
        Effect.suspend(() => {
          reads.push(filePath);
          return fs.readFileString(filePath, encoding);
        }),
    }),
  ),
);

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
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-policy-test-" })),
  ),
  Layer.provideMerge(layerCountedReads),
  Layer.provideMerge(NodeServices.layer),
);

const failure = <A>(effect: Effect.Effect<A, PolicyError>) =>
  Effect.map(Effect.flip(effect), (error) => error.message);

it.layer(layerTest)("PolicyService", (it) => {
  it.effect(
    "installs where the agent's directory exists and replaces the block in place next time",
    () =>
      Effect.gen(function* () {
        const policies = yield* PolicyService.PolicyService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* HostProcess.HomeDirectory;
        const claudeFile = path.join(home, "claude-config", "CLAUDE.md");
        const codexFile = path.join(home, ".codex", "AGENTS.md");
        yield* fs.writeFileString(codexFile, "# Mine\n\nKeep this.\n");

        yield* policies.create({
          projectId,
          key: "review",
          title: "Review",
          body: "Run the tests.",
        });
        yield* policies.accept({ projectId, key: "review", version: 1 });
        assert.deepStrictEqual(yield* policies.install({ projectId, key: "review" }), [
          { agent: "claude", status: "installed", path: claudeFile },
          { agent: "codex", status: "installed", path: codexFile },
          {
            agent: "copilot",
            status: "skipped",
            path: path.join(home, ".copilot", "copilot-instructions.md"),
          },
        ]);
        assert.isFalse(yield* fs.exists(path.join(home, ".copilot")));
        const claude = yield* fs.readFileString(claudeFile);
        assert.isTrue(
          claude.startsWith("<!-- fork-policy:start key=review -->\n<!-- fork-policy hash="),
        );
        assert.isTrue(claude.endsWith("\n\nRun the tests.\n<!-- fork-policy:end key=review -->\n"));

        const installed = yield* fs.readFileString(codexFile);
        assert.isTrue(
          installed.startsWith("# Mine\n\nKeep this.\n\n<!-- fork-policy:start key=review -->"),
        );
        yield* fs.writeFileString(codexFile, `${installed}\n## Below\n\nAnd this.\n`);

        yield* policies.create({
          projectId,
          key: "review",
          title: "Review",
          body: "Run the tests twice.",
        });
        yield* policies.accept({ projectId, key: "review", version: 2 });
        yield* policies.install({ projectId, key: "review", agents: ["codex"] });
        const second = yield* fs.readFileString(codexFile);
        assert.isTrue(
          second.startsWith("# Mine\n\nKeep this.\n\n<!-- fork-policy:start key=review -->"),
        );
        assert.isTrue(
          second.endsWith("<!-- fork-policy:end key=review -->\n\n## Below\n\nAnd this.\n"),
        );
        assert.strictEqual(second.split("<!-- fork-policy:start key=review -->").length, 2);
        assert.include(second, "version=2 -->");
        assert.include(second, "Run the tests twice.");
        assert.notInclude(second, "Run the tests.\n");
      }),
  );

  it.effect("verify tells an edited block, a changed RULES.md and a removed block apart", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const rulesPath = path.join(stateDir, "RULES.md");
      const key = "verify";
      yield* policies.create({ projectId, key, title: "Verify", body: "Check twice." });
      yield* policies.accept({ projectId, key, version: 1 });
      const [codex] = yield* policies.install({ projectId, key, agents: ["codex"] });
      const file = codex!.path;
      const verify = policies.verify({ projectId, key, agents: ["codex"] });

      assert.deepStrictEqual(yield* verify, [
        { agent: "codex", status: "ok", path: file, blockMatches: true, rulesCurrent: true },
      ]);
      const rows = yield* sql<{
        readonly verified_at: string | null;
        readonly verification_method: string | null;
      }>`SELECT verified_at, verification_method FROM deliveries WHERE "key" = ${key}`;
      assert.strictEqual(rows[0]?.verification_method, "reread_hash");
      assert.isString(rows[0]?.verified_at);

      const text = yield* fs.readFileString(file);
      yield* fs.writeFileString(file, text.replace("Check twice.", "Check once."));
      const [drifted] = yield* verify;
      assert.deepStrictEqual(
        [drifted?.status, drifted?.blockMatches, drifted?.rulesCurrent],
        ["drifted", false, true],
      );

      yield* fs.writeFileString(file, text);
      yield* fs.writeFileString(rulesPath, "Always be kind.\n");
      const [stale] = yield* verify;
      assert.deepStrictEqual(
        [stale?.status, stale?.blockMatches, stale?.rulesCurrent],
        ["ok", true, false],
      );
      yield* policies.install({ projectId, key, agents: ["codex"] });
      assert.isTrue((yield* verify)[0]?.rulesCurrent);
      assert.include(yield* fs.readFileString(file), "\nAlways be kind.\n\nCheck twice.\n");

      yield* fs.writeFileString(file, "# Nothing here\n");
      const [missing] = yield* verify;
      assert.deepStrictEqual([missing?.status, missing?.blockMatches], ["missing", false]);
      yield* fs.remove(file);
      assert.strictEqual((yield* verify)[0]?.status, "missing");
      // An agent that was never delivered to is missing as well.
      assert.strictEqual(
        (yield* policies.verify({ projectId, key, agents: ["copilot"] }))[0]?.status,
        "missing",
      );
      yield* fs.remove(rulesPath);
    }),
  );

  it.effect("each refusal returns its message and writes nothing", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const home = yield* HostProcess.HomeDirectory;
      const claudeFile = path.join(home, "claude-config", "CLAUDE.md");
      const codexFile = path.join(home, ".codex", "AGENTS.md");
      yield* fs.writeFileString(claudeFile, "# Claude\n");

      assert.strictEqual(
        yield* failure(policies.create({ projectId, key: "Bad Key", title: "Bad", body: "" })),
        'Policy key "Bad Key" must match [a-z0-9-]+.',
      );
      assert.strictEqual(
        yield* failure(
          policies.create({
            projectId,
            key: "nested",
            title: "Nested",
            body: "<!-- fork-policy:start key=x -->",
          }),
        ),
        'A policy body cannot contain "fork-policy:".',
      );
      const unsafe = ProjectId.make("p -->\n<!-- fork-policy:end key=x");
      assert.strictEqual(
        yield* failure(
          policies.create({ projectId: unsafe, key: "safe", title: "Safe", body: "" }),
        ),
        `Project id "${unsafe}" cannot be placed in a policy marker.`,
      );
      assert.strictEqual(
        yield* failure(policies.install({ projectId, key: "unknown" })),
        'Policy "unknown" was not found.',
      );

      yield* policies.create({ projectId, key: "draft-only", title: "Draft", body: "Not yet." });
      assert.strictEqual(
        yield* failure(policies.install({ projectId, key: "draft-only" })),
        'Policy "draft-only" version 1 is not accepted.',
      );
      assert.strictEqual(
        yield* failure(policies.accept({ projectId, key: "draft-only", version: 9 })),
        'Policy "draft-only" version 9 was not found.',
      );

      yield* policies.create({ projectId, key: "damaged", title: "Damaged", body: "Body." });
      yield* policies.accept({ projectId, key: "damaged", version: 1 });
      const duplicated =
        "<!-- fork-policy:start key=damaged -->\n<!-- fork-policy:start key=damaged -->\nx\n<!-- fork-policy:end key=damaged -->\n";
      yield* fs.writeFileString(claudeFile, duplicated);
      assert.strictEqual(
        yield* failure(policies.install({ projectId, key: "damaged" })),
        `${claudeFile} has a damaged fork-policy block for "damaged". Fix or remove it by hand.`,
      );
      assert.strictEqual(yield* fs.readFileString(claudeFile), duplicated);

      // A lone marker in the second agent's file refuses the whole install: the first is not written either.
      yield* fs.writeFileString(claudeFile, "# Claude\n");
      const lonely = "# Mine\n<!-- fork-policy:end key=damaged -->\n";
      yield* fs.writeFileString(codexFile, lonely);
      assert.strictEqual(
        yield* failure(policies.install({ projectId, key: "damaged" })),
        `${codexFile} has a damaged fork-policy block for "damaged". Fix or remove it by hand.`,
      );
      assert.strictEqual(yield* fs.readFileString(claudeFile), "# Claude\n");
      assert.strictEqual(yield* fs.readFileString(codexFile), lonely);
      assert.deepStrictEqual(
        yield* sql`SELECT agent FROM deliveries WHERE "key" IN ('draft-only', 'damaged')`,
        [],
      );
    }),
  );

  it.effect("accepting version 1 after version 2 restores it, and policy_versions only grows", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const key = "restore";
      const count = Effect.map(
        sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM policy_versions WHERE "key" = ${key}`,
        (rows) => rows[0]?.n,
      );
      const shown = Effect.map(
        sql<{
          readonly version: number;
          readonly state: string;
          readonly body: string;
        }>`SELECT version, state, body FROM policies WHERE "key" = ${key}`,
        (rows) => rows[0],
      );

      assert.deepStrictEqual(
        yield* policies.create({ projectId, key, title: "Restore", body: "First." }),
        { key, version: 1, state: "draft" },
      );
      assert.strictEqual(yield* count, 1);
      assert.deepStrictEqual(yield* shown, { version: 1, state: "draft", body: "First." });
      assert.deepStrictEqual(yield* policies.accept({ projectId, key, version: 1 }), {
        key,
        version: 1,
        state: "accepted",
      });
      assert.strictEqual(yield* count, 2);
      yield* policies.create({ projectId, key, title: "Restore", body: "Second." });
      assert.strictEqual(yield* count, 3);
      // The accepted version stays on show while a newer draft exists.
      assert.deepStrictEqual(yield* shown, { version: 1, state: "accepted", body: "First." });
      yield* policies.accept({ projectId, key, version: 2 });
      assert.strictEqual(yield* count, 5);
      assert.deepStrictEqual(yield* shown, { version: 2, state: "accepted", body: "Second." });
      yield* policies.accept({ projectId, key, version: 1 });
      assert.strictEqual(yield* count, 7);
      assert.deepStrictEqual(yield* shown, { version: 1, state: "accepted", body: "First." });
      // Accepting the accepted version again appends nothing.
      yield* policies.accept({ projectId, key, version: 1 });
      assert.strictEqual(yield* count, 7);

      const [codex] = yield* policies.install({ projectId, key, agents: ["codex"] });
      assert.include(
        yield* fs.readFileString(codex!.path),
        "version=1 -->\n\n\nFirst.\n<!-- fork-policy:end key=restore -->",
      );

      // A project's policy carries the project in its block id; its list adds the environment's.
      const local = ProjectId.make("project-1");
      yield* policies.create({ projectId: local, key: "local", title: "Local", body: "Here." });
      yield* policies.accept({ projectId: local, key: "local", version: 1 });
      yield* policies.install({ projectId: local, key: "local", agents: ["codex"] });
      assert.include(
        yield* fs.readFileString(codex!.path),
        "<!-- fork-policy:start key=project-1/local -->",
      );
      const listed = yield* policies.listWithStatus(local);
      assert.include(
        listed.map((policy) => `${policy.projectId}/${policy.key}@${policy.version}`),
        "project-1/local@1",
      );
      assert.include(
        listed.map((policy) => `${policy.projectId}/${policy.key}@${policy.version}`),
        "*/restore@1",
      );
      assert.strictEqual(
        listed.find((policy) => policy.key === "local")?.deliveries[0]?.agent,
        "codex",
      );
      assert.deepStrictEqual(
        (yield* policies.list(ProjectId.make("project-2"))).map((policy) => policy.projectId),
        ["*", "*", "*", "*", "*"],
      );

      // Every version in its latest state, the shown body, and each agent's file as it is now.
      const restored = listed.find((policy) => policy.key === key);
      assert.deepStrictEqual(
        restored?.versions.map((version) => [version.version, version.state, version.title]),
        [
          [1, "accepted", "Restore"],
          [2, "superseded", "Restore"],
        ],
      );
      assert.strictEqual(restored?.body, "First.");
      assert.deepStrictEqual(
        restored?.status.map((agent) => [agent.agent, agent.status]),
        [
          ["claude", "missing"],
          ["codex", "ok"],
          ["copilot", "missing"],
        ],
      );
      // Listing marks nothing verified: that is verify's job.
      assert.strictEqual(restored?.deliveries[0]?.verifiedAt, null);
      const text = yield* fs.readFileString(codex!.path);
      yield* fs.writeFileString(codex!.path, text.replace("First.", "Edited."));
      const drifted = (yield* policies.listWithStatus(local)).find((policy) => policy.key === key);
      assert.strictEqual(
        drifted?.status.find((agent) => agent.agent === "codex")?.status,
        "drifted",
      );
      yield* fs.writeFileString(codex!.path, text);
    }),
  );

  it.effect("two installs at once into one file keep both blocks", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const fs = yield* FileSystem.FileSystem;
      const local = ProjectId.make("project-concurrent");
      for (const key of ["one", "two"]) {
        yield* policies.create({ projectId: local, key, title: key, body: `Policy ${key}.` });
        yield* policies.accept({ projectId: local, key, version: 1 });
      }
      const install = (key: string) =>
        policies.install({ projectId: local, key, agents: ["claude"] });
      const [[one]] = yield* Effect.all([install("one"), install("two")], {
        concurrency: "unbounded",
      });
      const text = yield* fs.readFileString(one!.path);
      assert.include(text, "<!-- fork-policy:start key=project-concurrent/one -->");
      assert.include(text, "<!-- fork-policy:start key=project-concurrent/two -->");
    }),
  );

  it.effect("each agent's file follows its default instance's environment over the server's", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const targetsWith = (settings: Parameters<typeof ServerSettings.layerTest>[0]) =>
        InstructionBlocks.targets().pipe(
          Effect.provide(ServerSettings.layerTest(settings)),
          Effect.provideService(HostProcess.Environment, {
            CLAUDE_CONFIG_DIR: path.join(home, "host-claude"),
            CODEX_HOME: path.join(home, "host-codex"),
            COPILOT_HOME: path.join(home, "host-copilot"),
          }),
        );
      const instance = (driver: string, name: string, value: string, config: object = {}) => ({
        [ProviderInstanceId.make(driver)]: {
          driver: ProviderDriverKind.make(driver),
          environment: [{ name, value, sensitive: false }],
          config,
        },
      });

      assert.deepStrictEqual(yield* targetsWith({}), {
        claude: path.join(home, "host-claude", "CLAUDE.md"),
        codex: path.join(home, "host-codex", "AGENTS.md"),
        copilot: path.join(home, "host-copilot", "copilot-instructions.md"),
      });
      assert.deepStrictEqual(
        yield* targetsWith({
          providerInstances: {
            ...instance("claudeAgent", "CLAUDE_CONFIG_DIR", "~/instance-claude"),
            ...instance("codex", "CODEX_HOME", "~/instance-codex"),
            ...instance("copilot", "COPILOT_HOME", "~/instance-copilot"),
          },
        }),
        {
          claude: path.join(home, "instance-claude", "CLAUDE.md"),
          codex: path.join(home, "instance-codex", "AGENTS.md"),
          copilot: path.join(home, "instance-copilot", "copilot-instructions.md"),
        },
      );
      // Codex's own homePath outranks CODEX_HOME, as it does for the driver.
      assert.strictEqual(
        (yield* targetsWith({
          providerInstances: instance("codex", "CODEX_HOME", "~/instance-codex", {
            homePath: "~/codex-config",
          }),
        })).codex,
        path.join(home, "codex-config", "AGENTS.md"),
      );
    }),
  );

  it.effect("a fork-policy marker in RULES.md refuses the install and writes nothing", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const home = yield* HostProcess.HomeDirectory;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const rulesPath = path.join(stateDir, "RULES.md");
      const claudeFile = path.join(home, "claude-config", "CLAUDE.md");
      const codexFile = path.join(home, ".codex", "AGENTS.md");
      const local = ProjectId.make("project-rules");
      yield* fs.writeFileString(claudeFile, "# Claude\n");
      yield* fs.writeFileString(codexFile, "# Codex\n");
      yield* fs.writeFileString(rulesPath, "Be kind.\n<!-- fork-policy:end key=x -->\n");
      yield* policies.create({ projectId: local, key: "rules", title: "Rules", body: "Body." });
      yield* policies.accept({ projectId: local, key: "rules", version: 1 });

      const error = yield* Effect.flip(policies.install({ projectId: local, key: "rules" }));
      assert.deepStrictEqual(
        [error.code, error.message],
        [
          "invalid",
          `${rulesPath} cannot contain "fork-policy:". Remove that marker and install again.`,
        ],
      );
      assert.strictEqual(yield* fs.readFileString(claudeFile), "# Claude\n");
      assert.strictEqual(yield* fs.readFileString(codexFile), "# Codex\n");
      assert.deepStrictEqual(
        yield* sql`SELECT agent FROM deliveries WHERE project_id = ${local}`,
        [],
      );
      yield* fs.remove(rulesPath);
    }),
  );

  it.effect("list reads each instruction file once however many policies it holds", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const claudeFile = path.join(home, "claude-config", "CLAUDE.md");
      const codexFile = path.join(home, ".codex", "AGENTS.md");
      const local = ProjectId.make("project-reads");
      const keys = ["alpha", "beta", "gamma"];
      for (const key of keys) {
        yield* policies.create({ projectId: local, key, title: key, body: `Reads ${key}.` });
        yield* policies.accept({ projectId: local, key, version: 1 });
        yield* policies.install({ projectId: local, key, agents: ["claude", "codex"] });
      }

      reads.length = 0;
      const listed = yield* policies.listWithStatus(local);

      assert.strictEqual(reads.filter((file) => file === claudeFile).length, 1);
      assert.strictEqual(reads.filter((file) => file === codexFile).length, 1);
      for (const key of keys) {
        assert.deepStrictEqual(
          listed
            .find((policy) => policy.key === key)
            ?.status.map((agent) => [agent.agent, agent.status]),
          [
            ["claude", "ok"],
            ["codex", "ok"],
            ["copilot", "missing"],
          ],
        );
      }
    }),
  );

  it.effect("a delivery of another version than the accepted one lists as outdated", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const codexFile = path.join(home, ".codex", "AGENTS.md");
      const local = ProjectId.make("project-outdated");
      const key = "stale";
      const codexStatus = Effect.map(
        policies.listWithStatus(local),
        (listed) =>
          listed
            .find((policy) => policy.key === key)
            ?.status.find((agent) => agent.agent === "codex")?.status,
      );

      yield* policies.create({ projectId: local, key, title: "Stale", body: "Outdated one." });
      yield* policies.accept({ projectId: local, key, version: 1 });
      yield* policies.install({ projectId: local, key, agents: ["codex"] });
      assert.strictEqual(yield* codexStatus, "ok");

      // Version 2 is accepted but not delivered: the file still holds version 1, intact.
      yield* policies.create({ projectId: local, key, title: "Stale", body: "Outdated two." });
      yield* policies.accept({ projectId: local, key, version: 2 });
      assert.strictEqual(yield* codexStatus, "outdated");
      // verify still answers whether the block is what was installed.
      assert.strictEqual(
        (yield* policies.verify({ projectId: local, key, agents: ["codex"] }))[0]?.status,
        "ok",
      );

      // A hand edit is reported over the older version.
      const text = yield* fs.readFileString(codexFile);
      yield* fs.writeFileString(codexFile, text.replace("Outdated one.", "Edited by hand."));
      assert.strictEqual(yield* codexStatus, "drifted");

      yield* policies.install({ projectId: local, key, agents: ["codex"] });
      assert.strictEqual(yield* codexStatus, "ok");
      // Restoring version 1 leaves version 2 in the file, which is not the accepted one either.
      yield* policies.accept({ projectId: local, key, version: 1 });
      assert.strictEqual(yield* codexStatus, "outdated");
    }),
  );

  it.effect("list gives a key held by the environment and a project each its own rows", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const local = ProjectId.make("project-same-key");
      const key = "shared";
      // The environment's policy has one version and a delivery; the project's has two and none.
      yield* policies.create({ projectId, key, title: "Wide", body: "Same key, environment." });
      yield* policies.accept({ projectId, key, version: 1 });
      yield* policies.install({ projectId, key, agents: ["codex"] });
      yield* policies.create({ projectId: local, key, title: "Local", body: "Same key, project." });
      yield* policies.create({ projectId: local, key, title: "Local", body: "Same key, again." });

      const listed = yield* policies.list(local);
      const of = (owner: ProjectId) =>
        listed.find((policy) => policy.projectId === owner && policy.key === key);
      assert.deepStrictEqual(
        of(projectId)?.versions.map((version) => version.version),
        [1],
      );
      assert.deepStrictEqual(
        of(projectId)?.deliveries.map((delivery) => delivery.agent),
        ["codex"],
      );
      assert.deepStrictEqual(
        of(local)?.versions.map((version) => version.version),
        [1, 2],
      );
      assert.deepStrictEqual(of(local)?.deliveries, []);
    }),
  );

  it.effect("list reads no instruction file, so one that cannot be read does not fail it", () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const claudeFile = path.join(home, "claude-config", "CLAUDE.md");
      const local = ProjectId.make("project-unreadable");
      const key = "locked";
      yield* policies.create({ projectId: local, key, title: "Locked", body: "Locked in." });
      yield* policies.accept({ projectId: local, key, version: 1 });
      yield* policies.install({ projectId: local, key, agents: ["claude"] });

      // A directory where the delivered file was: it exists and cannot be read as text.
      const text = yield* fs.readFileString(claudeFile);
      yield* fs.remove(claudeFile);
      yield* fs.makeDirectory(claudeFile);
      yield* Effect.gen(function* () {
        reads.length = 0;
        const listed = yield* policies.list(local);
        assert.deepStrictEqual(reads, []);
        assert.deepStrictEqual(
          listed.find((policy) => policy.key === key)?.deliveries.map((delivery) => delivery.agent),
          ["claude"],
        );
        const error = yield* Effect.flip(policies.listWithStatus(local));
        assert.deepStrictEqual(
          [error.code, error.message],
          ["io", "Could not read an instruction file."],
        );
      }).pipe(
        Effect.ensuring(
          Effect.orDie(
            Effect.andThen(
              fs.remove(claudeFile, { recursive: true }),
              fs.writeFileString(claudeFile, text),
            ),
          ),
        ),
      );
    }),
  );

  it.effect(
    "a delivery into a file the agent no longer reads lists as missing where it reads now",
    () =>
      Effect.gen(function* () {
        const policies = yield* PolicyService.PolicyService;
        const path = yield* Path.Path;
        const home = yield* HostProcess.HomeDirectory;
        const codexFile = path.join(home, ".codex", "AGENTS.md");
        const movedFile = path.join(home, "codex-moved", "AGENTS.md");
        const local = ProjectId.make("project-moved");
        const key = "moved";
        yield* policies.create({
          projectId: local,
          key,
          title: "Moved",
          body: "Where Codex reads.",
        });
        yield* policies.accept({ projectId: local, key, version: 1 });
        yield* policies.install({ projectId: local, key, agents: ["codex"] });

        // What the list and verify say of Codex, from whichever service is in context.
        const codexNow = Effect.gen(function* () {
          const service = yield* PolicyService.PolicyService;
          const listed = yield* service.listWithStatus(local);
          const [verified] = yield* service.verify({ projectId: local, key, agents: ["codex"] });
          return {
            listed: listed
              .find((policy) => policy.key === key)
              ?.status.find((agent) => agent.agent === "codex"),
            verified,
          };
        });
        const where = (file: string, status: "ok" | "missing") => {
          const found = status === "ok";
          return {
            agent: "codex" as const,
            status,
            path: file,
            blockMatches: found,
            rulesCurrent: found,
          };
        };
        assert.deepStrictEqual(yield* codexNow, {
          listed: where(codexFile, "ok"),
          verified: where(codexFile, "ok"),
        });

        // Codex's home moves: the same database, settings that point Codex somewhere else.
        // Fresh, or the test's own memoized service would answer instead.
        const movedHome = Layer.fresh(PolicyService.layer).pipe(
          Layer.provide(
            ServerSettings.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: "~/claude-config" },
                },
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: "~/codex-moved" },
                },
              },
            }),
          ),
        );
        assert.deepStrictEqual(yield* codexNow.pipe(Effect.provide(movedHome)), {
          listed: where(movedFile, "missing"),
          verified: where(movedFile, "missing"),
        });
      }),
  );
});
