import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as PluginReactor from "../PluginReactor.ts";
import {
  runFields,
  settledFields,
  threadFields,
  toolCallFields,
  turnUsageFields,
} from "./fields.ts";

/** Timeline items that are tool calls. Messages, plans, notices and the rest are not. */
const TOOL_CALL_TYPES: ReadonlySet<string> = new Set([
  "dynamic_tool",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
]);

/** Command ids `ThreadSettlementService` gives its automatic settlements. */
const AUTO_SETTLE_PREFIX = "server:auto-settle:";

/**
 * Every thread event carries the whole thread, so any of them can introduce it. The latest settle
 * and the latest reopen are kept even after the thread leaves that state, so a measure can tell a
 * thread reopened after it settled.
 */
const upsertThread = (thread: OrchestrationV2AppThread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const f = threadFields(thread);
    const parentThreadId =
      f["thread.lineage.relationshipToParent"] === "subagent"
        ? f["thread.lineage.parentThreadId"]
        : null;
    yield* sql`
      INSERT INTO telemetry_threads
        (thread_id, project_id, created_at, parent_thread_id, settled_at, unsettled_at,
         pull_request_merged_at)
      VALUES
        (${f["thread.id"]}, ${f["thread.projectId"]}, ${f["thread.createdAt"]}, ${parentThreadId},
         ${f["thread.settledAt"]}, ${f["thread.unsettledAt"]},
         ${f["thread.pullRequests.snapshot.mergedAt"]})
      ON CONFLICT (thread_id) DO UPDATE SET
        project_id = excluded.project_id,
        settled_at = COALESCE(excluded.settled_at, telemetry_threads.settled_at),
        unsettled_at = COALESCE(excluded.unsettled_at, telemetry_threads.unsettled_at),
        pull_request_merged_at =
          COALESCE(excluded.pull_request_merged_at, telemetry_threads.pull_request_merged_at)
    `;
  });

/** Every run event carries the whole run; the latest one wins. */
const upsertRun = (f: ReturnType<typeof runFields>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO telemetry_runs
        (run_id, thread_id, turn_id, ordinal, status, model, started_at, completed_at)
      VALUES
        (${f["run.id"]}, ${f["run.threadId"]}, ${f["run.userMessageId"]}, ${f["run.ordinal"]},
         ${f["run.status"]}, ${f["run.modelSelection.model"]}, ${f["run.startedAt"]},
         ${f["run.completedAt"]})
      ON CONFLICT (run_id) DO UPDATE SET
        status = excluded.status,
        model = excluded.model,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `;
  });

/**
 * Fills the measures' tables from the event log. Every handler is an upsert by entity id, so a
 * replay changes nothing. A provider turn reports usage several times; the latest report wins and
 * an older one is ignored, so a retried event cannot move a turn backwards.
 */
export const handlers: PluginReactor.Handlers<SqlError.SqlError> = {
  "provider-turn.updated": ({ event }) =>
    Effect.gen(function* () {
      const f = turnUsageFields(event);
      if (f === undefined) return;
      const sql = yield* SqlClient.SqlClient;
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO telemetry_turn_usage
          (provider_turn_id, thread_id, run_id, input_tokens, cached_input_tokens, output_tokens,
           reasoning_output_tokens, usage_updated_at, recorded_at)
        VALUES
          (${f["providerTurn.id"]}, ${f["provider-turn.updated.threadId"]},
           ${f["provider-turn.updated.runId"]}, ${f["providerTurn.tokenUsage.inputTokens"]},
           ${f["providerTurn.tokenUsage.cachedInputTokens"]},
           ${f["providerTurn.tokenUsage.outputTokens"]},
           ${f["providerTurn.tokenUsage.reasoningOutputTokens"]},
           ${f["providerTurn.tokenUsage.updatedAt"]}, ${recordedAt})
        ON CONFLICT (provider_turn_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = COALESCE(excluded.run_id, telemetry_turn_usage.run_id),
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          usage_updated_at = excluded.usage_updated_at,
          recorded_at = excluded.recorded_at
        WHERE excluded.usage_updated_at >= telemetry_turn_usage.usage_updated_at
      `;
    }),
  "run.created": ({ event }) => upsertRun(runFields(event.payload)),
  "run.updated": ({ event }) => upsertRun(runFields(event.payload)),
  "turn-item.updated": ({ event }) =>
    Effect.gen(function* () {
      const f = toolCallFields(event.payload);
      const runId = f["turnItem.runId"];
      if (!TOOL_CALL_TYPES.has(f["turnItem.type"]) || runId === null) return;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO telemetry_tool_calls
          (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, status)
        VALUES
          (${f["turnItem.id"]}, ${runId}, ${f["turnItem.threadId"]}, ${f["turnItem.ordinal"]},
           ${f["turnItem.type"]}, ${f["turnItem.toolName"]},
           ${f["turnItem.input"] ?? f["turnItem.fileName"]}, ${f["turnItem.status"]})
        ON CONFLICT (item_id) DO UPDATE SET
          run_id = excluded.run_id,
          ordinal = excluded.ordinal,
          tool_name = excluded.tool_name,
          path = excluded.path,
          status = excluded.status
      `;
    }),
  "thread.created": ({ event }) => upsertThread(event.payload),
  "thread.unsettled": ({ event }) => upsertThread(event.payload),
  "thread.pull-request-synced": ({ event }) => upsertThread(event.payload),
  "thread.settled": (stored) =>
    Effect.gen(function* () {
      yield* upsertThread(stored.event.payload);
      const sql = yield* SqlClient.SqlClient;
      const commandId = settledFields(stored)["thread.settled.commandId"];
      const bySweep = commandId?.startsWith(AUTO_SETTLE_PREFIX) === true ? 1 : 0;
      yield* sql`UPDATE telemetry_threads SET settled_by_sweep = ${bySweep}
        WHERE thread_id = ${stored.event.payload.id}`;
    }),
};
