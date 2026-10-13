import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DeliverySweep from "./DeliverySweep.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";
import { onHost, projectId, shell, world } from "./testkit.ts";

/** The sweep built inside the layer, over the same store and file system the test reads. */
class Sweep extends Context.Service<Sweep, Effect.Success<typeof DeliverySweep.make>>()(
  "t3/plugins/knowledge/DeliverySweep.test/Sweep",
) {}

const layerTest = onHost(Layer.effect(Sweep, DeliverySweep.make));

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
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });
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
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
      assert.isTrue(yield* w.fs.exists(w.page("db")));
      assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), damaged);
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });

      // Restored to what was last delivered, the block is the sweep's to bring up to date.
      yield* w.fs.writeFileString(w.claudeFile, installed);
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 1, flags: 0 });
      assert.include(
        yield* w.fs.readFileString(w.claudeFile),
        "- .knowledge/db.md: The database\n",
      );
      assert.deepStrictEqual(
        (yield* store.verify({ projectId })).map((result) => result.status),
        ["ok"],
      );
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
      assert.deepStrictEqual(caught.value, { examined: 1, acted: 1, flags: 0 });
      // Every file call is the atomic write of Codex's file; the page and Claude's file are untouched.
      assert.isNotEmpty(caught.writes);
      for (const call of caught.writes) assert.include(call, ` ${w.codexFile}`);
      assert.include(
        yield* w.fs.readFileString(w.codexFile),
        "- .knowledge/tests.md: Running the tests\n",
      );
      assert.strictEqual(yield* w.fs.readFileString(w.page("tests")), page);
      assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), block);
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });

      // A person's install is the one that repairs both.
      yield* store.install({ projectId });
      assert.strictEqual(
        yield* w.fs.readFileString(w.page("tests")),
        "# Running the tests\n\nBody.\n",
      );
      assert.deepStrictEqual(
        (yield* store.verify({ projectId })).map((result) => result.status),
        ["ok", "ok"],
      );
      assert.deepStrictEqual(yield* tick(), { examined: 1, acted: 0, flags: 0 });
    }).pipe(Effect.provide(layerTest)),
);
