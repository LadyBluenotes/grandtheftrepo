import type { MeasureInput, RunRow, ThreadRow, ToolCallRow, TurnUsageRow } from "./input.ts";

/** Rows for the measure tests. The window is the first week of October 2026. */
export const FROM = "2026-10-01T00:00:00.000Z";
export const TO = "2026-10-08T00:00:00.000Z";
export const INSIDE = "2026-10-02T00:00:00.000Z";
export const BEFORE = "2026-09-30T00:00:00.000Z";

let sequence = 0;

export const thread = (overrides: Partial<ThreadRow> = {}): ThreadRow => ({
  thread_id: "thread:1",
  project_id: "project:1",
  created_at: FROM,
  parent_thread_id: null,
  settled_at: null,
  settled_by_sweep: 0,
  unsettled_at: null,
  pull_request_merged_at: null,
  ...overrides,
});

/** A thread settled by hand inside the window, an accepted outcome. */
export const accepted = (overrides: Partial<ThreadRow> = {}) =>
  thread({ settled_at: INSIDE, ...overrides });

export const run = (overrides: Partial<RunRow> = {}): RunRow => ({
  run_id: "run:1",
  thread_id: "thread:1",
  turn_id: "message:1",
  ordinal: 1,
  status: "completed",
  model: "test-model",
  started_at: INSIDE,
  completed_at: INSIDE,
  ...overrides,
});

/** A tool call; each one runs after the one built before it. */
export const call = (overrides: Partial<ToolCallRow> = {}): ToolCallRow => {
  sequence += 1;
  return {
    item_id: `item:${sequence}`,
    run_id: "run:1",
    thread_id: "thread:1",
    ordinal: sequence,
    item_type: "dynamic_tool",
    tool_name: "Read",
    path: "src/a.ts",
    status: "completed",
    ...overrides,
  };
};

export const read = (path: string, overrides: Partial<ToolCallRow> = {}) =>
  call({ tool_name: "Read", path, ...overrides });

export const edit = (path: string, overrides: Partial<ToolCallRow> = {}) =>
  call({ item_type: "file_change", tool_name: null, path, ...overrides });

export const usage = (overrides: Partial<TurnUsageRow> = {}): TurnUsageRow => {
  sequence += 1;
  return {
    provider_turn_id: `provider-turn:${sequence}`,
    thread_id: "thread:1",
    run_id: "run:1",
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 100,
    ...overrides,
  };
};

export const input = (overrides: Partial<MeasureInput> = {}): MeasureInput => ({
  from: FROM,
  to: TO,
  threads: [],
  runs: [],
  toolCalls: [],
  turnUsage: [],
  corrections: [],
  pricing: { rates: new Map(), overrides: new Map(), aliases: new Map() },
  ...overrides,
});
