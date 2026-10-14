import { assert, it } from "@effect/vitest";
import type { TelemetryExtractionCandidate } from "@t3tools/contracts";

import { digest } from "../digest.ts";
import * as Fixtures from "../eventFixtures.ts";
import { COMMAND_CHARS } from "../fields.ts";
import { call, INSIDE, input, rowOf, run } from "./fixtures.ts";
import type { MeasureInput, ToolCallRow } from "./input.ts";
import {
  deterministicWorkShare,
  extractionCandidates,
  extractionCandidatesOf,
  shapeOf,
} from "./repeatedWork.ts";

const DIRECTORY = "/work/acme";

/**
 * A call whose input the reactor recorded. Its digest stands in for the input's: the same for
 * the same command line, pattern, path and keys.
 */
const recorded = (overrides: Partial<ToolCallRow>): ToolCallRow => {
  const row = call(overrides);
  return {
    ...row,
    input_digest:
      overrides.input_digest ??
      digest(JSON.stringify([row.item_type, row.command, row.pattern, row.path, row.input_keys])),
  };
};

/** The step of a script whose whole input is `input`. */
const scriptStep = (program: string, input: string) =>
  `script:${program}:${digest(input).slice(0, 12)}`;

/** A 900-character Python script an agent writes out in a heredoc. */
const HEREDOC = (() => {
  const open = "cd /work/acme && python3 - <<'EOF'\nimport json, subprocess\n";
  const close =
    "\nlog = subprocess.run(['git', 'log', '-n', '20'], capture_output=True, text=True)" +
    "\nprint(json.dumps(log.stdout.splitlines()))\nEOF";
  return `${open}# ${"-".repeat(900 - open.length - close.length - 2)}${close}`;
})();

const sh = (command: string, overrides: Partial<ToolCallRow> = {}): Partial<ToolCallRow> => ({
  item_type: "command_execution",
  tool_name: null,
  path: null,
  command,
  output_tokens: 100,
  input_tokens: 10,
  ...overrides,
});

const readOf = (path: string): Partial<ToolCallRow> => ({
  tool_name: "Read",
  path,
  output_tokens: 100,
  input_tokens: 10,
});

const grepOf = (pattern: string, path: string | null): Partial<ToolCallRow> => ({
  tool_name: "Grep",
  pattern,
  path,
  output_tokens: 100,
  input_tokens: 10,
});

const edited = (path: string): Partial<ToolCallRow> => ({
  item_type: "file_change",
  tool_name: null,
  path,
});

/** `steps` as the calls of run `run:<id>` in thread `thread:<thread>`, in that order. */
const inRun = (thread: number, id: string, ...steps: ReadonlyArray<Partial<ToolCallRow>>) =>
  steps.map((step) =>
    recorded({ thread_id: `thread:${thread}`, run_id: `run:${id}`, item_at: INSIDE, ...step }),
  );

/** `steps` as the one run of thread `thread:<n>`. */
const inThread = (n: number, ...steps: ReadonlyArray<Partial<ToolCallRow>>) =>
  inRun(n, String(n), ...steps);

/** A window over the calls, each run started inside it, in the project at `DIRECTORY`. */
const windowOf = (calls: ReadonlyArray<ToolCallRow>): MeasureInput => {
  const runs = new Map(calls.flatMap((c) => (c.run_id === null ? [] : [[c.run_id, c.thread_id]])));
  return input({
    projectDirectory: DIRECTORY,
    runs: [...runs].map(([runId, threadId]) => run({ run_id: runId, thread_id: threadId })),
    toolCalls: calls,
  });
};

const candidatesOf = (window: MeasureInput) =>
  extractionCandidates(window).detail?.candidates ?? [];

const summary = (candidate: TelemetryExtractionCandidate | undefined) =>
  candidate === undefined
    ? undefined
    : {
        kind: candidate.kind,
        steps: candidate.steps,
        threads: candidate.threads,
        occurrences: candidate.occurrences,
        form: candidate.form,
      };

