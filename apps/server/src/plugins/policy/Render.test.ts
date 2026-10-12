import { assert, it } from "@effect/vitest";

import { blockId, findBlock, placeBlock, renderBlock, sha256, type FoundBlock } from "./Render.ts";

const block = renderBlock({
  id: "review",
  rules: "Be kind.\n",
  body: "Run the tests.\n",
  version: 2,
});

/** The block as `placeBlock` takes it: located, or known to be absent. */
const locate = (text: string, id: string): Exclude<FoundBlock, { readonly kind: "damaged" }> => {
  const found = findBlock(text, id);
  if (found.kind === "damaged") throw new Error(`damaged block for ${id}`);
  return found;
};

it("renders the marked block and hashes the lines between the header and the end marker", () => {
  assert.strictEqual(block.hash, sha256("Be kind.\n\nRun the tests.\n"));
  assert.strictEqual(block.rulesHash, sha256("Be kind.\n"));
  assert.strictEqual(
    block.text,
    [
      "<!-- fork-policy:start key=review -->",
      `<!-- fork-policy hash=${block.hash} rules=${block.rulesHash} version=2 -->`,
      "Be kind.",
      "",
      "Run the tests.",
      "<!-- fork-policy:end key=review -->",
    ].join("\n"),
  );
  assert.strictEqual(blockId("*", "review"), "review");
  assert.strictEqual(blockId("project-1", "review"), "project-1/review");

  const found = findBlock(`above\n${block.text}\nbelow\n`, "review");
  assert.strictEqual(found.kind, "found");
  if (found.kind === "found") {
    assert.strictEqual(found.hash, block.hash);
    assert.strictEqual(found.start, "above\n".length);
    assert.strictEqual(found.end, "above\n".length + block.text.length);
  }
  // The header line is not hashed, so a block without it still matches; an edited body does not.
  const headerless = block.text.replace(/<!-- fork-policy hash=[^\n]*\n/, "");
  const bare = findBlock(headerless, "review");
  assert.isTrue(bare.kind === "found" && bare.hash === block.hash);
  const edited = findBlock(block.text.replace("Run the tests.", "Skip the tests."), "review");
  assert.isTrue(edited.kind === "found" && edited.hash !== block.hash);
});

it("replaces a block in place and keeps the text around it byte for byte", () => {
  const above = "# Mine\n\nKeep this.\n";
  const below = "\n## After\n\nAnd this.\n";
  const text = `${above}${block.text}${below}`;
  const next = renderBlock({ id: "review", rules: "", body: "Changed.", version: 3 });

  const replaced = placeBlock(text, locate(text, "review"), next.text);
  assert.strictEqual(replaced, `${above}${next.text}${below}`);
  assert.strictEqual(replaced.split("<!-- fork-policy:start key=review -->").length, 2);
});

it("appends after a blank line, and starts a missing file with the block alone", () => {
  const absent = locate("", "review");
  assert.strictEqual(placeBlock("", absent, block.text), `${block.text}\n`);
  assert.strictEqual(placeBlock("# Mine", absent, block.text), `# Mine\n\n${block.text}\n`);
  assert.strictEqual(placeBlock("# Mine\n", absent, block.text), `# Mine\n\n${block.text}\n`);
  assert.strictEqual(placeBlock("# Mine\n\n", absent, block.text), `# Mine\n\n${block.text}\n`);
});

it("reports one marker alone or duplicate markers as damaged, and another key's block as absent", () => {
  assert.strictEqual(
    findBlock("<!-- fork-policy:start key=review -->\nx\n", "review").kind,
    "damaged",
  );
  assert.strictEqual(
    findBlock("x\n<!-- fork-policy:end key=review -->\n", "review").kind,
    "damaged",
  );
  assert.strictEqual(findBlock(`${block.text}\n${block.text}\n`, "review").kind, "damaged");
  assert.strictEqual(
    findBlock(
      "<!-- fork-policy:end key=review -->\n<!-- fork-policy:start key=review -->\n",
      "review",
    ).kind,
    "damaged",
  );
  assert.strictEqual(findBlock("nothing here\n", "review").kind, "absent");
  assert.strictEqual(findBlock(block.text, "review-2").kind, "absent");
  assert.strictEqual(findBlock(block.text, "project-1/review").kind, "absent");
});
