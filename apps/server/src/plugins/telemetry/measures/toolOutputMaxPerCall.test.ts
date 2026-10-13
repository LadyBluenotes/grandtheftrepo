import { assert, it } from "@effect/vitest";

import { BEFORE, input, ran, returned, run } from "./fixtures.ts";
import { computeMeasures } from "./index.ts";
import {
  toolOutputFlagText,
  toolOutputHint,
  toolOutputMaxPerCall,
  toolOutputOf,
} from "./toolOutput.ts";

it("answers with the largest single result and lists the largest first", () => {
  const measure = toolOutputMaxPerCall(
    input({
      runs: [run()],
      toolCalls: [
        returned("Read", 120, { item_id: "item:a" }),
        returned("mcp__t3-code__thread_list", 10_000, { item_id: "item:b", thread_id: "thread:2" }),
        ran("/bin/bash -lc 'git log'", 900, { item_id: "item:c" }),
      ],
    }),
  );
  assert.deepEqual(
    [measure.state, measure.value, measure.unit, measure.direction, measure.sampleSize],
    ["ok", 10_000, "tokens", "lower_is_better", 3],
  );
  assert.deepEqual(measure.detail?.largest, [
    {
      tool: "mcp__t3-code__thread_list",
      threadId: "thread:2",
      runId: "run:1",
      itemId: "item:b",
      estimatedTokens: 10_000,
    },
    {
      tool: "command:git",
      threadId: "thread:1",
      runId: "run:1",
      itemId: "item:c",
      estimatedTokens: 900,
    },
    { tool: "Read", threadId: "thread:1", runId: "run:1", itemId: "item:a", estimatedTokens: 120 },
  ]);
});

it("keeps ten rows, and lists equal sizes by item id", () => {
  const calls = Array.from({ length: 12 }, (_, index) =>
    returned("Read", index < 2 ? 5000 : 100 + index, {
      item_id: `item:${String(11 - index).padStart(2, "0")}`,
    }),
  );
  const measure = toolOutputMaxPerCall(input({ runs: [run()], toolCalls: calls }));
  assert.strictEqual(measure.sampleSize, 12);
  const largest = measure.detail?.largest ?? [];
  assert.strictEqual(largest.length, 10);
  // The two of 5,000 tie: item:10 sorts before item:11.
  assert.deepEqual(
    largest.slice(0, 3).map((row) => [row.itemId, row.estimatedTokens]),
    [
      ["item:10", 5000],
      ["item:11", 5000],
      ["item:00", 111],
    ],
  );
});

it("counts only runs that started in the window, and is unavailable when none did", () => {
  const early = run({ run_id: "run:early", started_at: BEFORE });
  const measure = toolOutputMaxPerCall(
    input({
      runs: [run(), early],
      toolCalls: [returned("Read", 40), returned("Read", 9000, { run_id: "run:early" })],
    }),
  );
  assert.deepEqual([measure.value, measure.sampleSize], [40, 1]);

  const none = toolOutputMaxPerCall(
    input({ runs: [early], toolCalls: [returned("Read", 9000, { run_id: "run:early" })] }),
  );
  assert.deepEqual(
    [none.state, none.value, none.sampleSize, none.missingReason, none.detail],
    ["unavailable", null, 0, "No tool items in window.", undefined],
  );
});

it("reads a call with no output as zero rather than leaving it out", () => {
  const measure = toolOutputMaxPerCall(input({ runs: [run()], toolCalls: [returned("Read", 0)] }));
  assert.deepEqual([measure.state, measure.value, measure.sampleSize], ["ok", 0, 1]);
});

it("cites the event fields it reads, and sits with the other measures", () => {
  const measures = computeMeasures(input()).filter((measure) =>
    measure.measure.startsWith("tool_output_"),
  );
  assert.deepEqual(
    measures.map((measure) => measure.measure),
    ["tool_output_total", "tool_output_max_per_call"],
  );
  for (const measure of measures) {
    assert.includeMembers(
      [...measure.provenance],
      ["turnItem.output", "turnItem.results", "turnItem.toolName", "turnItem.input"],
    );
  }
});

it("words the flag with the tool, the size and the thread, and a hint for the tool", () => {
  const row = (tool: string) => ({
    tool,
    threadId: "thread:1",
    runId: "run:1",
    itemId: "item:1",
    estimatedTokens: 10_000,
  });
  assert.strictEqual(
    toolOutputFlagText(row("Read"), "Fix login"),
    'Tool output: Read returned ~10000 tokens in "Fix login". Read a line range instead of the whole file.',
  );
  assert.strictEqual(
    toolOutputHint("command:git"),
    "Filter the command or pipe it through an output shrinker.",
  );
  assert.strictEqual(
    toolOutputHint("mcp__t3-code__thread_list"),
    "Ask the tool to paginate its results.",
  );
  assert.strictEqual(toolOutputHint("Grep"), null);
  assert.strictEqual(
    toolOutputFlagText(row("web_search"), "Docs"),
    'Tool output: web_search returned ~10000 tokens in "Docs".',
  );
});

it("hands the tool its rows, or the reason there are none", () => {
  const rows = computeMeasures(
    input({ runs: [run()], toolCalls: [returned("Read", 70), ran("git status", 30)] }),
  );
  const answered = toolOutputOf(rows);
  assert.deepEqual(
    answered.byTool.map((row) => row.tool),
    ["Read", "command:git"],
  );
  assert.deepEqual(
    answered.largest.map((row) => row.estimatedTokens),
    [70, 30],
  );
  assert.isNull(answered.missingReason);

  assert.deepEqual(toolOutputOf(computeMeasures(input())), {
    byTool: [],
    largest: [],
    missingReason: "No tool items in window.",
  });
});
