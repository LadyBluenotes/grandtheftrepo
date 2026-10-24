import { assert, it } from "@effect/vitest";

import { findBlock, sha256 } from "../InstructionBlocks.ts";
import { blockId, policyMarkers, renderBlock } from "./Render.ts";

const block = renderBlock({
  id: "review",
  rules: "Be kind.\n",
  body: "Run the tests.\n",
  version: 2,
});

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

  const found = findBlock(`above\n${block.text}\nbelow\n`, policyMarkers("review"));
  assert.strictEqual(found.kind, "found");
  if (found.kind === "found") {
    assert.strictEqual(found.hash, block.hash);
    assert.strictEqual(found.start, "above\n".length);
    assert.strictEqual(found.end, "above\n".length + block.text.length);
  }
  // The header line is not hashed, so a block without it still matches; an edited body does not.
  const headerless = block.text.replace(/<!-- fork-policy hash=[^\n]*\n/, "");
  const bare = findBlock(headerless, policyMarkers("review"));
  assert.isTrue(bare.kind === "found" && bare.hash === block.hash);
  const edited = findBlock(
    block.text.replace("Run the tests.", "Skip the tests."),
    policyMarkers("review"),
  );
  assert.isTrue(edited.kind === "found" && edited.hash !== block.hash);
});
