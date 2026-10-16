import { assert, it } from "@effect/vitest";

import {
  accepted,
  BEFORE,
  FROM,
  input,
  INSIDE,
  read,
  returned,
  run,
  TO,
  usage,
} from "./fixtures.ts";
import { computeMeasures } from "./index.ts";
import { toolOutputMaxPerCall, toolOutputTotal } from "./toolOutput.ts";

/** A call a provider's subagent made: it belongs to no run, and the item's own time places it. */
const runless = (tool: string, tokens: number, at: string | null, itemId: string) =>
  returned(tool, tokens, { run_id: null, item_at: at, item_id: itemId });

it("counts a call with no run in the window its item started in, and lists it with a null run", () => {
  const calls = [
    returned("Read", 300, { item_id: "item:with-run" }),
    runless("Grep", 5000, INSIDE, "item:subagent"),
    // Outside the window by its own time, or placed by nothing: not this window's.
    runless("Grep", 90_000, BEFORE, "item:early"),
    runless("Grep", 90_000, TO, "item:at-the-end"),
    runless("Grep", 90_000, null, "item:unplaced"),
  ];
  const window = input({ runs: [run()], toolCalls: calls });

  const total = toolOutputTotal(window);
  assert.deepEqual([total.value, total.sampleSize], [5300, 2]);
  assert.deepEqual(
    total.detail?.byTool?.map((row) => [row.tool, row.calls, row.estimatedTokens]),
    [
      ["Grep", 1, 5000],
      ["Read", 1, 300],
    ],
  );

  const largest = toolOutputMaxPerCall(window).detail?.largest ?? [];
  assert.deepEqual(largest[0], {
    tool: "Grep",
    threadId: "thread:1",
    runId: null,
    itemId: "item:subagent",
    estimatedTokens: 5000,
  });
  assert.strictEqual(largest[1]?.runId, "run:1");
});

it("is available from calls with no run alone", () => {
  const measure = toolOutputTotal(
    input({ runs: [], toolCalls: [runless("mcp__t3-code__thread_list", 800, INSIDE, "item:a")] }),
  );
  assert.deepEqual([measure.state, measure.value, measure.sampleSize], ["ok", 800, 1]);
});

it("leaves every per-run measure as it was when calls with no run are added", () => {
  const base = {
    threads: [accepted()],
    runs: [run()],
    turnUsage: [usage(), usage()],
    from: FROM,
    to: TO,
  };
  // One file read twice in the run: half of its reads repeat.
  const ofRun = [read("src/a.ts", { output_tokens: 10 }), read("src/a.ts", { output_tokens: 10 })];
  // The subagent reads that file three more times, and another one, and fails twice.
  const subagent = [
    ...["a", "a", "a", "b"].map((name, index) =>
      read(`src/${name}.ts`, {
        run_id: null,
        item_at: INSIDE,
        item_id: `item:sub:${index}`,
        output_tokens: 700,
      }),
    ),
    read("src/b.ts", {
      run_id: null,
      item_at: INSIDE,
      item_id: "item:sub:failed",
      status: "failed",
    }),
  ];

  const without = computeMeasures(input({ ...base, toolCalls: ofRun }));
  const withSubagent = computeMeasures(input({ ...base, toolCalls: [...ofRun, ...subagent] }));
  const perRun = (measures: typeof without) =>
    measures.filter((measure) => !measure.measure.startsWith("tool_output_"));

  assert.deepEqual(perRun(withSubagent), perRun(without));
  // The case is not vacuous: the measure those reads would change answers, and the same.
  const repeated = without.find((measure) => measure.measure === "repeated_reads");
  assert.deepEqual([repeated?.state, repeated?.value], ["ok", 0.5]);
  // The tool output measures are where the subagent's calls show.
  const total = (measures: typeof without) =>
    measures.find((measure) => measure.measure === "tool_output_total")?.value;
  assert.deepEqual([total(without), total(withSubagent)], [20, 20 + 4 * 700]);
});
