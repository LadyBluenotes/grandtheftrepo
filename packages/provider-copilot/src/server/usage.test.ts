import { describe, expect, it } from "@effect/vitest";

import { copilotUsageFormat, initialCopilotScanState, parseCopilotLine } from "./usage.ts";

const checkpoint = (
  timestamp: string,
  metrics: ReadonlyArray<{ modelId: string | null; usage?: Record<string, number> }>,
) =>
  JSON.stringify({
    type: "session.usage_checkpoint",
    id: "evt",
    parentId: null,
    timestamp,
    sessionId: "session-1",
    data: {
      totalNanoAiu: 0,
      providerModelMetrics: metrics.map((entry) => ({
        modelId: entry.modelId,
        provider: null,
        metrics: entry.usage ? { usage: entry.usage, requests: { count: 1, cost: 1 } } : undefined,
      })),
    },
  });

describe("parseCopilotLine", () => {
  it("reports each checkpoint as the growth since the previous one per model", () => {
    const state = initialCopilotScanState();
    const first = parseCopilotLine(
      checkpoint("2026-10-10T10:00:00.000Z", [
        {
          modelId: "gpt-5.4",
          usage: {
            inputTokens: 1_000,
            outputTokens: 200,
            cacheReadTokens: 600,
            cacheWriteTokens: 100,
            reasoningTokens: 50,
          },
        },
      ]),
      state,
    );
    expect(first).toEqual([
      {
        provider: "copilot",
        timestampMs: Date.parse("2026-10-10T10:00:00.000Z"),
        model: "gpt-5.4",
        sessionId: "session-1",
        totals: {
          uncachedInputTokens: 300,
          cachedInputTokens: 600,
          cacheCreationTokens: 100,
          outputTokens: 200,
          reasoningTokens: 50,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: null,
      },
    ]);

    const second = parseCopilotLine(
      checkpoint("2026-10-10T10:05:00.000Z", [
        {
          modelId: "gpt-5.4",
          usage: {
            inputTokens: 1_500,
            outputTokens: 260,
            cacheReadTokens: 1_000,
            cacheWriteTokens: 100,
            reasoningTokens: 60,
          },
        },
        { modelId: "claude-sonnet-4.6", usage: { inputTokens: 40, outputTokens: 10 } },
        { modelId: null, usage: { inputTokens: 999, outputTokens: 999 } },
      ]),
      state,
    );
    expect(second.map((record) => [record.model, record.totals])).toEqual([
      [
        "gpt-5.4",
        {
          uncachedInputTokens: 100,
          cachedInputTokens: 400,
          cacheCreationTokens: 0,
          outputTokens: 60,
          reasoningTokens: 10,
        },
      ],
      [
        "claude-sonnet-4.6",
        {
          uncachedInputTokens: 40,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
      ],
    ]);
  });

  it("treats a checkpoint below the previous one as a fresh count and skips empty growth", () => {
    const state = initialCopilotScanState();
    const usage = { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    parseCopilotLine(
      checkpoint("2026-10-10T10:00:00.000Z", [{ modelId: "gpt-5.4", usage }]),
      state,
    );
    expect(
      parseCopilotLine(
        checkpoint("2026-10-10T10:01:00.000Z", [{ modelId: "gpt-5.4", usage }]),
        state,
      ),
    ).toEqual([]);
    const reset = parseCopilotLine(
      checkpoint("2026-10-10T10:02:00.000Z", [
        { modelId: "gpt-5.4", usage: { ...usage, inputTokens: 120 } },
      ]),
      state,
    );
    expect(reset[0]?.totals.uncachedInputTokens).toBe(120);
  });

  it("ignores other events, malformed lines, and metrics without usage", () => {
    const state = initialCopilotScanState();
    expect(parseCopilotLine("not json", state)).toEqual([]);
    expect(
      parseCopilotLine(
        JSON.stringify({ type: "assistant.usage", timestamp: "2026-10-10T10:00:00.000Z" }),
        state,
      ),
    ).toEqual([]);
    expect(
      parseCopilotLine(checkpoint("2026-10-10T10:00:00.000Z", [{ modelId: "gpt-5.4" }]), state),
    ).toEqual([]);
    expect(copilotUsageFormat.mightCarryUsage('{"type":"session.usage_checkpoint"}')).toBe(true);
    expect(copilotUsageFormat.mightCarryUsage('{"type":"assistant.usage"}')).toBe(false);
  });
});
