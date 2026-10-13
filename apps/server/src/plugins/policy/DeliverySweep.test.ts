import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  POLICY_ENVIRONMENT_PROJECT_ID,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Attention from "../Attention.ts";
import * as HostDatabase from "../HostDatabase.ts";
import { sha256 } from "../InstructionBlocks.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as DeliverySweep from "./DeliverySweep.ts";
import { plugin } from "./index.ts";
import * as Files from "./InstructionFiles.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";

const everywhere = POLICY_ENVIRONMENT_PROJECT_ID;
const alpha = ProjectId.make("alpha");
const beta = ProjectId.make("beta");

type Shells = ReadonlyArray<ReturnType<typeof shell>>;

/** The threads the mocked server reports; a test sets them to put a run on a project. */
class Threads extends Context.Service<Threads, Ref.Ref<Shells>>()(
  "t3/plugins/policy/DeliverySweep.test/Threads",
) {}

/** The sweep built inside the layer, so it reads and writes through the same file system as `PolicyService`. */
class Sweep extends Context.Service<Sweep, Effect.Success<typeof DeliverySweep.make>>()(
  "t3/plugins/policy/DeliverySweep.test/Sweep",
) {}

/** Every file read and write made through the layers below it, as `read <path>` and `write <path>`. */
class FileCalls extends Context.Service<FileCalls, Ref.Ref<ReadonlyArray<string>>>()(
  "t3/plugins/policy/DeliverySweep.test/FileCalls",
) {}

const shell = (projectId: ProjectId, id: string, run: "none" | "running" | "waiting") => ({
  ...liveThreadShell(ThreadId.make(id), {
    activeRunId: run === "running" ? RunId.make(`run:${id}`) : null,
  }),
  projectId,
  // A run waiting on the user has no `activeRunId`; only its activity status shows it.
  ...(run === "waiting" ? { activityRunStatus: "waiting" as const } : {}),
});

const layerThreads = Layer.unwrap(
  Effect.map(Ref.make<Shells>([]), (threads) =>
    Layer.merge(
      Layer.succeed(Threads, threads),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getShellSnapshot: () =>
          Effect.map(Ref.get(threads), (all) => ({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: all,
            archivedThreads: [],
          })),
        listProjectThreads: ({ projectId }) =>
          Effect.map(Ref.get(threads), (all) =>
            all.filter((thread) => thread.projectId === projectId),
          ),
      }),
    ),
  ),
);

const layerFileCalls = Layer.unwrap(
  Effect.map(Ref.make<ReadonlyArray<string>>([]), (calls) => {
    const note = (call: string) => Ref.update(calls, (all) => [...all, call]);
    return Layer.merge(
      Layer.succeed(FileCalls, calls),
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          readFileString: (...args: Parameters<typeof fs.readFileString>) =>
            Effect.andThen(note(`read ${args[0]}`), fs.readFileString(...args)),
          writeFileString: (...args: Parameters<typeof fs.writeFileString>) =>
            Effect.andThen(note(`write ${args[0]}`), fs.writeFileString(...args)),
        })),
      ),
    );
  }),
).pipe(Layer.provide(NodeServices.layer));

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

/** The host's attention flags over a migrated in-memory host database. */
const layerAttention = Attention.layer.pipe(
  Layer.provideMerge(
    Layer.effect(
      HostDatabase.HostDatabase,
      Effect.map(
        PluginDatabase.open({
          id: "_host",
          filename: ":memory:",
          migrations: HostDatabase.migrations,
        }),
        (opened) => opened.sql,
      ),
    ),
  ),
);

interface FlagRow {
  readonly id: number;
  readonly plugin_id: string;
  readonly thread_id: string;
  readonly kind: string;
  readonly text: string;
  readonly resume_action: string;
  readonly raised_at: string;
  readonly cleared_at: string | null;
}

/** `layer` over a temp home, an in-memory database, the mocked threads and the counted file system. */
const onHost = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provideMerge(layerDatabase),
    Layer.provideMerge(layerAttention),
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
    Layer.provideMerge(layerThreads),
    Layer.provideMerge(layerFileCalls),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-policy-sweep-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const layerTest = onHost(
  Layer.effect(Sweep, DeliverySweep.make).pipe(Layer.provideMerge(PolicyService.layer)),
);

