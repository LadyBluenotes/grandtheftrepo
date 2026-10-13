import { assert, it } from "@effect/vitest";
import { knowledgePagePath } from "@t3tools/contracts";

import { findBlock, sha256 } from "../InstructionBlocks.ts";
import { INDEX_MARKERS, blockStatus, needsInstall, pageStatus, render, worse } from "./Pages.ts";

const pages = [
  { key: "tests", title: "Running the tests", body: "Use `vp test run <files>`.\n\n" },
  { key: "db", title: "Where the database lives", body: "  Under the state directory.  " },
];

it("renders each page with its title as the heading and the index in key order", () => {
  const rendered = render(pages);
  assert.deepStrictEqual(rendered.pages, [
    {
      path: ".knowledge/db.md",
      text: "# Where the database lives\n\nUnder the state directory.\n",
    },
    { path: ".knowledge/tests.md", text: "# Running the tests\n\nUse `vp test run <files>`.\n" },
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

it("renders nothing to deliver when no page is accepted, and a hash that follows every byte", () => {
  const empty = render([]);
  assert.deepStrictEqual(empty.pages, []);
  assert.isUndefined(empty.block);
  assert.strictEqual(empty.hash, sha256(""));

  const rendered = render(pages);
  assert.strictEqual(render(pages.toReversed()).hash, rendered.hash);
  assert.notStrictEqual(
    render([{ ...pages[0]!, body: "Changed." }, pages[1]!]).hash,
    rendered.hash,
  );
  assert.notStrictEqual(render([pages[0]!]).hash, rendered.hash);
});

it("needs an install for an agent with no delivery, another render, or another file", () => {
  const rendered = render(pages);
  const path = "/work/project/CLAUDE.md";
  const delivery = { hash: rendered.hash, path };
  assert.isFalse(needsInstall({ rendered, path, delivery }));
  assert.isTrue(needsInstall({ rendered, path, delivery: undefined }));
  assert.isTrue(needsInstall({ rendered, path, delivery: { ...delivery, hash: "old" } }));
  assert.isTrue(needsInstall({ rendered, path: "/moved/CLAUDE.md", delivery }));
  // With nothing accepted, an agent never delivered to has nothing to take down.
  const empty = render([]);
  assert.isFalse(needsInstall({ rendered: empty, path, delivery: undefined }));
  assert.isTrue(needsInstall({ rendered: empty, path, delivery }));
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
