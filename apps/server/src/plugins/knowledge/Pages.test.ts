import { assert, it } from "@effect/vitest";
import { knowledgePagePath } from "@t3tools/contracts";

import { findBlock, sha256 } from "../InstructionBlocks.ts";
import { INDEX_MARKERS, blockStatus, catchUp, pageStatus, render, worse } from "./Pages.ts";

const pages = [
  { key: "tests", title: "Running the tests", body: "Use `vp test run <files>`.\n\n" },
  { key: "db", title: "Where the database lives", body: "  Under the state directory.  " },
];

it("renders each page with its title as the heading and the index in key order", () => {
  const rendered = render(pages);
  const db = "# Where the database lives\n\nUnder the state directory.\n";
  const tests = "# Running the tests\n\nUse `vp test run <files>`.\n";
  assert.deepStrictEqual(rendered.pages, [
    { key: "db", path: ".knowledge/db.md", text: db, hash: sha256(db) },
    { key: "tests", path: ".knowledge/tests.md", text: tests, hash: sha256(tests) },
  ]);
  assert.strictEqual(
    rendered.block?.text,
    [
      "<!-- fork-knowledge:start key=index -->",
      "Before changing code, read the knowledge page below that matches the task.",
      "",
      "- .knowledge/db.md: Where the database lives",
      "- .knowledge/tests.md: Running the tests",
      "<!-- fork-knowledge:end key=index -->",
    ].join("\n"),
  );
  // The block hash is what `findBlock` reads back from a file holding it.
  const found = findBlock(`# Mine\n\n${rendered.block?.text}\n`, INDEX_MARKERS);
  assert.isTrue(found.kind === "found" && found.hash === rendered.block?.hash);
  assert.strictEqual(knowledgePagePath("db"), ".knowledge/db.md");
});

it("renders nothing to deliver when no page is accepted, whatever order the pages come in", () => {
  const empty = render([]);
  assert.deepStrictEqual(empty.pages, []);
  assert.isUndefined(empty.block);
  assert.deepStrictEqual(render(pages.toReversed()), render(pages));
});

it("the sweep writes a stale component only while it still holds what was delivered", () => {
  const path = "/work/project/CLAUDE.md";
  const delivered = { hash: "old", path };
  const decide = (
    expected: string | undefined,
    current: string | undefined,
    delivery: { readonly hash: string; readonly path: string } | undefined,
    at = path,
  ) => catchUp({ expected, current, path: at, delivery });

  // Delivered as it renders now: nothing to do, even over a hand edit.
  assert.strictEqual(decide("new", "new", { hash: "new", path }), "none");
  assert.strictEqual(decide("new", "edited", { hash: "new", path }), "none");
  assert.strictEqual(decide(undefined, undefined, undefined), "none");
  // Never delivered: written, or only recorded when the file already holds it.
  assert.strictEqual(decide("new", undefined, undefined), "write");
  assert.strictEqual(decide("new", "a teammate's", undefined), "write");
  assert.strictEqual(decide("new", "new", undefined), "record");
  // Delivered before: rewritten while the file holds that delivery, else left for a person.
  assert.strictEqual(decide("new", "old", delivered), "write");
  assert.strictEqual(decide("new", "edited", delivered), "leave");
  assert.strictEqual(decide("new", undefined, delivered), "leave");
  // No longer rendered, as for a retired page: removed, recorded once gone, or left when edited.
  assert.strictEqual(decide(undefined, "old", delivered), "write");
  assert.strictEqual(decide(undefined, undefined, delivered), "record");
  assert.strictEqual(decide(undefined, "edited", delivered), "leave");
  // A project that moved: its files moved with it.
  assert.strictEqual(decide("old", "old", delivered, "/moved/CLAUDE.md"), "record");
});

it("reads a block and a page as ok, drifted or missing, the gone one outranking the changed one", () => {
  const hash = render(pages).block!.hash;
  const found = { kind: "found", start: 0, end: 1 } as const;
  assert.strictEqual(blockStatus(hash, { ...found, hash }), "ok");
  assert.strictEqual(blockStatus(hash, { ...found, hash: "edited" }), "drifted");
  assert.strictEqual(blockStatus(hash, { kind: "damaged" }), "drifted");
  assert.strictEqual(blockStatus(hash, { kind: "absent" }), "missing");
  assert.strictEqual(blockStatus(undefined, { kind: "absent" }), "ok");
  assert.strictEqual(blockStatus(undefined, { ...found, hash }), "drifted");

  assert.strictEqual(pageStatus("same", "same"), "ok");
  assert.strictEqual(pageStatus("edited", "same"), "drifted");
  assert.strictEqual(pageStatus(undefined, "same"), "missing");

  assert.strictEqual(worse("ok", "drifted"), "drifted");
  assert.strictEqual(worse("missing", "drifted"), "missing");
  assert.strictEqual(worse("drifted", "missing"), "missing");
  assert.strictEqual(worse("ok", "ok"), "ok");
});
