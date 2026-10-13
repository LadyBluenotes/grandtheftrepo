import { assert, it } from "@effect/vitest";
import { BEFORE, call, edit, input, read, run } from "./fixtures.ts";
import { knowledgeReuse } from "./knowledge_reuse.ts";

const PAGE = ".knowledge/testing.md";

/** A run that edited a file after reading each path in `reads`, in that order. */
const editing = (runId: string, reads: ReadonlyArray<string>) => ({
  run: run({ run_id: runId }),
  calls: [
    ...reads.map((path) => read(path, { run_id: runId })),
    edit("src/a.ts", { run_id: runId }),
  ],
});

const measure = (
  runs: ReadonlyArray<ReturnType<typeof editing>>,
  extra: Parameters<typeof input>[0] = {},
) =>
  knowledgeReuse(
    input({
      knowledgePages: 1,
      runs: runs.map((entry) => entry.run),
      toolCalls: runs.flatMap((entry) => entry.calls),
      ...extra,
    }),
  );

const summary = (result: ReturnType<typeof measure>) => [
  result.state,
  result.value,
  result.sampleSize,
];

it("answers 0.5 of four editing runs when two read a knowledge page before editing", () => {
  const result = measure([
    editing("run:1", [PAGE]),
    editing("run:2", ["src/b.ts"]),
    editing("run:3", ["src/b.ts", PAGE]),
    editing("run:4", []),
  ]);
  assert.deepEqual(summary(result), ["ok", 0.5, 4]);
  assert.isNull(result.missingReason);
});

it("does not count a read after the first edit, nor a run with reads and no edit", () => {
  const lateRead = {
    run: run({ run_id: "run:late" }),
    calls: [
      edit("src/a.ts", { run_id: "run:late" }),
      read(PAGE, { run_id: "run:late" }),
      edit("src/b.ts", { run_id: "run:late" }),
    ],
  };
  const readOnly = {
    run: run({ run_id: "run:read-only" }),
    calls: [read(PAGE, { run_id: "run:read-only" })],
  };
  assert.deepEqual(summary(measure([editing("run:early", [PAGE]), lateRead, readOnly])), [
    "ok",
    0.5,
    2,
  ]);
});

it("orders a run's calls by ordinal, not by the order the rows arrive in", () => {
  const unordered = {
    run: run({ run_id: "run:1" }),
    calls: [
      edit("src/a.ts", { run_id: "run:1", ordinal: 20 }),
      read(PAGE, { run_id: "run:1", ordinal: 10 }),
    ],
  };
  assert.deepEqual(summary(measure([unordered])), ["ok", 1, 1]);
  const reversed = {
    run: run({ run_id: "run:2" }),
    calls: [
      read(PAGE, { run_id: "run:2", ordinal: 40 }),
      edit("src/a.ts", { run_id: "run:2", ordinal: 30 }),
    ],
  };
  assert.deepEqual(summary(measure([reversed])), ["ok", 0, 1]);
});

it("reads a page by its path under the knowledge directory, wherever the project is", () => {
  const paths = [
    "/home/me/project/.knowledge/testing.md",
    "C:\\Users\\me\\project\\.knowledge\\testing.md",
    ".knowledge/nested/deep.md",
  ];
  assert.deepEqual(summary(measure(paths.map((path, index) => editing(`run:${index}`, [path])))), [
    "ok",
    1,
    3,
  ]);
  // Neither is the directory as a path segment.
  const elsewhere = ["src/old.knowledge/testing.md", "src/knowledge/testing.md", ".knowledge"];
  assert.deepEqual(
    summary(measure(elsewhere.map((path, index) => editing(`run:${index}`, [path])))),
    ["ok", 0, 3],
  );
});

it("counts a search or a command that names a page as no read", () => {
  const searched = {
    run: run({ run_id: "run:1" }),
    calls: [
      call({ run_id: "run:1", tool_name: "Grep", path: PAGE }),
      call({ run_id: "run:1", item_type: "command_execution", tool_name: null, path: PAGE }),
      edit("src/a.ts", { run_id: "run:1" }),
    ],
  };
  assert.deepEqual(summary(measure([searched])), ["ok", 0, 1]);
});

it("counts only runs that started in the window and leaves out a subagent's calls", () => {
  const before = {
    run: run({ run_id: "run:before", started_at: BEFORE }),
    calls: [read(PAGE, { run_id: "run:before" }), edit("src/a.ts", { run_id: "run:before" })],
  };
  // The subagent's read has no run, so it is nobody's read before the edit.
  const delegated = {
    run: run({ run_id: "run:delegated" }),
    calls: [
      read(PAGE, { run_id: null, thread_id: "thread:child" }),
      edit("src/a.ts", { run_id: "run:delegated" }),
    ],
  };
  assert.deepEqual(summary(measure([before, delegated, editing("run:1", [PAGE])])), ["ok", 0.5, 2]);
});

it("is unavailable while the knowledge plugin is off, naming it", () => {
  const result = measure([editing("run:1", [PAGE])], { knowledgePages: undefined });
  assert.strictEqual(result.state, "unavailable");
  assert.match(result.missingReason ?? "", /knowledge plugin/);
});

it("is unavailable for a project with no accepted page, though runs read one", () => {
  const result = measure([editing("run:1", [PAGE])], { knowledgePages: 0 });
  assert.strictEqual(result.state, "unavailable");
  assert.strictEqual(result.missingReason, "The project has no knowledge page yet.");
});

it("is unavailable when no run in the window edited a file", () => {
  const readOnly = {
    run: run({ run_id: "run:1" }),
    calls: [read(PAGE, { run_id: "run:1" })],
  };
  for (const runs of [[readOnly], []]) {
    const result = measure(runs);
    assert.strictEqual(result.state, "unavailable");
    assert.strictEqual(result.missingReason, "No run in the window edited a file.");
  }
});

it("never stands a zero in for an answer it cannot give", () => {
  for (const result of [
    measure([editing("run:1", [PAGE])], { knowledgePages: undefined }),
    measure([editing("run:1", [PAGE])], { knowledgePages: 0 }),
    measure([]),
  ]) {
    assert.deepEqual([result.value, result.sampleSize], [null, 0]);
  }
});
