/**
 * Usage history for Copilot: the `session.usage_checkpoint` events in each
 * session's `events.jsonl` under `<COPILOT_HOME>/session-state`. Per-call
 * `assistant.usage` events are ephemeral and never reach the log; checkpoints
 * carry cumulative per-model totals, so each one is reported as the delta
 * from the previous checkpoint in the same file.
 *
 * @module provider-copilot/server/usage
 */
import type { UsageTokenTotals } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

import type { CopilotSettings } from "../settings.ts";

const CumulativeUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  reasoningTokens: Schema.Number,
});
type CumulativeUsage = typeof CumulativeUsage.Type;

/** The file's session id (from its `session.start`) and the last cumulative totals per model. */
export const CopilotScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  models: Schema.mutableKey(Schema.Record(Schema.String, CumulativeUsage)),
});
export type CopilotScanState = typeof CopilotScanState.Type;

export const initialCopilotScanState = (): CopilotScanState => ({ sessionId: "", models: {} });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCumulativeUsage(value: unknown): CumulativeUsage | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: tokenCount(value.inputTokens),
    outputTokens: tokenCount(value.outputTokens),
    cacheReadTokens: tokenCount(value.cacheReadTokens),
    cacheWriteTokens: tokenCount(value.cacheWriteTokens),
    reasoningTokens: tokenCount(value.reasoningTokens),
  };
}

/** The growth since `previous`; a checkpoint below it is a fresh count, not a decrease. */
function usageDelta(
  current: CumulativeUsage,
  previous: CumulativeUsage | undefined,
): CumulativeUsage {
  if (previous === undefined) return current;
  const fields = Object.keys(current) as ReadonlyArray<keyof CumulativeUsage>;
  if (fields.some((field) => current[field] < previous[field])) return current;
  return Object.fromEntries(
    fields.map((field) => [field, current[field] - previous[field]]),
  ) as unknown as CumulativeUsage;
}

/**
 * Copilot does not say whether `inputTokens` includes the cached tokens. This
 * assumes it does when the count is large enough to, and that a smaller count
 * already excludes them. Both halves are a guess until a signed-in log confirms it.
 */
function deltaToTotals(delta: CumulativeUsage): UsageTokenTotals {
  const cached = delta.cacheReadTokens + delta.cacheWriteTokens;
  return {
    uncachedInputTokens:
      delta.inputTokens >= cached ? delta.inputTokens - cached : delta.inputTokens,
    cachedInputTokens: delta.cacheReadTokens,
    cacheCreationTokens: delta.cacheWriteTokens,
    outputTokens: delta.outputTokens,
    reasoningTokens: Math.min(delta.outputTokens, delta.reasoningTokens),
  };
}

function parseCopilotRecord(parsed: unknown, state: CopilotScanState): readonly UsageRecord[] {
  if (!isRecord(parsed) || !isRecord(parsed.data)) return [];
  const data = parsed.data;
  if (parsed.type === "session.start") {
    if (typeof data.sessionId === "string") state.sessionId = data.sessionId;
    return [];
  }
  if (parsed.type !== "session.usage_checkpoint") return [];
  const timestampMs = parseTimestampMs(parsed.timestamp);
  if (timestampMs === null || !Array.isArray(data.providerModelMetrics)) return [];
  const records: UsageRecord[] = [];
  for (const entry of data.providerModelMetrics) {
    if (!isRecord(entry) || typeof entry.modelId !== "string") continue;
    const model = entry.modelId.trim();
    const cumulative = isRecord(entry.metrics) ? readCumulativeUsage(entry.metrics.usage) : null;
    if (!model || cumulative === null) continue;
    const totals = deltaToTotals(usageDelta(cumulative, state.models[model]));
    state.models = { ...state.models, [model]: cumulative };
    if (totalTokens(totals) === 0) continue;
    records.push({
      provider: "copilot",
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals,
      // Copilot accounts in AI credits, not dollars; T3 prices the tokens itself.
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: null,
    });
  }
  return records;
}

export function parseCopilotLine(line: string, state: CopilotScanState): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseCopilotRecord(parsed, state);
}

export const copilotUsageFormat: TranscriptUsageFormat<CopilotScanState> = {
  selectFields: {
    type: true,
    timestamp: true,
    data: { sessionId: true, providerModelMetrics: true },
  },
  usageMarkers: ['"session.usage_checkpoint"', '"session.start"'],
  parseLine: parseCopilotLine,
  parseProjected: parseCopilotRecord,
  state: { initial: initialCopilotScanState, schema: CopilotScanState },
};

export const copilotUsageReader: ProviderUsageReader<CopilotSettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat,
  directories: Effect.fn("copilotUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const home = expandHomePath(
      environment.COPILOT_HOME?.trim() || path.join(homeDirectory, ".copilot"),
      homeDirectory,
    );
    return [{ dir: path.resolve(home, "session-state"), fileName: "events.jsonl" }];
  }),
};
