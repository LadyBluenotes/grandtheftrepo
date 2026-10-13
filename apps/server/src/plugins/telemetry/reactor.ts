import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as PluginReactor from "../PluginReactor.ts";
import {
  pinnedFields,
  runFields,
  settledFields,
  threadFields,
  toolCallFields,
  toolOutputFields,
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
 * thread reopened after it settled. A settlement is taken only when the row has none or it is
 * newer, and who made it stays unknown (NULL) until `thread.settled` records it: compaction keeps
 * only a thread's newest full-state event, so a replay can learn a settlement from a later visit
 * or rename whose command says nothing about the settle.
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
        settled_at = CASE
          WHEN telemetry_threads.settled_at IS NULL
            OR excluded.settled_at > telemetry_threads.settled_at
          THEN excluded.settled_at ELSE telemetry_threads.settled_at END,
        settled_by_sweep = CASE
          WHEN excluded.settled_at > telemetry_threads.settled_at
          THEN NULL ELSE telemetry_threads.settled_by_sweep END,
        unsettled_at = CASE
          WHEN telemetry_threads.unsettled_at IS NULL
            OR excluded.unsettled_at > telemetry_threads.unsettled_at
          THEN excluded.unsettled_at ELSE telemetry_threads.unsettled_at END,
        pull_request_merged_at = CASE
          WHEN telemetry_threads.pull_request_merged_at IS NULL
            OR excluded.pull_request_merged_at > telemetry_threads.pull_request_merged_at
          THEN excluded.pull_request_merged_at ELSE telemetry_threads.pull_request_merged_at END
    `;
  });

/** The handler for every event whose payload is the whole thread. */
const threadState = (stored: { readonly event: { readonly payload: OrchestrationV2AppThread } }) =>
  upsertThread(stored.event.payload);

/** Every run event carries the whole run; the newest event, by sequence, wins. */
const upsertRun = (f: ReturnType<typeof runFields>, eventSequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO telemetry_runs
        (run_id, thread_id, turn_id, ordinal, status, provider_instance_id, model, started_at,
         completed_at, event_sequence)
      VALUES
        (${f["run.id"]}, ${f["run.threadId"]}, ${f["run.userMessageId"]}, ${f["run.ordinal"]},
         ${f["run.status"]}, ${f["run.providerInstanceId"]}, ${f["run.modelSelection.model"]},
         ${f["run.startedAt"]}, ${f["run.completedAt"]}, ${eventSequence})
      ON CONFLICT (run_id) DO UPDATE SET
        status = excluded.status,
        provider_instance_id = excluded.provider_instance_id,
        model = excluded.model,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        event_sequence = excluded.event_sequence
      WHERE excluded.event_sequence >= telemetry_runs.event_sequence
    `;
  });

/**
 * Fills the measures' tables from the event log. Every handler is an upsert by entity id, so a
 * replay changes nothing, and each row remembers the sequence of the event it was written from:
 * an older event handled later, such as a failed one retried at startup, cannot move it
 * backwards. A provider turn reports usage several times; the report with the latest time wins,
 * and between reports of the same time the newer event.
 */
