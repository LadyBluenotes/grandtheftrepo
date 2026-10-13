import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type KnowledgeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as KnowledgeStore from "./KnowledgeStore.ts";
import { onHost, projectId, world } from "./testkit.ts";

const layerTest = onHost(Layer.empty);

const failure = <A>(effect: Effect.Effect<A, KnowledgeError>) =>
  Effect.map(Effect.flip(effect), (error) => error.message);

/** Proposes a page as a person and accepts it as proposed. */
const accepted = Effect.fn("accepted")(function* (key: string, title: string, body: string) {
  const store = yield* KnowledgeStore.KnowledgeStore;
  const draft = yield* store.propose({ projectId, key, title, body }, { kind: "person" });
  return yield* store.accept({ id: draft.id });
});

it.effect("a proposal is a draft, and nothing is written to the project", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const w = yield* world;
    const threadId = ThreadId.make("thread-1");
    const proposed = yield* w.writing(
      store.propose(
        { projectId, key: "tests", title: "Running the tests", body: "Use vp." },
        { kind: "agent", threadId },
      ),
    );
    assert.strictEqual(proposed.value.state, "draft");
    assert.deepStrictEqual(proposed.value.source, { kind: "agent", threadId });
    assert.isNull(proposed.value.acceptedAt);
    assert.deepStrictEqual(proposed.writes, []);
    assert.deepStrictEqual(yield* w.fs.readDirectory(w.root), []);

    assert.deepStrictEqual(
      (yield* store.list({ projectId })).map((entry) => [entry.key, entry.state]),
      [["tests", "draft"]],
    );
    assert.deepStrictEqual(yield* store.list({ projectId, state: "accepted" }), []);

    assert.strictEqual(
      yield* failure(
        store.propose({ projectId, key: "tests", title: "Again", body: "x" }, { kind: "person" }),
      ),
      'This project already has a draft page "tests".',
    );
    assert.include(
      yield* failure(
        store.propose(
          { projectId, key: "marker", title: "A <!-- fork-knowledge:end --> title", body: "x" },
          { kind: "person" },
        ),
      ),
      "fork-knowledge:",
    );
    assert.include(
      yield* failure(
        store.propose({ projectId, key: "Bad Key", title: "t", body: "x" }, { kind: "person" }),
      ),
      "must match",
    );
    assert.include(
      yield* failure(
        store.propose(
          { projectId, key: "long", title: "t", body: "x".repeat(4_001) },
          { kind: "person" },
        ),
      ),
      "4,000",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "accepting writes the page and the index block with every byte around it kept, and installing again writes nothing",
  () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeStore.KnowledgeStore;
      const w = yield* world;
      const mine = "# Mine\n\nKeep this.\n";
      yield* w.fs.writeFileString(w.claudeFile, mine);

      const draft = yield* store.propose(
        { projectId, key: "tests", title: "Tests", body: "Draft body." },
        { kind: "person" },
      );
      const entry = yield* store.accept({
        id: draft.id,
        title: "Running the tests",
        body: "Use `vp test run <files>`.",
      });
      assert.strictEqual(entry.state, "accepted");
      assert.strictEqual(entry.title, "Running the tests");
      assert.isString(entry.acceptedAt);

      assert.strictEqual(
        yield* w.fs.readFileString(w.page("tests")),
        "# Running the tests\n\nUse `vp test run <files>`.\n",
      );
      const block = [
        "<!-- fork-knowledge:start key=index -->",
        "Before changing code, read the knowledge page below that matches the task.",
        "",
        "- .knowledge/tests.md: Running the tests",
        "<!-- fork-knowledge:end key=index -->",
      ].join("\n");
      assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), `${mine}\n${block}\n`);
      // Only Claude's home directory exists, so the other agents' files are not created.
      assert.isFalse(yield* w.fs.exists(w.codexFile));
      assert.isFalse(yield* w.fs.exists(w.copilotFile));

      const again = yield* w.writing(store.install({ projectId }));
      assert.deepStrictEqual(again.value, [
        { agent: "claude", status: "unchanged", path: w.claudeFile },
      ]);
      assert.deepStrictEqual(again.writes, []);
      assert.deepStrictEqual(yield* store.verify({ projectId }), [
        { agent: "claude", status: "ok", path: w.claudeFile },
      ]);

      // A file that does not exist is created with the block alone.
      yield* w.useCodex;
      const codex = yield* store.install({ projectId });
      assert.deepStrictEqual(
        codex.map((result) => [result.agent, result.status]),
        [
          ["claude", "unchanged"],
          ["codex", "installed"],
        ],
      );
      assert.strictEqual(yield* w.fs.readFileString(w.codexFile), `${block}\n`);

      assert.include(yield* failure(store.accept({ id: draft.id })), "only a draft is accepted");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "verify reports a hand-edited block as drifted and a deleted file as missing, and install repairs them",
  () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeStore.KnowledgeStore;
      const w = yield* world;
      yield* accepted("tests", "Running the tests", "Use vp.");
      const installed = yield* w.fs.readFileString(w.claudeFile);
      const ok = [{ agent: "claude" as const, status: "ok" as const, path: w.claudeFile }];

      yield* w.fs.writeFileString(
        w.claudeFile,
        installed.replace("Running the tests", "Skipping the tests"),
      );
      assert.deepStrictEqual(yield* store.verify({ projectId }), [
        { agent: "claude", status: "drifted", path: w.claudeFile },
      ]);
      assert.deepStrictEqual(yield* store.install({ projectId }), [
        { agent: "claude", status: "installed", path: w.claudeFile },
      ]);
      assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), installed);
      assert.deepStrictEqual(yield* store.verify({ projectId }), ok);

      yield* w.fs.writeFileString(w.page("tests"), "# Running the tests\n\nEdited.\n");
      assert.strictEqual((yield* store.verify({ projectId }))[0]?.status, "drifted");
      yield* w.fs.remove(w.page("tests"));
      assert.strictEqual((yield* store.verify({ projectId }))[0]?.status, "missing");
      yield* store.install({ projectId });
      assert.deepStrictEqual(yield* store.verify({ projectId }), ok);

      yield* w.fs.remove(w.claudeFile);
      assert.strictEqual((yield* store.verify({ projectId }))[0]?.status, "missing");
      yield* store.install({ projectId });
      assert.deepStrictEqual(yield* store.verify({ projectId }), ok);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "retiring deletes the page and its index line, and the last one takes the block down",
  () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeStore.KnowledgeStore;
      const w = yield* world;
      yield* w.useCodex;
      const mine = "# Mine\n";
      yield* w.fs.writeFileString(w.claudeFile, mine);
      const db = yield* accepted("db", "Where the database lives", "Under the state directory.");
      const tests = yield* accepted("tests", "Running the tests", "Use vp.");
      const both = yield* w.fs.readFileString(w.claudeFile);
      assert.include(both, "- .knowledge/db.md: Where the database lives\n");
      assert.include(both, "- .knowledge/tests.md: Running the tests\n");

      const retired = yield* store.retire({ id: db.id });
      assert.strictEqual(retired.state, "retired");
      assert.isString(retired.retiredAt);
      assert.isFalse(yield* w.fs.exists(w.page("db")));
      assert.isTrue(yield* w.fs.exists(w.page("tests")));
      const one = yield* w.fs.readFileString(w.claudeFile);
      assert.notInclude(one, ".knowledge/db.md");
      assert.include(one, "- .knowledge/tests.md: Running the tests\n");
      assert.isTrue(one.startsWith(`${mine}\n<!-- fork-knowledge:start key=index -->`));
      assert.deepStrictEqual(
        (yield* store.verify({ projectId })).map((result) => result.status),
        ["ok", "ok"],
      );

      yield* store.retire({ id: tests.id });
      assert.isFalse(yield* w.fs.exists(w.page("tests")));
      // Every byte outside the block stays; the file that held the block alone goes with it.
      assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), `${mine}\n`);
      assert.isFalse(yield* w.fs.exists(w.codexFile));
      assert.deepStrictEqual(
        (yield* store.verify({ projectId })).map((result) => result.status),
        ["ok", "ok"],
      );
      const idle = yield* w.writing(store.install({ projectId }));
      assert.deepStrictEqual(idle.writes, []);

      assert.include(yield* failure(store.retire({ id: tests.id })), "already retired");
      // A retired key is free again.
      const reused = yield* store.propose(
        { projectId, key: "db", title: "The database", body: "Moved." },
        { kind: "person" },
      );
      assert.strictEqual(reused.state, "draft");

      // Discarding a draft writes nothing.
      const discarded = yield* w.writing(store.retire({ id: reused.id }));
      assert.strictEqual(discarded.value.state, "retired");
      assert.deepStrictEqual(discarded.writes, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a damaged block refuses the install; the acceptance stands and nothing is written", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const w = yield* world;
    const damaged = "<!-- fork-knowledge:start key=index -->\nhalf a block\n";
    yield* w.fs.writeFileString(w.claudeFile, damaged);
    const draft = yield* store.propose(
      { projectId, key: "tests", title: "Running the tests", body: "Use vp." },
      { kind: "person" },
    );
    const refused = yield* w.writing(Effect.flip(store.accept({ id: draft.id })));
    assert.strictEqual(refused.value.code, "invalid");
    assert.include(refused.value.message, 'Page "tests" is accepted, but the install failed:');
    assert.include(refused.value.message, "damaged fork-knowledge block");
    assert.deepStrictEqual(refused.writes, []);
    assert.isFalse(yield* w.fs.exists(w.page("tests")));
    assert.strictEqual(yield* w.fs.readFileString(w.claudeFile), damaged);
    assert.deepStrictEqual(
      (yield* store.list({ projectId, state: "accepted" })).map((entry) => entry.key),
      ["tests"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an unknown project or page answers not found", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const elsewhere = ProjectId.make("project:elsewhere");
    assert.strictEqual(
      (yield* Effect.flip(store.install({ projectId: elsewhere }))).code,
      "not_found",
    );
    assert.strictEqual((yield* Effect.flip(store.accept({ id: 99 }))).code, "not_found");
  }).pipe(Effect.provide(layerTest)),
);
