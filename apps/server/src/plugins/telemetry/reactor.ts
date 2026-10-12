import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as PluginReactor from "../PluginReactor.ts";

/**
 * Keeps the provider's latest usage report per provider turn. A turn reports
 * several times, so the row is replaced each time and a replay changes nothing.
 */
export const handlers: PluginReactor.Handlers<SqlError.SqlError> = {
  "provider-turn.updated": ({ event }) =>
    Effect.gen(function* () {
      const usage = event.payload.tokenUsage;
      if (usage === undefined) return;
      const sql = yield* SqlClient.SqlClient;
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO telemetry_turn_usage
          (provider_turn_id, thread_id, input_tokens, cached_input_tokens, output_tokens,
           reasoning_output_tokens, usage_updated_at, recorded_at)
        VALUES
          (${event.payload.id}, ${event.threadId}, ${usage.inputTokens ?? null},
           ${usage.cachedInputTokens ?? null}, ${usage.outputTokens ?? null},
           ${usage.reasoningOutputTokens ?? null}, ${usage.updatedAt}, ${recordedAt})
        ON CONFLICT (provider_turn_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          usage_updated_at = excluded.usage_updated_at,
          recorded_at = excluded.recorded_at
      `;
    }),
};