export const handlers: PluginReactor.Handlers<SqlError.SqlError> = {
  "provider-turn.updated": ({ event, sequence }) =>
    Effect.gen(function* () {
      const f = turnUsageFields(event);
      if (f === undefined) return;
      const sql = yield* SqlClient.SqlClient;
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO telemetry_turn_usage
          (provider_turn_id, thread_id, run_id, input_tokens, cached_input_tokens, output_tokens,
           reasoning_output_tokens, usage_updated_at, recorded_at, event_sequence)
        VALUES
          (${f["providerTurn.id"]}, ${f["provider-turn.updated.threadId"]},
           ${f["provider-turn.updated.runId"]}, ${f["providerTurn.tokenUsage.inputTokens"]},
           ${f["providerTurn.tokenUsage.cachedInputTokens"]},
           ${f["providerTurn.tokenUsage.outputTokens"]},
           ${f["providerTurn.tokenUsage.reasoningOutputTokens"]},
           ${f["providerTurn.tokenUsage.updatedAt"]}, ${recordedAt}, ${sequence})
        ON CONFLICT (provider_turn_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = COALESCE(excluded.run_id, telemetry_turn_usage.run_id),
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          usage_updated_at = excluded.usage_updated_at,
          recorded_at = excluded.recorded_at,
          event_sequence = excluded.event_sequence
        WHERE (excluded.usage_updated_at, excluded.event_sequence)
          >= (telemetry_turn_usage.usage_updated_at, telemetry_turn_usage.event_sequence)
      `;
    }),
  "run.created": ({ event, sequence }) => upsertRun(runFields(event.payload), sequence),
  "run.updated": ({ event, sequence }) => upsertRun(runFields(event.payload), sequence),
  "turn-item.updated": ({ event, sequence }) =>
    Effect.gen(function* () {
      const f = toolCallFields(event.payload);
      const runId = f["turnItem.runId"];
      if (!TOOL_CALL_TYPES.has(f["turnItem.type"]) || runId === null) return;
      const output = toolOutputFields(event.payload);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO telemetry_tool_calls
          (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, command, output_tokens,
           status, event_sequence)
        VALUES
          (${f["turnItem.id"]}, ${runId}, ${f["turnItem.threadId"]}, ${f["turnItem.ordinal"]},
           ${f["turnItem.type"]}, ${f["turnItem.toolName"]},
           ${f["turnItem.input"] ?? f["turnItem.fileName"]}, ${output["turnItem.input"]},
           ${output["turnItem.output"] ?? output["turnItem.results"]}, ${f["turnItem.status"]},
           ${sequence})
        ON CONFLICT (item_id) DO UPDATE SET
          run_id = excluded.run_id,
          ordinal = excluded.ordinal,
          tool_name = excluded.tool_name,
          path = excluded.path,
          command = excluded.command,
          output_tokens = excluded.output_tokens,
          status = excluded.status,
          event_sequence = excluded.event_sequence
        WHERE excluded.event_sequence >= telemetry_tool_calls.event_sequence
      `;
    }),
  "thread.created": threadState,
  "thread.unsettled": threadState,
  "thread.pull-request-synced": threadState,
  // Compaction (`ProjectionMaintenance`) keeps only a thread's newest full-state event, so after
  // it the settlement may survive only on one of these.
  "thread.archived": threadState,
  "thread.unarchived": threadState,
  "thread.deleted": threadState,
  "thread.snoozed": threadState,
  "thread.unsnoozed": threadState,
  "thread.auto-settle-set": threadState,
  "thread.unpinned": threadState,
  "thread.pin-reordered": threadState,
  "thread.active-reordered": threadState,
  "thread.visited": threadState,
  "thread.marked-unread": threadState,
  "thread.metadata-updated": threadState,
  "thread.runtime-mode-updated": threadState,
  "thread.interaction-mode-updated": threadState,
  "thread.model-selection-updated": threadState,
  "thread.provider-switched": threadState,
  // Pinning promotes a settled thread out of settled without a `thread.unsettled`, so the pin is
  // the reopen. A thread with no settlement, or one already reopened since its latest, keeps its row.
  "thread.pinned": ({ event }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE telemetry_threads
        SET unsettled_at = ${pinnedFields(event)["thread.pinned.occurredAt"]}
        WHERE thread_id = ${event.payload.id}
          AND settled_at IS NOT NULL
          AND (unsettled_at IS NULL OR unsettled_at < settled_at)
          AND (unsettled_at IS NULL
            OR unsettled_at < ${pinnedFields(event)["thread.pinned.occurredAt"]})`;
    }),
  "thread.settled": (stored) =>
    Effect.gen(function* () {
      yield* upsertThread(stored.event.payload);
      const sql = yield* SqlClient.SqlClient;
      const commandId = settledFields(stored)["thread.settled.commandId"];
      const bySweep = commandId?.startsWith(AUTO_SETTLE_PREFIX) === true ? 1 : 0;
      // The origin belongs to the settlement the row holds; an older settle retried after a newer
      // one must not relabel the newer.
      yield* sql`UPDATE telemetry_threads SET settled_by_sweep = ${bySweep}
        WHERE thread_id = ${stored.event.payload.id}
          AND settled_at = ${threadFields(stored.event.payload)["thread.settledAt"]}`;
    }),
};