it("shapes a command out of its wrapper, with paths relative to the project, <n> and <str>", () => {
  const shape = (command: string) => shapeOf(recorded(sh(command)), DIRECTORY);
  assert.deepEqual(
    shape(
      `/bin/zsh -lc 'cd /work/acme/apps/web && pnpm test src/list.test.ts -t "renders the list" --retry 2'`,
    ),
    {
      exact: "command:cd apps/web && pnpm test src/list.test.ts -t <str> --retry <n>",
      slot: "command:cd <path> && pnpm test <path> -t <str> --retry <n>",
    },
  );
  assert.deepEqual(shape("pnpm test apps/web"), {
    exact: "command:pnpm test apps/web",
    slot: "command:pnpm test <path>",
  });
  assert.deepEqual(shape("git log -n 20"), {
    exact: "command:git log -n <n>",
    slot: "command:git log -n <n>",
  });
  // A path outside the project stays as it is, and the project itself is `.`.
  assert.deepEqual(shape("ls /tmp/out /work/acme /work/acme2/x"), {
    exact: "command:ls /tmp/out . /work/acme2/x",
    slot: "command:ls <path> <path> <path>",
  });
});

it("keeps a path that climbs out of the project with `..` as recorded, and resolves one that stays", () => {
  const shape = (command: string) => shapeOf(recorded(sh(command)), DIRECTORY)?.exact;
  assert.strictEqual(
    shape("cat /work/acme/../outside/a.ts"),
    "command:cat /work/acme/../outside/a.ts",
  );
  assert.strictEqual(
    shapeOf(recorded(readOf("/work/acme/../outside/a.ts")), DIRECTORY)?.exact,
    "Read /work/acme/../outside/a.ts",
  );
  // A `..` that stays inside resolves to the path it names.
  assert.strictEqual(shape("cat /work/acme/src/../lib/a.ts"), "command:cat lib/a.ts");
  // A relative path has no directory to resolve against, and stays too.
  assert.strictEqual(shape("cat ../outside/a.ts"), "command:cat ../outside/a.ts");
});

it("keeps a path in a sibling directory whose name starts with the project's as recorded", () => {
  assert.strictEqual(
    shapeOf(recorded(readOf("/work/acme2/src/a.ts")), DIRECTORY)?.exact,
    "Read /work/acme2/src/a.ts",
  );
  assert.strictEqual(
    shapeOf(recorded(sh("ls /work/acme2 /work/acme")), DIRECTORY)?.exact,
    "command:ls /work/acme2 .",
  );
  // A trailing separator on the project's directory changes nothing.
  assert.strictEqual(
    shapeOf(recorded(readOf("/work/acme/src/a.ts")), `${DIRECTORY}/`)?.exact,
    "Read src/a.ts",
  );
});

it("shapes a command as long as the stored head by its whole input's digest", () => {
  const long = `pnpm test ${"apps/web/src/components/".repeat(30)}`;
  assert.isAbove(long.length, COMMAND_CHARS);
  // The row the reactor stores for it, with the head cut at the cap.
  const row = rowOf({ ...Fixtures.commandItem, input: long });
  assert.strictEqual(row.command?.length, COMMAND_CHARS);
  const step = scriptStep("pnpm", long);
  assert.deepEqual(shapeOf(row, DIRECTORY), { exact: step, slot: step });
  // Another command with the same head is another step.
  const longer = rowOf({ ...Fixtures.commandItem, input: `${long} --watch` });
  assert.strictEqual(longer.command, row.command);
  assert.strictEqual(shapeOf(longer, DIRECTORY)?.exact, scriptStep("pnpm", `${long} --watch`));
  // One a character shorter than the cap is shaped by its words.
  const short = rowOf({ ...Fixtures.commandItem, input: long.slice(0, COMMAND_CHARS - 1) });
  assert.match(shapeOf(short, DIRECTORY)?.slot ?? "", /^command:pnpm test <path>$/);
});

