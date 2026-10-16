import { assert, it } from "@effect/vitest";

import {
  blockMarkers,
  findBlock,
  placeBlock,
  removeBlock,
  type BlockMarkers,
  type FoundBlock,
} from "./InstructionBlocks.ts";

const review = blockMarkers("policy", "review");
const block = (markers: BlockMarkers, body: string) => `${markers.start}\n${body}\n${markers.end}`;
const text = block(review, "Run the tests.");

/** The block as `placeBlock` takes it: located, or known to be absent. */
const locate = (
  source: string,
  markers: BlockMarkers,
): Exclude<FoundBlock, { readonly kind: "damaged" }> => {
  const found = findBlock(source, markers);
  if (found.kind === "damaged") throw new Error(`damaged block for ${markers.start}`);
  return found;
};

it("names each plugin's markers apart, so one plugin never finds another's block", () => {
  assert.deepStrictEqual(blockMarkers("knowledge", "index"), {
    start: "<!-- fork-knowledge:start key=index -->",
    end: "<!-- fork-knowledge:end key=index -->",
    header: "<!-- fork-knowledge hash=",
  });
  assert.strictEqual(findBlock(text, blockMarkers("knowledge", "review")).kind, "absent");
  assert.strictEqual(findBlock(text, review).kind, "found");
});

it("replaces a block in place and keeps the text around it byte for byte", () => {
  const above = "# Mine\n\nKeep this.\n";
  const below = "\n## After\n\nAnd this.\n";
  const source = `${above}${text}${below}`;
  const next = block(review, "Changed.");

  const replaced = placeBlock(source, locate(source, review), next);
  assert.strictEqual(replaced, `${above}${next}${below}`);
  assert.strictEqual(replaced.split(review.start).length, 2);
});

it("appends after a blank line, and starts a missing file with the block alone", () => {
  const absent = locate("", review);
  assert.strictEqual(placeBlock("", absent, text), `${text}\n`);
  assert.strictEqual(placeBlock("# Mine", absent, text), `# Mine\n\n${text}\n`);
  assert.strictEqual(placeBlock("# Mine\n", absent, text), `# Mine\n\n${text}\n`);
  assert.strictEqual(placeBlock("# Mine\n\n", absent, text), `# Mine\n\n${text}\n`);
});

it("removes a block with its line break and leaves every other byte", () => {
  const above = "# Mine\n\n";
  const below = "## After\n";
  const source = `${above}${text}\n${below}`;
  const found = findBlock(source, review);
  if (found.kind !== "found") throw new Error("expected the block");
  assert.strictEqual(removeBlock(source, found), `${above}${below}`);

  const alone = `${text}\n`;
  const only = findBlock(alone, review);
  if (only.kind !== "found") throw new Error("expected the block");
  assert.strictEqual(removeBlock(alone, only), "");
  const unterminated = findBlock(text, review);
  if (unterminated.kind !== "found") throw new Error("expected the block");
  assert.strictEqual(removeBlock(text, unterminated), "");
});

it("reports one marker alone or duplicate markers as damaged, and another key's block as absent", () => {
  assert.strictEqual(findBlock(`${review.start}\nx\n`, review).kind, "damaged");
  assert.strictEqual(findBlock(`x\n${review.end}\n`, review).kind, "damaged");
  assert.strictEqual(findBlock(`${text}\n${text}\n`, review).kind, "damaged");
  assert.strictEqual(findBlock(`${review.end}\n${review.start}\n`, review).kind, "damaged");
  assert.strictEqual(findBlock("nothing here\n", review).kind, "absent");
  assert.strictEqual(findBlock(text, blockMarkers("policy", "review-2")).kind, "absent");
  assert.strictEqual(findBlock(text, blockMarkers("policy", "project-1/review")).kind, "absent");
});
