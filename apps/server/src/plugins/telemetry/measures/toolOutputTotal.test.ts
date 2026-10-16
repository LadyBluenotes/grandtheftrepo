import { assert, it } from "@effect/vitest";
import { TurnItemId } from "@t3tools/contracts";

import * as Fixtures from "../eventFixtures.ts";
import { BEFORE, edit, input, ran, returned, rowOf, run } from "./fixtures.ts";
import { toolKey, toolOutputTotal } from "./toolOutput.ts";

const tokens = (text: string) => Math.ceil(text.length / 4);

/** Every kind of item that returns something, through the accessors the reactor uses. */
const mixed = [
  // No output at all: still a call, of zero.
  Fixtures.readItem,
  Fixtures.commandItem,
  { ...Fixtures.commandItem, id: TurnItemId.make("item:command-2"), input: "git log --oneline" },
  { ...Fixtures.commandItem, id: TurnItemId.make("item:command-3"), input: "rg -n TODO src" },
  Fixtures.mcpItem,
  {
    ...Fixtures.readItem,
    id: TurnItemId.make("item:unnamed"),
    toolName: null,
    output: "x".repeat(400),
  },
  Fixtures.fileSearchItem,
  Fixtures.webSearchItem,
];

it("groups four kinds of item by tool key, with shares that sum to one", () => {
  const rows = mixed.map(rowOf);
  assert.deepEqual(rows.map(toolKey), [
    "Read",
    "command:git",
    "command:git",
    "command:rg",
    "mcp__t3-code__thread_list",
    "unknown",
    "file_search",
    "web_search",
  ]);

  const measure = toolOutputTotal(
    input({ runs: [run({ run_id: Fixtures.runId })], toolCalls: rows }),
  );
  const byTool = measure.detail?.byTool ?? [];
  const status = tokens(Fixtures.commandItem.output ?? "");
  assert.deepEqual(
    byTool.map((row) => [row.tool, row.calls, row.estimatedTokens]),
    [
      ["unknown", 1, 100],
      ["command:git", 2, 2 * status],
      ["command:rg", 1, status],
      ["mcp__t3-code__thread_list", 1, tokens(JSON.stringify(Fixtures.mcpItem.output))],
      ["web_search", 1, tokens(JSON.stringify(Fixtures.webSearchItem.results))],
      ["file_search", 1, tokens(JSON.stringify(Fixtures.fileSearchItem.results))],
      ["Read", 1, 0],
    ].toSorted((a, b) => Number(b[2]) - Number(a[2]) || String(a[0]).localeCompare(String(b[0]))),
  );

  const total = byTool.reduce((sum, row) => sum + row.estimatedTokens, 0);
  assert.deepEqual(
    [measure.state, measure.value, measure.unit, measure.direction, measure.sampleSize],
    ["ok", total, "tokens", "lower_is_better", mixed.length],
  );
  assert.closeTo(
    byTool.reduce((sum, row) => sum + row.share, 0),
    1,
    1e-9,
  );
  for (const row of byTool) assert.closeTo(row.share, row.estimatedTokens / total, 1e-9);
  assert.isTrue(
    byTool.every(
      (row, index) => index === 0 || byTool[index - 1]!.estimatedTokens >= row.estimatedTokens,
    ),
  );
});

it("takes the median and 95th percentile of a tool's calls by nearest rank", () => {
  // Twenty sizes in no order: 100, 200, ... 2,000.
  const sizes = [
    1100, 300, 1900, 700, 100, 1500, 900, 1700, 500, 1300, 200, 2000, 600, 1800, 400, 1000, 800,
    1600, 1200, 1400,
  ];
  const measure = toolOutputTotal(
    input({ runs: [run()], toolCalls: sizes.map((size) => returned("Read", size)) }),
  );
  const [read] = measure.detail?.byTool ?? [];
  assert.deepEqual(
    [read?.tool, read?.calls, read?.p50, read?.p95, measure.value],
    ["Read", 20, 1000, 1900, 21_000],
  );

  const [single] =
    toolOutputTotal(input({ runs: [run()], toolCalls: [returned("Read", 70)] })).detail?.byTool ??
    [];
  assert.deepEqual([single?.p50, single?.p95], [70, 70]);
});

it("counts only the output of runs that started in the window", () => {
  const measure = toolOutputTotal(
    input({
      runs: [run(), run({ run_id: "run:early", started_at: BEFORE })],
      toolCalls: [
        returned("Read", 300),
        returned("Read", 9000, { run_id: "run:early" }),
        // A file change returns nothing, and a size not recorded yet is not a zero.
        edit("src/a.ts"),
        returned("Read", null),
        ran("git status", 50),
      ],
    }),
  );
  assert.deepEqual([measure.value, measure.sampleSize], [350, 2]);
  assert.deepEqual(
    measure.detail?.byTool?.map((row) => [row.tool, row.estimatedTokens]),
    [
      ["Read", 300],
      ["command:git", 50],
    ],
  );
});

it("gives every share as zero, not a division by zero, when no call returned anything", () => {
  const measure = toolOutputTotal(
    input({ runs: [run()], toolCalls: [returned("Read", 0), ran("git status", 0)] }),
  );
  assert.deepEqual([measure.state, measure.value, measure.sampleSize], ["ok", 0, 2]);
  assert.deepEqual(
    measure.detail?.byTool?.map((row) => row.share),
    [0, 0],
  );
});

it("is unavailable, not zero, for a window with no tool items", () => {
  const empty = toolOutputTotal(input({ runs: [run()], toolCalls: [edit("src/a.ts")] }));
  assert.deepEqual(
    [empty.state, empty.value, empty.sampleSize, empty.missingReason, empty.detail],
    ["unavailable", null, 0, "No tool items in window.", undefined],
  );
  assert.strictEqual(toolOutputTotal(input()).state, "unavailable");
});

it("names a command with no program and a tool with no name", () => {
  assert.strictEqual(
    toolKey(rowOf({ ...Fixtures.commandItem, input: "cd app" })),
    "command:unknown",
  );
  assert.strictEqual(toolKey(ran("", 1)), "command:unknown");
  assert.strictEqual(toolKey(returned(null, 1)), "unknown");
});