it("shapes each inline script by its digest, so three different node -e scripts are three steps", () => {
  const shape = (command: string) => shapeOf(recorded(sh(command)), DIRECTORY);
  const scripts = [
    "node -e 'console.log(process.version)'",
    `node -e "console.log(require('./package.json').name)"`,
    "node -e 'process.exit(1)'",
  ];
  const shapes = scripts.map(shape);
  assert.strictEqual(new Set(shapes.map((found) => found?.exact)).size, 3);
  for (const found of shapes) {
    assert.match(found?.exact ?? "", /^script:node:[0-9a-f]{12}$/);
    assert.strictEqual(found?.slot, found?.exact);
  }
  // Inside a shell wrapper and as a heredoc, under the interpreter that runs it.
  assert.match(shape(`/bin/bash -lc "python3 -c 'print(1)'"`)?.exact ?? "", /^script:python3:/);
  assert.match(shape("python3 - <<'EOF'\nprint(1)\nEOF")?.exact ?? "", /^script:python3:/);
  // A script file, and a shell's -c wrapper around any other command, keep their words.
  assert.strictEqual(shape("node scripts/build.js")?.exact, "command:node scripts/build.js");
  assert.strictEqual(shape("bash -lc 'git status'")?.exact, "command:git status");

  // One in each of three threads: no candidate, where `node -e <str>` used to be one.
  const window = windowOf(scripts.flatMap((script, index) => inThread(index + 1, sh(script))));
  assert.deepEqual([extractionCandidates(window).state, candidatesOf(window)], ["ok", []]);
});

it("finds the same 900-character heredoc script in three threads as one script candidate", () => {
  assert.strictEqual(HEREDOC.length, 900);
  // The row the reactor stores for it: the head, the size and the digest of the whole script.
  // No column holds the script past its head.
  const stored = rowOf({ ...Fixtures.commandItem, input: HEREDOC });
  assert.strictEqual(stored.command, HEREDOC.slice(0, COMMAND_CHARS));
  const past = HEREDOC.slice(COMMAND_CHARS);
  for (const value of Object.values(stored)) {
    if (typeof value === "string") assert.notInclude(value, past);
  }
  const script = sh(stored.command ?? "", {
    input_digest: stored.input_digest,
    input_tokens: stored.input_tokens,
  });
  const candidates = candidatesOf(windowOf([1, 2, 3].flatMap((n) => inThread(n, script))));
  assert.deepEqual(candidates.map(summary), [
    {
      kind: "step",
      steps: [scriptStep("python3", HEREDOC)],
      threads: 3,
      occurrences: 3,
      form: "script",
    },
  ]);
  assert.strictEqual(candidates[0]?.deterministicRatio, 1);
  // Its example is the stored head, never the whole script.
  assert.deepEqual(candidates[0]?.example.scripts, [HEREDOC.slice(0, COMMAND_CHARS)]);
});

it("shapes a dynamic tool by its pattern and relative path, or else by its input's keys", () => {
  const shape = (overrides: Partial<ToolCallRow>, directory: string | null = DIRECTORY) =>
    shapeOf(recorded(overrides), directory);
  // Grep with a pattern and a path keeps both.
  assert.deepEqual(shape(grepOf("useEffect", "/work/acme/apps/web")), {
    exact: "Grep useEffect apps/web",
    slot: "Grep <pattern> <path>",
  });
  assert.deepEqual(shape(readOf("/work/acme/src/a.ts")), {
    exact: "Read src/a.ts",
    slot: "Read <path>",
  });
  assert.deepEqual(shape({ tool_name: "Glob", pattern: "**/*.ts", path: null }), {
    exact: "Glob **/*.ts",
    slot: "Glob <pattern>",
  });
  assert.deepEqual(
    shape({ tool_name: "mcp__t3__thread_list", path: null, input_keys: "limit,projectId" }),
    {
      exact: "mcp__t3__thread_list(limit,projectId)",
      slot: "mcp__t3__thread_list(limit,projectId)",
    },
  );
  // Without the project's directory a path stays as recorded.
  assert.strictEqual(shape(readOf("/work/acme/src/a.ts"), null)?.exact, "Read /work/acme/src/a.ts");
});

