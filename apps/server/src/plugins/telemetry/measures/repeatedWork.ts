// @effect-diagnostics nodeBuiltinImport:off - a pure measure resolves paths with the host's rules.
import type {
  TelemetryExtractionCandidate,
  TelemetryExtractionCandidatesResult,
  TelemetryExtractionForm,
  TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as NodePath from "node:path";

import { digest } from "../digest.ts";
import { COMMAND_CHARS, type FieldPath } from "../fields.ts";
import { programName, runsInlineScript, unwrapShell } from "./commandProgram.ts";
import {
  type Measure,
  type MeasureInput,
  ok,
  type Spec,
  type ToolCallRow,
  unavailable,
  windowCalls,
} from "./input.ts";
import { toolKey } from "./toolOutput.ts";

/*
 * Repeated deterministic work: tool calls, or sequences of them, that several threads repeat,
 * which a script, a hook, a server tool, a scheduled task, a context file or a skill could do
 * without model tokens. Everything here is a pure function of the window's rows.
 */

export const SHARE = "deterministic_work_share";
export const CANDIDATES = "extraction_candidates";

/** A candidate repeats in at least this many threads, and a window with fewer has none. */
const MIN_THREADS = 3;
/** A procedure is two to this many shapes in a row. */
const MAX_STEPS = 6;
/** Candidates the measure's detail keeps, and the most the MCP tool lists. */
const CANDIDATE_ROWS = 20;
/** The share a form's rule asks for: of occurrences, of runs, or the deterministic ratio. */
const MOST = 0.8;
/** A context file's reads start within this many steps of the run's first. */
const OPENING_STEPS = 3;
/** A scheduled task's occurrences fall on at least this many UTC days, one a day. */
const MIN_DAYS = 5;

const FEWER_THREADS = "Fewer than three threads in window.";

/** Tool keys of the reads and searches. */
const GATHERS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "file_search"]);

/** Joins a window's shapes into one key; no shape holds it. */
const SEPARATOR = "\u0000";

const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const INTEGER = /^\d+$/;

/** A script's step starts with this, and holds this many characters of its input's digest. */
const SCRIPT = "script:";
const SCRIPT_DIGEST_CHARS = 12;

/** A path token: a word with a slash or a backslash in it. */
const isPath = (token: string) => token.includes("/") || token.includes("\\");

/**
 * An absolute path that resolves under `directory`, itself resolved, as relative to it (`.` for
 * the directory itself). A path that resolves outside it, such as `/work/acme/../outside` or
 * `/work/acme2/x` under `/work/acme`, and a relative path, which the measure has no directory to
 * resolve against, stay as recorded.
 */