/** What the sweep logs while `effect` runs, flattened to the message and its attached objects. */
const logged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(...(Array.isArray(message) ? message : [message]));
    });
    const value = yield* effect.pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    return { value, messages };
  });

/** Creates and accepts version 1 of a policy. */
const accepted = Effect.fn("accepted")(function* (projectId: ProjectId, key: string, body: string) {
  const policies = yield* PolicyService.PolicyService;
  yield* policies.create({ projectId, key, title: key, body });
  yield* policies.accept({ projectId, key, version: 1 });
});

/** Everything the tests look at: the sweep, the agents' files, the delivery rows and the file calls. */
const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const home = yield* HostProcess.HomeDirectory;
  const threads = yield* Threads;
  const calls = yield* FileCalls;
  const sweep = yield* Sweep;
  const host = yield* HostDatabase.HostDatabase;
  const rulesPath = yield* Files.rulesPath();
  const claudeFile = path.join(home, "claude-config", "CLAUDE.md");
  const codexFile = path.join(home, ".codex", "AGENTS.md");
  return {
    fs,
    claudeFile,
    codexFile,
    rulesPath,
    setThreads: (shells: Shells) => Ref.set(threads, shells),
    run: (dryRun = false) => sweep.run({ dryRun }),
    /** What a person does by hand to an instruction file. */
    edit: (file: string, change: (text: string) => string) =>
      Effect.flatMap(fs.readFileString(file), (text) => fs.writeFileString(file, change(text))),
    /** Every attention flag, open or cleared, oldest first. */
    flags: host<FlagRow>`SELECT id, plugin_id, thread_id, kind, text, resume_action, raised_at, cleared_at FROM attention ORDER BY id`,
    /** The file calls the sweep makes while `effect` runs. */
    calling: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        yield* Ref.set(calls, []);
        const value = yield* effect;
        return { value, calls: yield* Ref.get(calls) };
      }),
    deliveries: sql<{
      readonly project_id: string;
      readonly key: string;
      readonly agent: string;
      readonly version: number;
      readonly rules_hash: string;
      readonly verified_at: string | null;
    }>`SELECT project_id, "key", agent, version, rules_hash, verified_at FROM deliveries ORDER BY project_id, "key", agent`,
  };
});