it("shapes a file search by its pattern, and leaves out edits, web searches and unrecorded inputs", () => {
  const search = (pattern: string | null) =>
    shapeOf(
      recorded({ item_type: "file_search", tool_name: null, path: null, pattern }),
      DIRECTORY,
    );
  assert.deepEqual(search("TODO"), { exact: "file_search:TODO", slot: "file_search:<pattern>" });
  assert.isNull(search(null));
  assert.isNull(shapeOf(recorded(edited("src/a.ts")), DIRECTORY));
  assert.isNull(
    shapeOf(recorded({ item_type: "web_search", tool_name: null, path: null }), DIRECTORY),
  );
  // A call whose event a compaction removed before migration 5 has no recorded input.
  assert.isNull(shapeOf(call(readOf("src/a.ts")), DIRECTORY));
});

it("groups a subagent's calls with no run by provider turn, and leaves out calls with neither", () => {
  const subagent = (n: number, providerTurn: string | null) =>
    [sh("pnpm lint"), sh("pnpm test")].map((step) =>
      recorded({
        ...step,
        thread_id: `thread:${n}`,
        run_id: null,
        provider_turn_id: providerTurn,
        item_at: INSIDE,
      }),
    );
  const grouped = candidatesOf(
    input({ toolCalls: [1, 2, 3].flatMap((n) => subagent(n, `turn:${n}`)) }),
  );
  assert.deepEqual(grouped.map(summary), [
    {
      kind: "procedure",
      steps: ["command:pnpm lint", "command:pnpm test"],
      threads: 3,
      occurrences: 3,
      form: "script",
    },
  ]);
  assert.deepEqual([grouped[0]?.example.threadId, grouped[0]?.example.runId], ["thread:1", null]);

  const ungrouped = extractionCandidates(
    input({ toolCalls: [1, 2, 3].flatMap((n) => subagent(n, null)) }),
  );
  assert.deepEqual([ungrouped.state, ungrouped.value], ["ok", 0]);
});

it("finds pnpm lint then pnpm test in three threads as one script procedure, and none in two", () => {
  const lintThenTest = (n: number) => inThread(n, sh("pnpm lint"), sh("pnpm test"));
  const calls = [1, 2, 3].flatMap(lintThenTest);
  const three = extractionCandidates(windowOf(calls));
  assert.deepEqual([three.state, three.value, three.sampleSize], ["ok", 1, 3]);
  const [candidate] = three.detail?.candidates ?? [];
  assert.deepEqual(summary(candidate), {
    kind: "procedure",
    steps: ["command:pnpm lint", "command:pnpm test"],
    threads: 3,
    occurrences: 3,
    form: "script",
  });
  // Output and input of both calls, in three runs.
  assert.deepEqual([candidate?.estimatedTokens, candidate?.deterministicRatio], [660, 1]);
  assert.deepEqual(candidate?.example, {
    threadId: "thread:1",
    runId: "run:1",
    itemIds: calls.slice(0, 2).map((c) => c.item_id),
    scripts: [null, null],
  });

  const two = extractionCandidates(
    windowOf([...[1, 2].flatMap(lintThenTest), ...inThread(3, sh("pnpm build"))]),
  );
  assert.deepEqual([two.state, two.value, two.detail?.candidates], ["ok", 0, []]);
});

it("names a command right after a file change in four of five occurrences a hook", () => {
  const afterEdits = (edits: number) =>
    candidatesOf(
      windowOf(
        [1, 2, 3, 4, 5].flatMap((n) =>
          n <= edits
            ? inThread(n, edited("src/a.ts"), sh("pnpm test"))
            : inThread(n, sh("pnpm test")),
        ),
      ),
    ).map(summary);
  // It also runs on its own, and as a fixed command it would be a script.
  assert.deepEqual(afterEdits(4), [
    { kind: "step", steps: ["command:pnpm test"], threads: 5, occurrences: 5, form: "hook" },
  ]);
  assert.deepEqual(
    afterEdits(3).map((candidate) => candidate?.form),
    ["script"],
  );
});

it("names reads of the same two files that open three threads a context file", () => {
  const candidates = candidatesOf(
    windowOf(
      [1, 2, 3].flatMap((n) =>
        inThread(n, readOf("/work/acme/AGENTS.md"), readOf("/work/acme/docs/fork.md")),
      ),
    ),
  );
  assert.deepEqual(candidates.map(summary), [
    {
      kind: "procedure",
      steps: ["Read AGENTS.md", "Read docs/fork.md"],
      threads: 3,
      occurrences: 3,
      form: "context_file",
    },
  ]);
});

