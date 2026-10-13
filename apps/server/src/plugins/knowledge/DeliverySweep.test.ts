import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as Attention from "../Attention.ts";
import * as HostDatabase from "../HostDatabase.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as DeliverySweep from "./DeliverySweep.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";
import { onHost, projectId, shell, world } from "./testkit.ts";

/** The sweep built inside the layer, over the same store and file system the test reads. */
class Sweep extends Context.Service<Sweep, Effect.Success<typeof DeliverySweep.make>>()(
  "t3/plugins/knowledge/DeliverySweep.test/Sweep",
) {}

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

const layerTest = onHost(
  Layer.effect(Sweep, DeliverySweep.make).pipe(Layer.provideMerge(layerAttention)),
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

/** Every attention flag, open or cleared, oldest first. */
const flags = Effect.gen(function* () {
  const host = yield* HostDatabase.HostDatabase;
  return yield* host<FlagRow>`SELECT id, plugin_id, thread_id, kind, text, resume_action, raised_at, cleared_at FROM attention ORDER BY id`;
});

/** The open flags as the strip would list them: key, then text. */
const openFlags = Effect.map(flags, (rows) =>
  rows.filter((flag) => flag.cleared_at === null).map((flag) => [flag.thread_id, flag.text]),
);

/** Proposes a page as a person and accepts it, which installs it for the agents in use now. */
const accepted = Effect.fn("accepted")(function* (key: string, title: string) {
  const store = yield* KnowledgeStore.KnowledgeStore;
  const draft = yield* store.propose({ projectId, key, title, body: "Body." }, { kind: "person" });
  return yield* store.accept({ id: draft.id });
});

it.effect(
  "installs only at a session boundary, and a tick with nothing changed writes nothing",
  () =>
    Effect.gen(function* () {
      const sweep = yield* Sweep;
      const w = yield* world;
      const tick = (dryRun = false) => sweep.run({ dryRun });

      assert.deepStrictEqual(yield* tick(), { examined: 0, acted: 0, flags: 0 });
      yield* accepted("tests", "Running the tests");
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });

      // Codex comes into use; its file waits while any thread of the project has a run.
      yield* w.useCodex;
      for (const run of ["running", "waiting"] as const) {
        yield* w.setThreads([shell("busy", run), shell("quiet", "none")]);
        const held = yield* w.writing(tick());
        assert.deepStrictEqual(held.value, { examined: 1, acted: 0, flags: 0 });
        assert.deepStrictEqual(held.writes, []);
        assert.isFalse(yield* w.fs.exists(w.codexFile));
      }

      yield* w.setThreads([shell("busy", "none"), shell("quiet", "none")]);
      const dry = yield* w.writing(tick(true));
      assert.deepStrictEqual(dry.value, { examined: 1, acted: 1, flags: 0 });
      assert.deepStrictEqual(dry.writes, []);
      assert.isFalse(yield* w.fs.exists(w.codexFile));

      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
      assert.include(
        yield* w.fs.readFileString(w.codexFile),
        "- .knowledge/tests.md: Running the tests\n",
      );
      const idle = yield* w.writing(tick());
      assert.deepStrictEqual(idle.value, { examined: 1, acted: 0, flags: 0 });
      assert.deepStrictEqual(idle.writes, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("with no agent in use, a page write that failed after accepting is retried", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const sweep = yield* Sweep;
    const w = yield* world;
    yield* w.dropClaude;
    // A file where the knowledge directory goes makes every page write fail.
    yield* w.fs.writeFileString(w.pagesDirectory, "");
    const draft = yield* store.propose(
      { projectId, key: "tests", title: "Running the tests", body: "Body." },
      { kind: "person" },
    );
    const refused = yield* Effect.flip(store.accept({ id: draft.id }));
    assert.include(refused.message, 'Page "tests" is accepted, but the install failed:');
    assert.deepStrictEqual(yield* sweep.run({ dryRun: false }), {
      examined: 1,
      acted: 0,
      flags: 1,
    });

    yield* w.fs.remove(w.pagesDirectory);
    assert.deepStrictEqual(yield* sweep.run({ dryRun: false }), {
      examined: 1,
      acted: 1,
      flags: 0,
    });
    assert.strictEqual(
      yield* w.fs.readFileString(w.page("tests")),
      "# Running the tests\n\nBody.\n",
    );
    assert.isFalse(yield* w.fs.exists(w.claudeFile));
    assert.deepStrictEqual(yield* sweep.run({ dryRun: false }), {
      examined: 1,
      acted: 0,
      flags: 0,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "leaves a hand edit or a damaged block for a person, and catches up once the file is restored",
  () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeStore.KnowledgeStore;
      const sweep = yield* Sweep;
      const w = yield* world;
      const tick = () => sweep.run({ dryRun: false });
      yield* accepted("tests", "Running the tests");

      const installed = yield* w.fs.readFileString(w.claudeFile);
      yield* w.fs.writeFileString(w.claudeFile, installed.replace("Running", "Skipping"));
      // The edit is left alone and flagged.
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });
      assert.strictEqual((yield* store.verify({ projectId }))[0]?.status, "drifted");

      // A second start marker damages the block, so the next acceptance cannot install. The
      // sweep writes the new page and leaves the damaged file to a person.
      const damaged = `${installed}<!-- fork-knowledge:start key=index -->\n`;
      yield* w.fs.writeFileString(w.claudeFile, damaged);
      const draft = yield* store.propose(
        { projectId, key: "db", title: "The database", body: "Body." },
        { kind: "person" },
      );
      assert.strictEqual((yield* Effect.flip(store.accept({ id: draft.id }))).code, "invalid");
      assert.isFalse(yield* w.fs.exists(w.page("db")));
      // The page is written; the damaged block is the same drift as the edit before it, one flag still.
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });
      assert.isTrue(yield* w.fs.exists(w.page("db")));
      assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), damaged);
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 1 });

      // Restored to what was last delivered, the block is the sweep's to bring up to date, and the flag clears.
      yield* w.fs.writeFileString(w.claudeFile, installed);
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 2, flags: 0 });
      assert.include(
        yield* w.fs.readFileString(w.claudeFile),
        "- .knowledge/db.md: The database\n",
      );
      assert.deepStrictEqual(
        (yield* store.verify({ projectId })).map((result) => result.status),
        ["ok"],
      );
      assert.deepStrictEqual(yield* openFlags, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a new agent gets its block while a hand-edited page and block stay as a person left them",
  () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeStore.KnowledgeStore;
      const sweep = yield* Sweep;
      const w = yield* world;
      const tick = () => sweep.run({ dryRun: false });
      yield* accepted("tests", "Running the tests");

      const page = "# Running the tests\n\nBody, and a note of mine.\n";
      yield* w.fs.writeFileString(w.page("tests"), page);
      const block = (yield* w.fs.readFileString(w.claudeFile)).replace("Running", "Skipping");
      yield* w.fs.writeFileString(w.claudeFile, block);

      yield* w.useCodex;
      const caught = yield* w.writing(tick());
      // Codex's file is written, and the page and Claude's block are flagged, not written.
      assert.deepStrictEqual(caught.value, { examined: 1, acted: 3, flags: 2 });
      // Every file call is the atomic write of Codex's file; the page and Claude's file are untouched.
      assert.isNotEmpty(caught.writes);
      for (const call of caught.writes) assert.include(call, ` ${w.codexFile}`);
      assert.include(
        yield* w.fs.readFileString(w.codexFile),
        "- .knowledge/tests.md: Running the tests\n",
      );
      assert.strictEqual(yield* w.fs.readFileString(w.page("tests")), page);
      assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), block);
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 2 });

      // A person's install is the one that repairs both, and the next tick clears both flags.
      yield* store.install({ projectId });
      assert.strictEqual(
        yield* w.fs.readFileString(w.page("tests")),
        "# Running the tests\n\nBody.\n",
      );
      assert.deepStrictEqual(
        (yield* store.verify({ projectId })).map((result) => result.status),
        ["ok", "ok"],
      );
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 2, flags: 0 });
      assert.deepStrictEqual(yield* openFlags, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a deleted page raises a removed flag once, and installing clears it", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const sweep = yield* Sweep;
    const w = yield* world;
    const tick = (dryRun = false) => sweep.run({ dryRun });
    yield* accepted("tests", "Running the tests");
    assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });

    yield* w.fs.remove(w.page("tests"));
    const dry = yield* tick(true);
    assert.deepStrictEqual(dry, { examined: 1, acted: 1, flags: 1 });
    assert.deepStrictEqual(yield* flags, []);

    // The page is not written back; the flag names it and its file.
    const raised = yield* w.writing(tick());
    assert.deepStrictEqual(raised.value, { examined: 1, acted: 1, flags: 1 });
    assert.deepStrictEqual(raised.writes, []);
    assert.isFalse(yield* w.fs.exists(w.page("tests")));
    const [flag, ...rest] = yield* flags;
    assert.deepStrictEqual(rest, []);
    assert.deepStrictEqual(
      [flag?.plugin_id, flag?.thread_id, flag?.kind, flag?.text, flag?.cleared_at],
      [
        "knowledge",
        `knowledge:${projectId}:page:tests:${w.page("tests")}`,
        "delivery_drift",
        `The knowledge page "tests" in ${w.page("tests")} was removed outside T3 Code; reinstall to restore it.`,
        null,
      ],
    );
    assert.deepStrictEqual(JSON.parse(flag?.resume_action ?? ""), {
      label: "Reinstall",
      target: "settings",
    });

    // A second tick, and one with a run on the project, leave the flag row alone.
    const before = yield* flags;
    yield* w.setThreads([shell("busy", "running")]);
    assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 1 });
    assert.deepStrictEqual(yield* flags, before);

    yield* store.install({ projectId });
    assert.deepStrictEqual(yield* tick(true), { examined: 1, acted: 1, flags: 0 });
    assert.strictEqual((yield* openFlags).length, 1);
    assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
    assert.deepStrictEqual(yield* openFlags, []);
    assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the index block edited, then its file deleted, is one flag whose text follows", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const sweep = yield* Sweep;
    const w = yield* world;
    const tick = () => sweep.run({ dryRun: false });
    yield* accepted("tests", "Running the tests");

    yield* w.fs.writeFileString(
      w.claudeFile,
      (yield* w.fs.readFileString(w.claudeFile)).replace("Running", "Skipping"),
    );
    assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });
    const [first] = yield* flags;
    assert.strictEqual(first?.thread_id, `knowledge:${projectId}:claude:${w.claudeFile}`);
    assert.strictEqual(
      first?.text,
      `The knowledge index in ${w.claudeFile} was edited outside T3 Code; reinstall to restore it.`,
    );

    yield* w.fs.remove(w.claudeFile);
    assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });
    const [rewritten, ...rest] = yield* flags;
    assert.deepStrictEqual(rest, []);
    assert.strictEqual(rewritten?.id, first?.id);
    assert.strictEqual(
      rewritten?.text,
      `The knowledge index in ${w.claudeFile} was removed outside T3 Code; reinstall to restore it.`,
    );
    assert.isFalse(yield* w.fs.exists(w.claudeFile));

    yield* store.install({ projectId });
    assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
    assert.deepStrictEqual(yield* openFlags, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a flag leaves with the thing it was about: a retired page, an agent no longer in use",
  () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeStore.KnowledgeStore;
      const sweep = yield* Sweep;
      const w = yield* world;
      const tick = () => sweep.run({ dryRun: false });
      const tests = yield* accepted("tests", "Running the tests");
      yield* accepted("db", "The database");
      yield* w.fs.remove(w.page("tests"));
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });

      // Retiring the page takes it out of the install; its flag has nothing left to be about.
      yield* store.retire({ id: tests.id });
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
      assert.deepStrictEqual(yield* openFlags, []);

      // Reinstall can only fix the files of agents in use, so an agent that is not has no flag.
      yield* w.fs.writeFileString(
        w.claudeFile,
        (yield* w.fs.readFileString(w.claudeFile)).replace("The database", "Another"),
      );
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });
      yield* w.dropClaude;
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
      assert.deepStrictEqual(yield* openFlags, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a page file that cannot be read keeps the flag it had", () =>
  Effect.gen(function* () {
    const sweep = yield* Sweep;
    const w = yield* world;
    const tick = () => sweep.run({ dryRun: false });
    yield* accepted("tests", "Running the tests");
    yield* w.fs.remove(w.page("tests"));
    assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 1 });
    const before = yield* flags;

    // A directory where the page was cannot be read.
    yield* w.fs.makeDirectory(w.page("tests"));
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(...(Array.isArray(message) ? message : [message]));
    });
    const unread = yield* tick().pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    // The catch-up cannot compare the page either, which counts as a flag of its own.
    assert.deepStrictEqual(unread, { examined: 1, acted: 0, flags: 2 });
    assert.include(messages, "knowledge delivery: could not check for edits");
    assert.deepStrictEqual(yield* flags, before);
  }).pipe(Effect.provide(layerTest)),
);
