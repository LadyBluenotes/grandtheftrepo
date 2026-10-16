import type {
  LearningCorrection,
  ReviewVerdict,
  RoutingTier,
  TelemetryMeasure,
} from "@t3tools/contracts";
import { classifyToolActivity } from "@t3tools/shared/toolActivity";
import * as DateTime from "effect/DateTime";

import type { RateTable } from "../../../usage/usagePricing.ts";
import type { ItemDelivery } from "../../learning/items/ItemStore.ts";
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
  /**
   * 1 when the automatic settlement sweep made the latest settlement, 0 when a person did, null
   * when that is unknown: the settlement was learned from a later event because compaction had
   * dropped its `thread.settled`.
   */
  readonly settled_by_sweep: number | null;
  /** The latest reopen (an unsettle, or a pin of a settled thread), kept after it settles again. */
  readonly unsettled_at: string | null;
  readonly pull_request_merged_at: string | null;
}

export interface RunRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly ordinal: number;
  readonly status: string;
  /** Null only until the replay after migration 3 rewrites the run. */
  readonly provider_instance_id: string | null;
  readonly model: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

export interface ToolCallRow {
  readonly item_id: string;
  /** Null for a call a provider's subagent made, which belongs to no run. */
  readonly run_id: string | null;
  /** The provider turn that groups a call with no run with the rest of its turn, when known. */
  readonly provider_turn_id: string | null;
  readonly thread_id: string;
  readonly ordinal: number;
  readonly item_type: string;
  readonly tool_name: string | null;
  readonly path: string | null;
  /** A command's command line, cut short. Null for any other item, and until the replay after migration 4. */
  readonly command: string | null;
  /** A search's pattern: a file search's, or a dynamic tool's `pattern`, else its `glob`. */
  readonly pattern: string | null;
  /** A dynamic tool's input keys, sorted and joined with commas. Null for any other item. */
  readonly input_keys: string | null;
  /** The estimated tokens of the input. Null for a file change, and until the replay after migration 5. */
  readonly input_tokens: number | null;
  /** The input's sha256, equal for equal inputs. Null as `input_tokens` is. */
  readonly input_digest: string | null;
  /** The estimated tokens of the output; null for an item with none to size, and until the same replay. */
  readonly output_tokens: number | null;
  /** When the item started, else when it last changed; places a call with no run. Null until the replay after migration 4. */
  readonly item_at: string | null;
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
  /**
   * Set when `MeasureService` kept only the runs on this routing tier's model, with their tool
   * calls and turn usage; threads are all the project's either way.
   */
  readonly tier: RoutingTier | undefined;
  /** The project's directory, which paths under it are made relative to; null when unknown. */
  readonly projectDirectory: string | null;
  readonly threads: ReadonlyArray<ThreadRow>;
  readonly runs: ReadonlyArray<RunRow>;
  readonly toolCalls: ReadonlyArray<ToolCallRow>;
  readonly turnUsage: ReadonlyArray<TurnUsageRow>;
  /** Undefined while the learning plugin is not running. */
  readonly corrections: ReadonlyArray<LearningCorrection> | undefined;
  /**
   * Each failure mode the project handed over, with when, whatever its item's state now.
   * Undefined while the learning plugin is not running.
   */
  readonly deliveries: ReadonlyArray<ItemDelivery> | undefined;
  /**
   * Every verdict the project has had before `to`, not only the window's: a thread's first
   * verdict can predate the window. Undefined while the review plugin is not running.
   */
  readonly verdicts: ReadonlyArray<ReviewVerdict> | undefined;
  /**
   * How many accepted knowledge pages the project has now. Undefined while the knowledge plugin is
   * not running.
   */
  readonly knowledgePages: number | undefined;
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
  detail?: TelemetryMeasure["detail"],
): TelemetryMeasure => ({
  ...spec,
  state: "ok",
  value,
  sampleSize,
  missingReason,
  ...(detail === undefined ? {} : { detail }),
});

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
  "thread.pinned.occurredAt",
] as const satisfies ReadonlyArray<FieldPath>;

/**
 * Threads accepted in the window: settled in it with no reopen since, and either a pull request
 * merged or settled by hand. A settlement by the inactivity sweep with nothing merged is not an
 * acceptance, and neither is one whose origin is unknown: without a merge it counts only when it
 * is known to be by hand. Child tasks are part of their parent's outcome, not outcomes of their own.
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

/**
 * The window's tool calls. A call of a run is in the window when its run started in it, as for
 * every per-run measure. A call with no run, which a provider's subagent makes, is in it when the
 * item itself started or last changed in it.
 */
export const windowCalls = (input: MeasureInput) => {
  const runs = new Set(windowRuns(input).map((run) => run.run_id));
  return input.toolCalls.filter((call) =>
    call.run_id === null ? inWindow(input, call.item_at) : runs.has(call.run_id),
  );
};

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

/**
 * Each run's tool calls in the order they ran. A call with no run is left out on purpose: the
 * measures built on this look at what a run did, and a subagent's call is in none.
 */
export const callsByRun = (calls: ReadonlyArray<ToolCallRow>) => {
  const byRun = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    if (call.run_id === null) continue;
    const list = byRun.get(call.run_id);
    if (list === undefined) byRun.set(call.run_id, [call]);
    else list.push(call);
  }
  for (const list of byRun.values()) list.sort((a, b) => a.ordinal - b.ordinal);
  return byRun;
};
