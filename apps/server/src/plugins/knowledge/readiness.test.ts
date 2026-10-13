import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as KnowledgeStore from "./KnowledgeStore.ts";
import { INDEX_MARKERS } from "./Pages.ts";
import { deliveredCheck, filesCheck, KnowledgeReadiness, layer } from "./readiness.ts";
import { onHost, projectId, world } from "./testkit.ts";

describe("filesCheck", () => {
  it("is ready when the server can write every agent's instruction file", () => {
    const check = filesCheck([
      { path: "/repo/CLAUDE.md", writable: true },
      { path: "/repo/AGENTS.md", writable: true },
    ]);
    assert.strictEqual(check.status, "ready");
  });

  it("names a file it cannot write", () => {
    const check = filesCheck([
      { path: "/repo/CLAUDE.md", writable: true },
      { path: "/repo/AGENTS.md", writable: false },
    ]);
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "The server cannot write /repo/AGENTS.md, so the knowledge index cannot be installed there.",
    );
  });
});

describe("deliveredCheck", () => {
  it("is ready when every agent in use holds the pages as accepted", () => {
    const check = deliveredCheck(2, [
      { agent: "claude", status: "ok", path: "/repo/CLAUDE.md" },
      { agent: "codex", status: "ok", path: "/repo/AGENTS.md" },
    ]);
    assert.strictEqual(check.status, "ready");
    assert.strictEqual(
      check.sentence,
      "2 accepted pages are delivered and indexed for Claude and Codex.",
    );
  });

  it("names the agents whose pages or index drifted or went missing", () => {
    const check = deliveredCheck(1, [
      { agent: "claude", status: "drifted", path: "/repo/CLAUDE.md" },
      { agent: "codex", status: "ok", path: "/repo/AGENTS.md" },
    ]);
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "Pages are not as accepted for Claude (drifted); install from the Knowledge screen.",
    );
    assert.strictEqual(check.target, "plugin");
  });
});

const layerTest = onHost(layer);

const verifiedAt = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      readonly agent: string;
      readonly verified_at: string | null;
    }>`SELECT agent, verified_at FROM knowledge_delivery ORDER BY agent`,
);

const propose = Effect.fn("propose")(function* (key: string) {
  const store = yield* KnowledgeStore.KnowledgeStore;
  return yield* store.propose({ projectId, key, title: key, body: "Body." }, { kind: "person" });
});

it.effect("a readiness read marks nothing verified, as verify does", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const readiness = yield* KnowledgeReadiness;
    yield* store.accept({ id: (yield* propose("tests")).id });
    const installed = yield* verifiedAt;
    assert.isAbove(installed.length, 0);
    assert.isTrue(installed.every((row) => row.verified_at === null));

    assert.deepStrictEqual(
      (yield* readiness.checks(projectId)).map((check) => [check.id, check.status]),
      [
        ["files", "ready"],
        ["delivered", "ready"],
      ],
    );
    assert.deepStrictEqual(yield* verifiedAt, installed);

    yield* store.verify({ projectId });
    assert.isTrue((yield* verifiedAt).some((row) => row.verified_at !== null));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a page accepted but never installed needs attention", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const readiness = yield* KnowledgeReadiness;
    const w = yield* world;
    // A damaged index block refuses the whole install, so the page is accepted and nothing is written.
    yield* w.fs.writeFileString(w.claudeFile, `${INDEX_MARKERS.start}\n`);
    const draft = yield* propose("tests");
    assert.strictEqual((yield* Effect.flip(store.accept({ id: draft.id }))).code, "invalid");
    yield* w.fs.remove(w.claudeFile);
    assert.isFalse(yield* w.fs.exists(w.page("tests")));

    const delivered = (yield* readiness.checks(projectId)).find(
      (check) => check.id === "delivered",
    );
    assert.strictEqual(delivered?.status, "attention");
    assert.strictEqual(
      delivered?.sentence,
      "Pages are not as accepted for Claude (missing); install from the Knowledge screen.",
    );
  }).pipe(Effect.provide(layerTest)),
);