it("names Grep then Read with a different pattern and file in each of three threads one varying mcp_tool procedure", () => {
  const hooks = ["useEffect", "useMemo", "useState"];
  const candidates = candidatesOf(
    windowOf(
      hooks.flatMap((pattern, index) =>
        inThread(
          index + 1,
          grepOf(pattern, "/work/acme/src"),
          readOf(`/work/acme/src/${pattern}.ts`),
        ),
      ),
    ),
  );
  assert.deepEqual(candidates.map(summary), [
    {
      kind: "procedure",
      steps: ["Grep <pattern> <path>", "Read <path>"],
      threads: 3,
      occurrences: 3,
      form: "mcp_tool",
    },
  ]);
  assert.closeTo(candidates[0]?.deterministicRatio ?? 0, 1 / 3, 0.01);

  // Grep alone is one call whose pattern the agent chose each time: nothing to extract.
  const alone = windowOf(
    hooks.flatMap((pattern, index) => inThread(index + 1, grepOf(pattern, "/work/acme/src"))),
  );
  assert.deepEqual(
    [extractionCandidates(alone).value, deterministicWorkShare(alone).value],
    [0, 0],
  );
});

it("lists a two-step procedure and none of the reads of different files around it", () => {
  const procedure = [1, 2, 3];
  const window = windowOf(
    [1, 2, 3, 4, 5, 6].flatMap((n) =>
      inThread(
        n,
        // Reads back to back, then an edit, which is no step, so the last read sits right
        // before the procedure.
        ...["a", "b", "c"].map((file) => ({
          ...readOf(`/work/acme/src/${n}/${file}.ts`),
          output_tokens: 500,
        })),
        edited(`/work/acme/src/${n}/a.ts`),
        ...(procedure.includes(n) ? [sh("pnpm lint"), sh("pnpm test")] : []),
      ),
    ),
  );
  // `Read <path>`, twice and three times in a row, and three reads then the procedure, used to
  // be four varying candidates, each costing more than the procedure.
  assert.deepEqual(candidatesOf(window).map(summary), [
    {
      kind: "procedure",
      steps: ["command:pnpm lint", "command:pnpm test"],
      threads: 3,
      occurrences: 3,
      form: "script",
    },
  ]);
  // Its 660 of the 18 reads' 9,180 tokens and its own.
  assert.strictEqual(deterministicWorkShare(window).value, 660 / 9840);
});

it("names a command run once a day on five days a scheduled task, and not when two share a day", () => {
  const daily = (days: ReadonlyArray<string>) =>
    candidatesOf(
      windowOf(
        days.flatMap((day, index) =>
          inThread(index + 1, sh("pnpm audit", { item_at: `2026-10-${day}T09:00:00.000Z` })),
        ),
      ),
    ).map((candidate) => candidate.form);
  assert.deepEqual(daily(["01", "02", "03", "04", "05"]), ["scheduled_task"]);
  assert.deepEqual(daily(["01", "02", "03", "04", "05", "05"]), ["script"]);
});

it("names a mixed candidate that meets no earlier rule a skill", () => {
  const candidates = candidatesOf(
    windowOf([1, 2, 3].flatMap((n) => inThread(n, readOf("/work/acme/src/a.ts"), sh("pnpm test")))),
  );
  assert.deepEqual(candidates.map(summary), [
    {
      kind: "procedure",
      steps: ["Read src/a.ts", "command:pnpm test"],
      threads: 3,
      occurrences: 3,
      form: "skill",
    },
  ]);
});

it("gives two identical raw inputs and one differing a deterministic ratio of two thirds", () => {
  const [candidate] = candidatesOf(
    windowOf([
      ...inThread(1, sh("git log -n 20")),
      ...inThread(2, sh("git log -n 20")),
      ...inThread(3, sh("git log -n 50")),
    ]),
  );
  assert.deepEqual(candidate?.steps, ["command:git log -n <n>"]);
  assert.closeTo(candidate?.deterministicRatio ?? 0, 0.67, 0.01);
  // Fixed and all commands, but too varied for a script.
  assert.strictEqual(candidate?.form, "skill");
});