it.effect(
  "installs and verifies accepted policies in one call, and the next tick only reads RULES.md",
  () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const w = yield* world;
      yield* w.fs.writeFileString(w.rulesPath, "Be kind.\n");
      yield* accepted(everywhere, "review", "Run the tests.");
      // A draft is never installed, and a newer draft does not displace the accepted version.
      yield* policies.create({ projectId: everywhere, key: "wip", title: "wip", body: "Not yet." });
      yield* accepted(everywhere, "evolving", "Old.");
      yield* policies.create({
        projectId: everywhere,
        key: "evolving",
        title: "evolving",
        body: "New.",
      });
      yield* policies.accept({ projectId: everywhere, key: "evolving", version: 2 });
      yield* policies.create({
        projectId: everywhere,
        key: "evolving",
        title: "evolving",
        body: "Draft.",
      });

      // Two accepted policies, and the two agents whose directory exists.
      assert.deepStrictEqual(yield* w.run(), { examined: 4, acted: 4, flags: 0 });
      for (const file of [w.claudeFile, w.codexFile]) {
        const text = yield* w.fs.readFileString(file);
        assert.include(text, "<!-- fork-policy:start key=review -->");
        assert.include(text, "\nBe kind.\n\nRun the tests.\n");
        assert.include(text, "<!-- fork-policy:start key=evolving -->");
        assert.include(text, "version=2 -->");
        assert.include(text, "\nBe kind.\n\nNew.\n");
        assert.notInclude(text, "wip");
        assert.notInclude(text, "Old.");
        assert.notInclude(text, "Draft.");
      }
      const rows = yield* w.deliveries;
      assert.deepStrictEqual(
        rows.map((row) => [
          row.key,
          row.agent,
          row.version,
          row.rules_hash === sha256("Be kind.\n"),
        ]),
        [
          ["evolving", "claude", 2, true],
          ["evolving", "codex", 2, true],
          ["review", "claude", 1, true],
          ["review", "codex", 1, true],
        ],
      );
      assert.isTrue(rows.every((row) => typeof row.verified_at === "string"));

      const idle = yield* w.calling(w.run());
      assert.deepStrictEqual(idle.value, { examined: 4, acted: 0, flags: 0 });
      assert.deepStrictEqual(
        idle.calls.filter((call) => call.startsWith("write ") || call.includes("RULES.md")),
        [`read ${w.rulesPath}`],
      );
      assert.deepStrictEqual(yield* w.deliveries, rows);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run on the project holds its policy back, silently, until the run has ended", () =>
  Effect.gen(function* () {
    const w = yield* world;
    yield* accepted(alpha, "review", "Run the tests.");

    for (const run of ["running", "waiting"] as const) {
      yield* w.setThreads([shell(alpha, "busy", run), shell(alpha, "quiet", "none")]);
      const held = yield* logged(w.calling(w.run()));
      assert.deepStrictEqual(held.value.value, { examined: 2, acted: 0, flags: 0 });
      assert.deepStrictEqual(held.messages, []);
      assert.deepStrictEqual(
        held.value.calls.filter((call) => call.startsWith("write ")),
        [],
      );
      assert.isFalse(yield* w.fs.exists(w.claudeFile));
      assert.isFalse(yield* w.fs.exists(w.codexFile));
      assert.deepStrictEqual(yield* w.deliveries, []);
    }

    yield* w.setThreads([shell(alpha, "busy", "none"), shell(alpha, "quiet", "none")]);
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 2, flags: 0 });
    assert.include(yield* w.fs.readFileString(w.claudeFile), "key=alpha/review");
    assert.isTrue((yield* w.deliveries).every((row) => row.verified_at !== null));
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 0, flags: 0 });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a run elsewhere does not block a project's policy, and a run anywhere blocks a * policy",
  () =>
    Effect.gen(function* () {
      const w = yield* world;
      yield* accepted(alpha, "local", "Alpha only.");
      yield* accepted(beta, "local", "Beta only.");
      yield* accepted(everywhere, "global", "Everywhere.");
      yield* w.setThreads([shell(alpha, "busy", "running"), shell(beta, "quiet", "none")]);

      // Only beta's policy installs: alpha has the run, and the run holds the * policy as well.
      assert.deepStrictEqual(yield* w.run(), { examined: 6, acted: 2, flags: 0 });
      assert.deepStrictEqual(
        (yield* w.deliveries).map((row) => [row.project_id, row.key, row.agent]),
        [
          ["beta", "local", "claude"],
          ["beta", "local", "codex"],
        ],
      );
      const claude = yield* w.fs.readFileString(w.claudeFile);
      assert.include(claude, "key=beta/local");
      assert.notInclude(claude, "alpha/local");
      assert.notInclude(claude, "key=global");

      yield* w.setThreads([shell(alpha, "busy", "none"), shell(beta, "quiet", "none")]);
      assert.deepStrictEqual(yield* w.run(), { examined: 6, acted: 4, flags: 0 });
      assert.strictEqual((yield* w.deliveries).length, 6);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("editing RULES.md reinstalls every accepted policy on the next tick", () =>
  Effect.gen(function* () {
    const w = yield* world;
    yield* accepted(alpha, "one", "First.");
    yield* accepted(everywhere, "two", "Second.");
    assert.deepStrictEqual(yield* w.run(), { examined: 4, acted: 4, flags: 0 });
    assert.deepStrictEqual(yield* w.run(), { examined: 4, acted: 0, flags: 0 });

    yield* w.fs.writeFileString(w.rulesPath, "Always be kind.\n");
    // The edit waits for the run to end like any other install.
    yield* w.setThreads([shell(alpha, "busy", "running")]);
    assert.deepStrictEqual(yield* w.run(), { examined: 4, acted: 0, flags: 0 });
    assert.deepStrictEqual(
      (yield* w.deliveries).map((row) => row.rules_hash === sha256("")),
      [true, true, true, true],
    );

    yield* w.setThreads([]);
    assert.deepStrictEqual(yield* w.run(), { examined: 4, acted: 4, flags: 0 });
    assert.isTrue(
      (yield* w.deliveries).every((row) => row.rules_hash === sha256("Always be kind.\n")),
    );
    assert.isTrue((yield* w.deliveries).every((row) => row.verified_at !== null));
    assert.include(yield* w.fs.readFileString(w.codexFile), "\nAlways be kind.\n\nFirst.\n");
    assert.deepStrictEqual(yield* w.run(), { examined: 4, acted: 0, flags: 0 });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a directory in place of one agent's file warns with its path, and the next tick retries",
  () =>
    Effect.gen(function* () {
      const w = yield* world;
      yield* accepted(alpha, "review", "Run the tests.");
      yield* w.fs.makeDirectory(w.claudeFile);

      const failed = yield* logged(w.run());
      // Claude's file cannot be read, and Codex's is delivered regardless.
      assert.deepStrictEqual(failed.value, { examined: 2, acted: 1, flags: 1 });
      assert.include(failed.messages, "policy delivery: install failed");
      assert.deepStrictEqual<ReadonlyArray<unknown>>(
        failed.messages.filter(
          (message) => typeof message === "object" && message !== null && "path" in message,
        ),
        [{ path: w.claudeFile, message: "Could not write an instruction file." }],
      );
      assert.deepStrictEqual(
        (yield* w.deliveries).map((row) => [row.agent, row.verified_at !== null]),
        [["codex", true]],
      );

      // The same again while the directory is still there, with no backoff.
      assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 0, flags: 1 });

      yield* w.fs.remove(w.claudeFile, { recursive: true });
      assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 1, flags: 0 });
      assert.deepStrictEqual(
        (yield* w.deliveries).map((row) => [row.agent, row.verified_at !== null]),
        [
          ["claude", true],
          ["codex", true],
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a failed verification leaves verified_at null and the next tick installs again", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const w = yield* world;
    yield* accepted(alpha, "review", "Run the tests.");

    // An install whose file is edited before the sweep reads it back.
    const tampering = PolicyService.PolicyService.of({
      ...policies,
      install: (input, beforeWrite) =>
        policies
          .install(input, beforeWrite)
          .pipe(
            Effect.tap((installed) =>
              Effect.forEach(installed, ({ path }) =>
                Effect.flatMap(fs.readFileString(path), (text) =>
                  fs.writeFileString(path, text.replace("Run the tests.", "Run nothing.")),
                ),
              ).pipe(Effect.orDie),
            ),
          ),
    });
    const sweep = yield* DeliverySweep.make.pipe(
      Effect.provideService(PolicyService.PolicyService, tampering),
    );
    const failed = yield* logged(sweep.run({ dryRun: false }));
    // Each tampered block fails its verification and, being edited, raises a drift flag as well.
    assert.deepStrictEqual(failed.value, { examined: 2, acted: 4, flags: 4 });
    assert.include(failed.messages, "policy delivery: the installed block is not there");
    assert.deepStrictEqual(
      yield* sql<{
        readonly agent: string;
        readonly verified_at: string | null;
      }>`SELECT agent, verified_at FROM deliveries ORDER BY agent`,
      [
        { agent: "claude", verified_at: null },
        { agent: "codex", verified_at: null },
      ],
    );

    // The install puts the blocks back, and the same tick clears both flags.
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 4, flags: 0 });
    assert.isTrue((yield* w.deliveries).every((row) => row.verified_at !== null));
    assert.include(yield* w.fs.readFileString(w.claudeFile), "Run the tests.");
    assert.isTrue((yield* w.flags).every((flag) => flag.cleared_at !== null));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a moved instruction file is delivered to again on the next tick", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const w = yield* world;
    yield* accepted(alpha, "review", "Run the tests.");
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 2, flags: 0 });
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 0, flags: 0 });

    // The agent's home changes after a verified delivery into the old one.
    const movedFile = path.join(home, "claude-moved", "CLAUDE.md");
    yield* w.fs.makeDirectory(path.dirname(movedFile));
    yield* settings.updateSettings({
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: "~/claude-moved" },
        },
      },
    });
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 1, flags: 0 });
    assert.include(yield* w.fs.readFileString(movedFile), "key=alpha/review");
    const claude = (yield* w.deliveries).find((row) => row.agent === "claude");
    assert.isNotNull(claude?.verified_at);
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 0, flags: 0 });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a run that starts while the install waits for its lock cancels the install", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const w = yield* world;
    yield* accepted(alpha, "review", "Run the tests.");
    yield* w.fs.writeFileString(w.claudeFile, "# Mine\n");

    // The run starts after the sweep's own check and before the install writes, as it can while
    // a manual install holds the lock.
    const late = PolicyService.PolicyService.of({
      ...policies,
      install: (input, beforeWrite) =>
        Effect.andThen(
          w.setThreads([shell(alpha, "late", "running")]),
          policies.install(input, beforeWrite),
        ),
    });
    const sweep = yield* DeliverySweep.make.pipe(
      Effect.provideService(PolicyService.PolicyService, late),
    );
    const held = yield* logged(w.calling(sweep.run({ dryRun: false })));
    assert.deepStrictEqual(held.value.value, { examined: 2, acted: 0, flags: 0 });
    assert.deepStrictEqual(held.messages, []);
    assert.deepStrictEqual(
      held.value.calls.filter((call) => call.startsWith("write ")),
      [],
    );
    assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), "# Mine\n");
    assert.isFalse(yield* w.fs.exists(w.codexFile));
    assert.deepStrictEqual(yield* w.deliveries, []);

    yield* w.setThreads([]);
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 2, flags: 0 });
    assert.include(yield* w.fs.readFileString(w.claudeFile), "key=alpha/review");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a dry run reports the installs it would make and writes nothing", () =>
  Effect.gen(function* () {
    const w = yield* world;
    yield* accepted(alpha, "held", "Held back.");
    yield* accepted(beta, "ready", "Ready.");
    yield* w.setThreads([shell(alpha, "busy", "running")]);

    const dry = yield* w.calling(w.run(true));
    assert.deepStrictEqual(dry.value, { examined: 4, acted: 2, flags: 0 });
    assert.deepStrictEqual(
      dry.calls.filter((call) => call.startsWith("write ")),
      [],
    );
    assert.isFalse(yield* w.fs.exists(w.claudeFile));
    assert.isFalse(yield* w.fs.exists(w.codexFile));
    assert.deepStrictEqual(yield* w.deliveries, []);

    // The real run does what the dry one said.
    assert.deepStrictEqual(yield* w.run(), { examined: 4, acted: 2, flags: 0 });
  }).pipe(Effect.provide(layerTest)),
);

