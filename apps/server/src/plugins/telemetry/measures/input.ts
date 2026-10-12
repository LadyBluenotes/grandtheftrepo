import type { LearningCorrection, TelemetryMeasure } from "@t3tools/contracts";
import { classifyToolActivity } from "@t3tools/shared/toolActivity";
import * as DateTime from "effect/DateTime";

import type { RateTable } from "../../../usage/usagePricing.ts";
import type { FieldPath } from "../fields.ts";

/** A `telemetry_threads` row. Instants are ISO strings from `DateTime.formatIso`, so they sort. */
export interface ThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly created_at: string;
  /** Set when the thread is a child task (subagent) of another thread. */
  readonly parent_thread_id: string | null;
  /** The latest settlement, kept after a reopen. */
  readonly settled_at: string | null;
  /** 1 when the automatic settlement sweep made the latest settlement. */
  readonly settled_by_sweep: number;
  /** The latest reopen, kept after the thread settles again. */
  readonly unsettled_at: string | null;
  readonly pull_request_merged_at: string | null;
}

export interface RunRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly model: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

export interface ToolCallRow {
  readonly item_id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly ordinal: number;
  readonly item_type: string;
  readonly tool_name: string | null;
  readonly path: string | null;
  readonly status: string;
}

/** A provider turn's latest usage report. A counter is null when the provider left it out. */
export interface TurnUsageRow {
  readonly provider_turn_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly output_tokens: number | null;
}

/** The rate tables the Usage page prices with: LiteLLM's, the user's overrides, and model aliases. */
export interface Pricing {
  readonly rates: RateTable;
  readonly overrides: RateTable;
  readonly aliases: ReadonlyMap<string, string>;
}

/**
 * Everything one window's measures read: a project's rows, loaded by `MeasureService`, and the
 * window `[from, to)` as normalized ISO instants. Measures pick their own rows from it.
 */
export interface MeasureInput {
  readonly from: string;
  readonly to: string;
  readonly threads: ReadonlyArray<ThreadRow>;
  readonly runs: ReadonlyArray<RunRow>;
  readonly toolCalls: ReadonlyArray<ToolCallRow>;
  readonly turnUsage: ReadonlyArray<TurnUsageRow>;
  /** Undefined while the learning plugin is not running. */
  readonly corrections: ReadonlyArray<LearningCorrection> | undefined;
  readonly pricing: Pricing;
}

export type Measure = (input: MeasureInput) => TelemetryMeasure;

/** What a measure is, apart from its value. `provenance` lists only paths `fields.ts` reads. */
export interface Spec extends Pick<TelemetryMeasure, "measure" | "unit" | "direction"> {
  readonly provenance: ReadonlyArray<FieldPath>;
}

export const ok = (
  spec: Spec,
  value: number,
  sampleSize: number,
  missingReason: string | null = null,
): TelemetryMeasure => ({ ...spec, state: "ok", value, sampleSize, missingReason });

export const unavailable = (spec: Spec, missingReason: string): TelemetryMeasure => ({
  ...spec,
  state: "unavailable",
  value: null,
  sampleSize: 0,
  missingReason,
});

/** Half-open: `from` inclusive, `to` exclusive. Null is in no window. */
export const inWindow = (input: Pick<MeasureInput, "from" | "to">, at: string | null) =>
  at !== null && at >= input.from && at < input.to;

export const seconds = (from: string, to: string) =>
  (DateTime.toEpochMillis(DateTime.makeUnsafe(to)) -
    DateTime.toEpochMillis(DateTime.makeUnsafe(from))) /
  1000;

/** The fields `acceptedOutcomes` reads. */
export const ACCEPTED_PROVENANCE = [
  "thread.lineage.parentThreadId",
  "thread.lineage.relationshipToParent",
  "thread.settledAt",
  "thread.unsettledAt",
  "thread.pullRequests.snapshot.mergedAt",
  "thread.settled.commandId",
] as const satisfies ReadonlyArray<FieldPath>;

/**
 * Threads accepted in the window: settled in it with no reopen since, and either a pull request
 * merged or settled by hand. A settlement by the inactivity sweep with nothing merged is not an
 * acceptance. Child tasks are part of their parent's outcome, not outcomes of their own.
 */
export const acceptedOutcomes = (input: MeasureInput) =>
  input.threads.filter(
    (thread): thread is ThreadRow & { readonly settled_at: string } =>
      thread.parent_thread_id === null &&
      thread.settled_at !== null &&
      inWindow(input, thread.settled_at) &&
      (thread.unsettled_at === null || thread.unsettled_at < thread.settled_at) &&
      (thread.pull_request_merged_at !== null || thread.settled_by_sweep === 0),
  );

/** Runs that started in the window. */
export const windowRuns = (input: MeasureInput) =>
  input.runs.filter((run) => inWindow(input, run.started_at));

/** The fields the tool call helpers read. */
export const TOOL_CALL_PROVENANCE = [
  "run.id",
  "run.startedAt",
  "turnItem.runId",
  "turnItem.ordinal",
  "turnItem.type",
  "turnItem.toolName",
  "turnItem.input",
  "turnItem.fileName",
] as const satisfies ReadonlyArray<FieldPath>;

const action = (call: ToolCallRow) =>
  classifyToolActivity({
    itemType: call.item_type,
    data: { toolName: call.tool_name ?? undefined },
  });

/** The path a call read: a read tool whose input has a path. Search and fetch tools are not reads. */
export const readPath = (call: ToolCallRow) => (action(call) === "read" ? call.path : null);

/** The path a call edited. */
export const editPath = (call: ToolCallRow) => (action(call) === "file_change" ? call.path : null);

/** Each run's tool calls in the order they ran. */
export const callsByRun = (calls: ReadonlyArray<ToolCallRow>) => {
  const byRun = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const list = byRun.get(call.run_id);
    if (list === undefined) byRun.set(call.run_id, [call]);
    else list.push(call);
  }
  for (const list of byRun.values()) list.sort((a, b) => a.ordinal - b.ordinal);
  return byRun;
};