it("counts a call once in the share when a step candidate sits inside a procedure candidate", () => {
  const step = (command: string, tokens: number) =>
    sh(command, { output_tokens: tokens, input_tokens: 0 });
  const window = windowOf([
    ...[1, 2, 3].flatMap((n) => inThread(n, step("pnpm lint", 100), step("pnpm test", 200))),
    ...inThread(4, step("pnpm lint", 100)),
    ...inThread(5, step("pnpm build", 300)),
  ]);
  // `pnpm lint` runs in four threads and the pair in three, so both are candidates.
  assert.deepEqual(
    candidatesOf(window).map((candidate) => candidate.steps),
    [["command:pnpm lint", "command:pnpm test"], ["command:pnpm lint"]],
  );
  const share = deterministicWorkShare(window);
  // Four lints and three tests of the 1,300 tokens, the lints in the pair counted once.
  assert.deepEqual([share.state, share.value, share.sampleSize], ["ok", 1000 / 1300, 8]);
  assert.deepEqual([share.unit, share.direction], ["ratio", "lower_is_better"]);
});

it("ranks by estimated tokens then threads, and keeps the twenty costliest", () => {
  const ranked = candidatesOf(
    windowOf([
      ...[1, 2, 3].flatMap((n) =>
        inRun(n, `${n}:a`, sh("pnpm a", { output_tokens: 100, input_tokens: 0 })),
      ),
      ...[1, 2, 3, 4].flatMap((n) =>
        inRun(n, `${n}:b`, sh("pnpm b", { output_tokens: 75, input_tokens: 0 })),
      ),
      ...[1, 2, 3].flatMap((n) =>
        inRun(n, `${n}:c`, sh("pnpm c", { output_tokens: 200, input_tokens: 0 })),
      ),
    ]),
  );
  assert.deepEqual(
    ranked.map((candidate) => [candidate.steps[0], candidate.estimatedTokens, candidate.threads]),
    [
      ["command:pnpm c", 600, 3],
      ["command:pnpm b", 300, 4],
      ["command:pnpm a", 300, 3],
    ],
  );

  // Each command in a run of its own, so no procedure joins them.
  const many = extractionCandidates(
    windowOf(
      Array.from({ length: 25 }, (_, k) =>
        [1, 2, 3].flatMap((n) =>
          inRun(n, `${n}:${k}`, sh(`task${k}`, { output_tokens: k, input_tokens: 0 })),
        ),
      ).flat(),
    ),
  );
  assert.strictEqual(many.value, 25);
  assert.strictEqual(many.detail?.candidates?.length, 20);
  assert.deepEqual(many.detail?.candidates?.[0]?.steps, ["command:task24"]);
});

it("answers unavailable for an empty window and for one of two threads", () => {
  const twoThreads = windowOf([...inThread(1, sh("pnpm lint")), ...inThread(2, sh("pnpm lint"))]);
  for (const window of [input(), twoThreads]) {
    for (const measure of [deterministicWorkShare(window), extractionCandidates(window)]) {
      assert.deepEqual(
        [measure.state, measure.value, measure.missingReason],
        ["unavailable", null, "Fewer than three threads in window."],
      );
    }
  }
});

it("lists the first candidates for the MCP tool, or none with the reason", () => {
  const window = windowOf([
    ...[1, 2, 3].flatMap((n) => inThread(n, sh("pnpm lint"), sh("pnpm test"))),
    ...inThread(4, sh("pnpm lint")),
  ]);
  const measures = [extractionCandidates(window)];
  assert.strictEqual(candidatesOf(window).length, 2);
  assert.deepEqual(extractionCandidatesOf(measures, 1), {
    candidates: candidatesOf(window).slice(0, 1),
    missingReason: null,
  });
  assert.deepEqual(extractionCandidatesOf([extractionCandidates(input())]), {
    candidates: [],
    missingReason: "Fewer than three threads in window.",
  });
});