/** The open flags as the strip would list them: key, then text. */
const openFlags = (flags: ReadonlyArray<FlagRow>) =>
  flags.filter((flag) => flag.cleared_at === null).map((flag) => [flag.thread_id, flag.text]);

it.effect(
  "a block edited by hand raises one flag, a second tick adds nothing, and reinstalling clears it",
  () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const w = yield* world;
      yield* accepted(everywhere, "review", "Run the tests.");
      assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 2, flags: 0 });
      assert.deepStrictEqual(yield* w.flags, []);

      yield* w.edit(w.claudeFile, (text) => text.replace("Run the tests.", "Skip the tests."));
      // The edit is left as it is, and Codex's intact block raises nothing.
      const raised = yield* w.calling(w.run());
      assert.deepStrictEqual(raised.value, { examined: 2, acted: 1, flags: 1 });
      assert.deepStrictEqual(
        raised.calls.filter((call) => call.startsWith("write ")),
        [],
      );
      assert.include(yield* w.fs.readFileString(w.claudeFile), "Skip the tests.");
      const [flag, ...rest] = yield* w.flags;
      assert.deepStrictEqual(rest, []);
      assert.deepStrictEqual(
        [flag?.plugin_id, flag?.thread_id, flag?.kind, flag?.text, flag?.cleared_at],
        [
          "policy",
          `policy:${everywhere}:claude:${w.claudeFile}`,
          "delivery_drift",
          `The "review" policy block in ${w.claudeFile} was edited outside T3 Code; reinstall to restore it.`,
          null,
        ],
      );
      assert.deepStrictEqual(JSON.parse(flag?.resume_action ?? ""), {
        label: "Reinstall",
        target: "settings",
      });

      // The same again: the flag row is not touched.
      const before = yield* w.flags;
      assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 0, flags: 1 });
      assert.deepStrictEqual(yield* w.flags, before);

      // A reinstall is a person's; the next tick puts its own bookkeeping straight and clears the flag.
      yield* policies.install({ projectId: everywhere, key: "review" });
      assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 3, flags: 0 });
      assert.include(yield* w.fs.readFileString(w.claudeFile), "Run the tests.");
      const [cleared, ...others] = yield* w.flags;
      assert.deepStrictEqual(others, []);
      assert.strictEqual(cleared?.id, flag?.id);
      assert.isString(cleared?.cleared_at);
      assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 0, flags: 0 });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("an agent's directory that goes away is flagged as removed and never created again", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const path = yield* Path.Path;
    const w = yield* world;
    yield* accepted(alpha, "review", "Run the tests.");
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 2, flags: 0 });

    const codexDirectory = path.dirname(w.codexFile);
    yield* w.fs.remove(codexDirectory, { recursive: true });
    // Only Claude is in use now, so one pair is examined and the flag is the one action.
    assert.deepStrictEqual(yield* w.run(), { examined: 1, acted: 1, flags: 1 });
    assert.deepStrictEqual(openFlags(yield* w.flags), [
      [
        `policy:${alpha}:codex:${w.codexFile}`,
        `The "alpha/review" policy block in ${w.codexFile} was removed outside T3 Code; reinstall to restore it.`,
      ],
    ]);
    const before = yield* w.flags;
    assert.deepStrictEqual(yield* w.run(), { examined: 1, acted: 0, flags: 1 });
    assert.deepStrictEqual(yield* w.flags, before);
    assert.isFalse(yield* w.fs.exists(codexDirectory));

    yield* w.fs.makeDirectory(codexDirectory);
    yield* policies.install({ projectId: alpha, key: "review", agents: ["codex"] });
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 2, flags: 0 });
    assert.deepStrictEqual(openFlags(yield* w.flags), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a dry run counts the drift it finds and raises and clears nothing", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const w = yield* world;
    yield* accepted(alpha, "review", "Run the tests.");
    yield* w.run();
    const delivered = yield* w.deliveries;

    yield* w.edit(w.claudeFile, (text) => text.replace("Run the tests.", "Skip the tests."));
    const dry = yield* w.calling(w.run(true));
    assert.deepStrictEqual(dry.value, { examined: 2, acted: 1, flags: 1 });
    assert.deepStrictEqual(
      dry.calls.filter((call) => call.startsWith("write ")),
      [],
    );
    assert.deepStrictEqual(yield* w.flags, []);
    assert.deepStrictEqual(yield* w.deliveries, delivered);

    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 1, flags: 1 });
    assert.strictEqual(openFlags(yield* w.flags).length, 1);

    // The flag stands through a dry run that finds the cause gone.
    yield* policies.install({ projectId: alpha, key: "review" });
    assert.deepStrictEqual(yield* w.run(true), { examined: 2, acted: 3, flags: 0 });
    assert.strictEqual(openFlags(yield* w.flags).length, 1);
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 3, flags: 0 });
    assert.deepStrictEqual(openFlags(yield* w.flags), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "one flag per project and file names the project's blocks that changed, and follows them",
  () =>
    Effect.gen(function* () {
      const policies = yield* PolicyService.PolicyService;
      const w = yield* world;
      yield* accepted(alpha, "review", "Run the tests.");
      yield* accepted(alpha, "style", "Keep it short.");
      yield* accepted(beta, "other", "Mine.");
      assert.deepStrictEqual(yield* w.run(), { examined: 6, acted: 6, flags: 0 });

      // In alpha one block is edited and the other taken out of the file; beta's is edited too.
      yield* w.edit(w.claudeFile, (text) =>
        text
          .replace("Run the tests.", "Skip the tests.")
          .replace("Mine.", "Not mine.")
          .replace(
            /<!-- fork-policy:start key=alpha\/style -->[\s\S]*?<!-- fork-policy:end key=alpha\/style -->\n?/,
            "",
          ),
      );
      assert.deepStrictEqual(yield* w.run(), { examined: 6, acted: 2, flags: 2 });
      const [flag, other, ...rest] = yield* w.flags;
      assert.deepStrictEqual(rest, []);
      assert.deepStrictEqual(
        [flag?.thread_id, flag?.text],
        [
          `policy:${alpha}:claude:${w.claudeFile}`,
          `The "alpha/review" and "alpha/style" policy blocks in ${w.claudeFile} were edited or removed outside T3 Code; reinstall to restore them.`,
        ],
      );
      assert.deepStrictEqual(
        [other?.thread_id, other?.text],
        [
          `policy:${beta}:claude:${w.claudeFile}`,
          `The "beta/other" policy block in ${w.claudeFile} was edited outside T3 Code; reinstall to restore it.`,
        ],
      );

      // Putting one of alpha's back rewrites alpha's flag for the other and leaves beta's alone.
      yield* policies.install({ projectId: alpha, key: "review", agents: ["claude"] });
      assert.deepStrictEqual(yield* w.run(), { examined: 6, acted: 2, flags: 2 });
      const [rewritten, untouched, ...others] = yield* w.flags;
      assert.deepStrictEqual(others, []);
      assert.strictEqual(rewritten?.id, flag?.id);
      assert.isNull(rewritten?.cleared_at);
      assert.strictEqual(
        rewritten?.text,
        `The "alpha/style" policy block in ${w.claudeFile} was removed outside T3 Code; reinstall to restore it.`,
      );
      assert.deepStrictEqual(untouched, other);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run does not hold a flag back, and a block only waiting for a run is not drift", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const w = yield* world;
    yield* accepted(alpha, "review", "Run the tests.");
    yield* w.run();

    yield* w.setThreads([shell(alpha, "busy", "running")]);
    yield* policies.create({ projectId: alpha, key: "review", title: "review", body: "Newer." });
    yield* policies.accept({ projectId: alpha, key: "review", version: 2 });
    // Version 2 waits for the run to end while the files still hold version 1, as installed.
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 0, flags: 0 });
    assert.deepStrictEqual(yield* w.flags, []);

    yield* w.edit(w.codexFile, (text) => text.replace("Run the tests.", "Skip the tests."));
    assert.deepStrictEqual(yield* w.run(), { examined: 2, acted: 1, flags: 1 });
    assert.include(yield* w.fs.readFileString(w.codexFile), "Skip the tests.");
    assert.deepStrictEqual(
      openFlags(yield* w.flags).map(([key]) => key),
      [`policy:${alpha}:codex:${w.codexFile}`],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a file that cannot be read keeps the flag it had", () =>
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const w = yield* world;
    yield* accepted(alpha, "review", "Run the tests.");
    yield* w.run();
    yield* w.edit(w.claudeFile, (text) => text.replace("Run the tests.", "Skip the tests."));
    yield* w.run();
    const before = yield* w.flags;

    // A directory where the file was cannot be read.
    yield* w.fs.remove(w.claudeFile);
    yield* w.fs.makeDirectory(w.claudeFile);
    const unread = yield* logged(w.run());
    assert.deepStrictEqual(unread.value, { examined: 2, acted: 0, flags: 1 });
    assert.include(unread.messages, "policy delivery: could not read an instruction file");
    assert.deepStrictEqual(yield* w.flags, before);

    yield* w.fs.remove(w.claudeFile, { recursive: true });
    yield* policies.install({ projectId: alpha, key: "review" });
    yield* w.run();
    assert.deepStrictEqual(openFlags(yield* w.flags), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the plugin registers the sweep with the supervisor under its own name", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registered = yield* Ref.make<ReadonlyArray<string>>([]);
      const supervisor = Layer.mock(PluginSupervisor.PluginSupervisor)({
        register: (sweep) =>
          Ref.update(registered, (all) => [...all, `${sweep.plugin}/${sweep.name}`]),
      });
      yield* Layer.build(onHost(plugin.layer.pipe(Layer.provide(supervisor))));
      assert.deepStrictEqual(yield* Ref.get(registered), ["policy/delivery"]);
    }),
  ),
);
