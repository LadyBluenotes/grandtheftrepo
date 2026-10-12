import { assert, it } from "@effect/vitest";
import { accepted, input, read, run, usage } from "./fixtures.ts";
import { knowledgeReuse } from "./knowledge_reuse.ts";

// Every input this measure would read exists here; only the knowledge page reads are missing.
const full = input({
  threads: [accepted()],
  runs: [run()],
  toolCalls: [read("src/a.ts")],
  turnUsage: [usage()],
});

it("is unavailable in a normal window, naming what would supply it", () => {
  const result = knowledgeReuse(full);
  assert.strictEqual(result.state, "unavailable");
  assert.match(result.missingReason ?? "", /knowledge plugin/);
});

it("is unavailable in an empty window", () => {
  assert.strictEqual(knowledgeReuse(input()).state, "unavailable");
});

it("never stands a zero in for the knowledge page reads", () => {
  const result = knowledgeReuse(full);
  assert.deepEqual([result.value, result.sampleSize, result.provenance], [null, 0, []]);
});
