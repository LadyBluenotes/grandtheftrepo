import type {
  TelemetryLargestOutput,
  TelemetryMeasuresResult,
  TelemetryToolOutput,
  TelemetryToolOutputResult,
} from "@t3tools/contracts";

import type { FieldPath } from "../fields.ts";
import { programName } from "./commandProgram.ts";
import {
  inWindow,
  type Measure,
  type MeasureInput,
  ok,
  type Spec,
  type ToolCallRow,
  unavailable,
  windowRuns,
} from "./input.ts";

const TOTAL = "tool_output_total";
export const MAX_PER_CALL = "tool_output_max_per_call";

/**
 * Measures that read no routing tier. A budget on one still names a tier, because a budget needs
 * one, so the sweep asks for these without it and the budget judges every run.
 */
export const TIER_INDEPENDENT_MEASURES: ReadonlySet<string> = new Set([TOTAL, MAX_PER_CALL]);

const PROVENANCE = [
  "run.id",
  "run.startedAt",
  "turnItem.id",
  "turnItem.runId",
  "turnItem.threadId",
  "turnItem.type",
  "turnItem.toolName",
  "turnItem.input",
  "turnItem.output",
  "turnItem.results",
  "turnItem.startedAt",
  "turnItem.updatedAt",
] as const satisfies ReadonlyArray<FieldPath>;

/** The tool items that return something to the model. A file change returns nothing to size. */
const OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "dynamic_tool",
  "command_execution",
  "file_search",
  "web_search",
]);

/** Rows listed under `largest`. */
const LARGEST_ROWS = 10;

/**
 * What a call is grouped under: a dynamic tool's name (`unknown` without one), a command's
 * program as `command:<program>` (`command:unknown` when none names it), or the item type for a
 * file or web search.
 */
export const toolKey = (call: Pick<ToolCallRow, "item_type" | "tool_name" | "command">) => {
  switch (call.item_type) {
    case "dynamic_tool":
      return call.tool_name ?? "unknown";
    case "command_execution":
      return `command:${programName(call.command ?? "") ?? "unknown"}`;
    default:
      return call.item_type;
  }
};

/** What to try about a large result from this tool, or null when there is no general advice. */
export const toolOutputHint = (tool: string) => {
  if (tool.startsWith("command:")) {
    return "Filter the command or pipe it through an output shrinker.";
  }
  if (tool === "Read") return "Read a line range instead of the whole file.";
  if (tool.startsWith("mcp__")) return "Ask the tool to paginate its results.";
  return null;
};

/** The attention flag's text for the window's largest result, with the hint for its tool. */
export const toolOutputFlagText = (largest: TelemetryLargestOutput, threadTitle: string) => {
  const hint = toolOutputHint(largest.tool);
  return `Tool output: ${largest.tool} returned ~${largest.estimatedTokens} tokens in "${threadTitle}".${
    hint === null ? "" : ` ${hint}`
  }`;
};

/**
 * The window's calls with an output size, of the item types that return something. A call of a
 * run is in the window when its run started in it, as for every per-run measure. A call with no
 * run, which a provider's subagent makes, is in it when the item itself started or last changed
 * in it, and its `runId` stays null. A call whose size is not recorded yet is left out, not read
 * as zero.
 */
const outputCalls = (input: MeasureInput) => {
  const runs = new Set(windowRuns(input).map((run) => run.run_id));
  return input.toolCalls.flatMap((call) =>
    (call.run_id === null ? inWindow(input, call.item_at) : runs.has(call.run_id)) &&
    OUTPUT_TYPES.has(call.item_type) &&
    call.output_tokens !== null
      ? [{ call, tool: toolKey(call), tokens: call.output_tokens }]
      : [],
  );
};

/** Nearest-rank percentile of an ascending list, in whole percent. */
const nearestRank = (sorted: ReadonlyArray<number>, percentile: number) =>
  sorted[Math.max(0, Math.ceil((percentile * sorted.length) / 100) - 1)] ?? 0;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

const NO_ITEMS = "No tool items in window.";

const totalSpec = {
  measure: TOTAL,
  unit: "tokens",
  direction: "lower_is_better",
  provenance: PROVENANCE,
} as const satisfies Spec;

/**
 * Estimated tokens of all tool output in the window (see `outputCalls`), with each tool's calls,
 * share, median and 95th percentile, largest total first. An item with no output is a call of
 * zero. The shares are of this total and sum to one, or are all zero when every output is empty.
 */
export const toolOutputTotal: Measure = (input) => {
  const calls = outputCalls(input);
  if (calls.length === 0) return unavailable(totalSpec, NO_ITEMS);
  const sizes = new Map<string, number[]>();
  for (const { tool, tokens } of calls) {
    const list = sizes.get(tool);
    if (list === undefined) sizes.set(tool, [tokens]);
    else list.push(tokens);
  }
  const total = sum(calls.map(({ tokens }) => tokens));
  const byTool: TelemetryToolOutput[] = [...sizes]
    .map(([tool, list]) => {
      const sorted = list.toSorted((a, b) => a - b);
      const estimatedTokens = sum(sorted);
      return {
        tool,
        calls: sorted.length,
        estimatedTokens,
        share: total === 0 ? 0 : estimatedTokens / total,
        p50: nearestRank(sorted, 50),
        p95: nearestRank(sorted, 95),
      };
    })
    .toSorted((a, b) => b.estimatedTokens - a.estimatedTokens || byText(a.tool, b.tool));
  return ok(totalSpec, total, calls.length, null, { byTool });
};

const maxSpec = {
  measure: MAX_PER_CALL,
  unit: "tokens",
  direction: "lower_is_better",
  provenance: PROVENANCE,
} as const satisfies Spec;

/**
 * Estimated tokens of the largest single tool result in the window (see `outputCalls`), with the
 * ten largest. Equal sizes list by item id, so a window answers the same each time.
 */
export const toolOutputMaxPerCall: Measure = (input) => {
  const calls = outputCalls(input);
  if (calls.length === 0) return unavailable(maxSpec, NO_ITEMS);
  const largest: TelemetryLargestOutput[] = calls
    .toSorted((a, b) => b.tokens - a.tokens || byText(a.call.item_id, b.call.item_id))
    .slice(0, LARGEST_ROWS)
    .map(({ call, tool, tokens }) => ({
      tool,
      threadId: call.thread_id,
      runId: call.run_id,
      itemId: call.item_id,
      estimatedTokens: tokens,
    }));
  return ok(maxSpec, largest[0]?.estimatedTokens ?? 0, calls.length, null, { largest });
};

/**
 * The two measures' rows as the `telemetry_tool_output` tool answers them. Both lists are empty,
 * with the reason, when either measure is unavailable.
 */
export const toolOutputOf = (measures: TelemetryMeasuresResult): TelemetryToolOutputResult => {
  const total = measures.find((measure) => measure.measure === TOTAL);
  const max = measures.find((measure) => measure.measure === MAX_PER_CALL);
  return {
    byTool: total?.detail?.byTool ?? [],
    largest: max?.detail?.largest ?? [],
    missingReason:
      [total, max].find((measure) => measure?.state === "unavailable")?.missingReason ?? null,
  };
};