const relative = (path: string, directory: string | null) => {
  if (directory === null || !NodePath.isAbsolute(path)) return path;
  const inside = NodePath.relative(directory, NodePath.resolve(path));
  if (inside === "") return ".";
  return NodePath.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${NodePath.sep}`)
    ? path
    : inside;
};

/** A call's exact shape, with paths and patterns kept, and its slot shape, with them as slots. */
export interface Shape {
  readonly exact: string;
  readonly slot: string;
}

/**
 * A tool call's shape, or null for a call that is none: a file change, a web search, a file
 * search with no pattern, or a call whose input is not recorded (an event a compaction removed
 * before migration 5 left no `input_digest`).
 *
 * A command is its command line out of its shell wrapper, split on whitespace, with quoted
 * strings as `<str>`, integers as `<n>` and paths under the project's directory made relative.
 * A script is `script:<program>:` and the start of its input's digest instead: an interpreter
 * running a script written into the command line, or any command line as long as the head the
 * reactor keeps of it. A dynamic tool with a pattern or a path is its name, its pattern, then its
 * path; any other is its name with its input's keys. A file search is `file_search:` and its
 * pattern.
 */
export const shapeOf = (call: ToolCallRow, directory: string | null): Shape | null => {
  if (call.input_digest === null) return null;
  switch (call.item_type) {
    case "command_execution": {
      if (call.command === null) return null;
      // Quoted strings as `<str>` would make every `node -e '...'` one step, and the reactor keeps
      // only a command line's first `COMMAND_CHARS` characters, so a head that long may be cut
      // short. Such a command matches only the same input, by its digest.
      if (call.command.length >= COMMAND_CHARS || runsInlineScript(call.command)) {
        const program = programName(call.command) ?? "unknown";
        const step = `${SCRIPT}${program}:${call.input_digest.slice(0, SCRIPT_DIGEST_CHARS)}`;
        return { exact: step, slot: step };
      }
      const tokens = unwrapShell(call.command)
        .replace(QUOTED, "<str>")
        .split(/\s+/)
        .filter((token) => token !== "");
      const parts = tokens.map((token): Shape => {
        if (INTEGER.test(token)) return { exact: "<n>", slot: "<n>" };
        if (isPath(token)) return { exact: relative(token, directory), slot: "<path>" };
        return { exact: token, slot: token };
      });
      return {
        exact: `command:${parts.map((part) => part.exact).join(" ")}`,
        slot: `command:${parts.map((part) => part.slot).join(" ")}`,
      };
    }
    case "dynamic_tool": {
      const tool = toolKey(call);
      if (call.pattern === null && call.path === null) {
        const keyed = `${tool}(${call.input_keys ?? ""})`;
        return { exact: keyed, slot: keyed };
      }
      const pattern = call.pattern === null ? [] : [call.pattern];
      const path = call.path === null ? [] : [relative(call.path, directory)];
      return {
        exact: [tool, ...pattern, ...path].join(" "),
        slot: [tool, ...pattern.map(() => "<pattern>"), ...path.map(() => "<path>")].join(" "),
      };
    }
    case "file_search":
      return call.pattern === null
        ? null
        : { exact: `file_search:${call.pattern}`, slot: "file_search:<pattern>" };
    default:
      return null;
  }
};

/** One shaped call of a run, with what the form rules ask of it. */
interface Step extends Shape {
  readonly call: ToolCallRow;
  /** A read or a search. */
  readonly gathers: boolean;
  /** A file change came after the run's previous step, or before its first. */
  readonly afterEdit: boolean;
}

interface Run {
  readonly key: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly steps: ReadonlyArray<Step>;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The calls grouped into runs, each with its shapes in the order they ran. A call with no run,
 * which a provider's subagent makes, groups by its provider turn, and one with neither is left
 * out.
 */
const runsOf = (calls: ReadonlyArray<ToolCallRow>, directory: string | null) => {
  const groups = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const key =
      call.run_id !== null
        ? `run:${call.run_id}`
        : call.provider_turn_id !== null
          ? `turn:${call.thread_id}:${call.provider_turn_id}`
          : null;
    if (key === null) continue;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [call]);
    else group.push(call);
  }
  return [...groups]
    .toSorted(([a], [b]) => byText(a, b))
    .map(([key, group]): Run => {
      const steps: Step[] = [];
      let afterEdit = false;
      for (const call of group.toSorted((a, b) => a.ordinal - b.ordinal)) {
        if (call.item_type === "file_change") {
          afterEdit = true;
          continue;
        }
        const shape = shapeOf(call, directory);
        if (shape === null) continue;
        steps.push({ ...shape, call, gathers: GATHERS.has(toolKey(call)), afterEdit });
        afterEdit = false;
      }
      return { key, threadId: group[0]!.thread_id, runId: group[0]!.run_id, steps };
    });
};

type List = "exact" | "slot";

interface Occurrence {
  readonly run: Run;
  readonly start: number;
}

/** Shapes in a row that runs in at least three threads hold, from one list of shapes. */
interface Found {
  readonly steps: ReadonlyArray<string>;
  readonly key: string;
  readonly occurrences: ReadonlyArray<Occurrence>;
  readonly threads: number;
}

const stepsAt = ({ run, start }: Occurrence, length: number) =>
  run.steps.slice(start, start + length);

/**
 * Every window of one to six shapes in a row, from each run's `list` shapes, that runs in at
 * least three threads hold. A window is counted only when both windows one shape shorter were
 * found, since it cannot be in more threads than either.
 */
const mine = (runs: ReadonlyArray<Run>, list: List) => {
  const shapes = runs.map((run) => run.steps.map((step) => step[list]));
  const found: Found[] = [];
  let shorter = new Set<string>();
  for (let length = 1; length <= MAX_STEPS; length += 1) {
    const counted = new Map<string, { steps: ReadonlyArray<string>; occurrences: Occurrence[] }>();
    runs.forEach((run, index) => {
      const all = shapes[index]!;
      for (let start = 0; start + length <= all.length; start += 1) {
        const steps = all.slice(start, start + length);
        if (
          length > 1 &&
          !(
            shorter.has(steps.slice(0, -1).join(SEPARATOR)) &&
            shorter.has(steps.slice(1).join(SEPARATOR))
          )
        ) {
          continue;
        }
        const key = steps.join(SEPARATOR);
        const entry = counted.get(key);
        if (entry === undefined) counted.set(key, { steps, occurrences: [{ run, start }] });
        else entry.occurrences.push({ run, start });
      }
    });
    shorter = new Set();
    for (const [key, { steps, occurrences }] of counted) {
      const threads = new Set(occurrences.map(({ run }) => run.threadId)).size;
      if (threads < MIN_THREADS) continue;
      shorter.add(key);
      found.push({ steps, key, occurrences, threads });
    }
    if (shorter.size === 0) break;
  }
  return found;
};

/**
 * `found` without a window that a window one shape longer holds as many times in as many threads,
 * so a procedure is reported once, at its longest.
 */
const longest = (found: ReadonlyArray<Found>) => {
  const byKey = new Map(found.map((window) => [window.key, window]));
  const held = new Set<string>();
  for (const window of found) {
    if (window.steps.length === 1) continue;
    for (const part of [window.steps.slice(0, -1), window.steps.slice(1)]) {
      const inner = byKey.get(part.join(SEPARATOR));
      if (
        inner !== undefined &&
        inner.occurrences.length === window.occurrences.length &&
        inner.threads === window.threads
      ) {
        held.add(inner.key);
      }
    }
  }
  return found.filter((window) => !held.has(window.key));
};

/**
 * Whether a slot window is a varying candidate: the steps whose path or pattern differs between
 * its occurrences are at least two different steps, such as `Grep <pattern> <path>` then
 * `Read <path>`. One step with a different path or pattern each time, alone, repeated or next to
 * fixed steps, is the agent choosing one call's input, which no extraction takes over; `Read
 * <path>` alone would be a candidate in almost any project and outweigh every procedure.
 */
const varies = (window: Found) => {
  const differing = new Set<string>();
  window.steps.forEach((slot, index) => {
    const exact = new Set(
      window.occurrences.map(({ run, start }) => run.steps[start + index]!.exact),
    );
    if (exact.size > 1) differing.add(slot);
  });
  return differing.size > 1;
};

/** Occurrences whose raw inputs match the most common ones, over all occurrences. */
const deterministicRatio = (window: Found) => {
  const tuples = new Map<string, number>();
  for (const occurrence of window.occurrences) {
    const tuple = stepsAt(occurrence, window.steps.length)
      .map((step) => step.call.input_digest)
      .join(SEPARATOR);
    tuples.set(tuple, (tuples.get(tuple) ?? 0) + 1);
  }
  const most = [...tuples.values()].reduce((max, count) => Math.max(max, count), 0);
  return most / window.occurrences.length;
};

const atLeastMost = (part: number, total: number) => total > 0 && part / total >= MOST;

/** The first form whose rule the candidate meets. */
const formOf = (window: Found, fixed: boolean, ratio: number): TelemetryExtractionForm => {
  const { occurrences, steps } = window;
  const first = stepsAt(occurrences[0]!, steps.length);
  const commands = first.every((step) => step.call.item_type === "command_execution");
  const gathers = first.every((step) => step.gathers);
  const afterEdit = occurrences.filter(({ run, start }) => run.steps[start]!.afterEdit).length;
  if (steps.length === 1 && commands && atLeastMost(afterEdit, occurrences.length)) return "hook";
  if (fixed && gathers) {
    const runs = new Set(occurrences.map(({ run }) => run.key));
    const opening = new Set(
      occurrences.filter(({ start }) => start < OPENING_STEPS).map(({ run }) => run.key),
    );
    if (atLeastMost(opening.size, runs.size)) return "context_file";
  }
  if (fixed) {
    const days = new Set(
      occurrences.map(({ run, start }) => run.steps[start]!.call.item_at?.slice(0, 10) ?? null),
    );
    if (!days.has(null) && days.size >= MIN_DAYS && days.size === occurrences.length) {
      return "scheduled_task";
    }
  }
  if (fixed && commands && ratio >= MOST) return "script";
  if (!fixed && gathers) return "mcp_tool";
  return "skill";
};

/** What a call cost: its output and its input, in estimated tokens. */
const tokensOf = (call: ToolCallRow) => (call.output_tokens ?? 0) + (call.input_tokens ?? 0);

const candidateOf = (window: Found, fixed: boolean): TelemetryExtractionCandidate => {
  const length = window.steps.length;
  const ratio = deterministicRatio(window);
  const example = window.occurrences[0]!;
  return {
    id: digest(window.key).slice(0, 16),
    kind: length === 1 ? "step" : "procedure",
    steps: window.steps,
    threads: window.threads,
    occurrences: window.occurrences.length,
    deterministicRatio: ratio,
    estimatedTokens: window.occurrences
      .flatMap((occurrence) => stepsAt(occurrence, length))
      .reduce((total, step) => total + tokensOf(step.call), 0),
    form: formOf(window, fixed, ratio),
    example: {
      threadId: example.run.threadId,
      runId: example.run.runId,
      itemIds: stepsAt(example, length).map((step) => step.call.item_id),
      scripts: stepsAt(example, length).map((step) =>
        step.exact.startsWith(SCRIPT) ? step.call.command : null,
      ),
    },
  };
};

interface RepeatedWork {
  /** Threads with a tool call in the window. */
  readonly threads: number;
  /** Tool calls in the window. */
  readonly calls: number;
  /** Every candidate, most estimated tokens first, then most threads. */
  readonly candidates: ReadonlyArray<TelemetryExtractionCandidate>;
  /** Estimated tokens of the calls some candidate holds, each counted once. */
  readonly covered: number;
  /** Estimated tokens of every tool call in the window. */
  readonly total: number;
}

/** Both measures read one window's mining, done once per input. */
const mined = new WeakMap<MeasureInput, RepeatedWork>();

/**
 * The window's candidates: every exact window that three threads repeat, and every slot window
 * that `varies`. A slot window whose occurrences all share one exact shape is that exact window
 * again, and is dropped.
 */
const repeatedWork = (input: MeasureInput): RepeatedWork => {
  const cached = mined.get(input);
  if (cached !== undefined) return cached;
  const calls = windowCalls(input);
  const threads = new Set(calls.map((call) => call.thread_id)).size;
  const total = calls.reduce((sum, call) => sum + tokensOf(call), 0);
  const directory =
    input.projectDirectory !== null && NodePath.isAbsolute(input.projectDirectory)
      ? NodePath.resolve(input.projectDirectory)
      : null;
  const runs = threads < MIN_THREADS ? [] : runsOf(calls, directory);
  const windows = [
    ...longest(mine(runs, "exact")).map((window) => ({ window, fixed: true })),
    ...longest(mine(runs, "slot")).flatMap((window) =>
      varies(window) ? [{ window, fixed: false }] : [],
    ),
  ];
  const held = new Map<string, ToolCallRow>();
  for (const { window } of windows) {
    for (const occurrence of window.occurrences) {
      for (const step of stepsAt(occurrence, window.steps.length)) {
        held.set(step.call.item_id, step.call);
      }
    }
  }
  const result: RepeatedWork = {
    threads,
    calls: calls.length,
    candidates: windows
      .map(({ window, fixed }) => candidateOf(window, fixed))
      .toSorted(
        (a, b) =>
          b.estimatedTokens - a.estimatedTokens ||
          b.threads - a.threads ||
          byText(a.steps.join("\n"), b.steps.join("\n")),
      ),
    covered: [...held.values()].reduce((sum, call) => sum + tokensOf(call), 0),
    total,
  };
  mined.set(input, result);
  return result;
};

const PROVENANCE = [
  "run.id",
  "run.startedAt",
  "turnItem.id",
  "turnItem.runId",
  "turnItem.providerTurnId",
  "turnItem.threadId",
  "turnItem.ordinal",
  "turnItem.type",
  "turnItem.toolName",
  "turnItem.input",
  "turnItem.pattern",
  "turnItem.output",
  "turnItem.results",
  "turnItem.startedAt",
  "turnItem.updatedAt",
] as const satisfies ReadonlyArray<FieldPath>;

const shareSpec = {
  measure: SHARE,
  unit: "ratio",
  direction: "lower_is_better",
  provenance: PROVENANCE,
} as const satisfies Spec;

/**
 * The share of the window's tool call tokens, output and input, spent on calls an extraction
 * candidate holds, each call counted once however many candidates hold it. Over the tool calls in
 * the window; 0 when they are all empty.
 */
export const deterministicWorkShare: Measure = (input) => {
  const work = repeatedWork(input);
  if (work.threads < MIN_THREADS) return unavailable(shareSpec, FEWER_THREADS);
  return ok(shareSpec, work.total === 0 ? 0 : work.covered / work.total, work.calls);
};

const candidatesSpec = {
  measure: CANDIDATES,
  unit: "count",
  direction: "lower_is_better",
  provenance: PROVENANCE,
} as const satisfies Spec;

/** How many extraction candidates the window has, over its threads, with the twenty costliest. */
export const extractionCandidates: Measure = (input) => {
  const work = repeatedWork(input);
  if (work.threads < MIN_THREADS) return unavailable(candidatesSpec, FEWER_THREADS);
  return ok(candidatesSpec, work.candidates.length, work.threads, null, {
    candidates: work.candidates.slice(0, CANDIDATE_ROWS),
  });
};

/**
 * The candidates as the `telemetry_extraction_candidates` tool answers them: the first `limit`
 * of the measure's, or none with the reason it is unavailable.
 */
export const extractionCandidatesOf = (
  measures: TelemetryMeasuresResult,
  limit = CANDIDATE_ROWS,
): TelemetryExtractionCandidatesResult => {
  const measure = measures.find((entry) => entry.measure === CANDIDATES);
  return {
    candidates: (measure?.detail?.candidates ?? []).slice(0, limit),
    missingReason: measure?.state === "unavailable" ? measure.missingReason : null,
  };
};
