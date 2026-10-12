import * as Effect from "effect/Effect";
import type * as SqlError from "effect/sql/SqlError";
import type { Handlers } from "../../PluginReactor.ts";
import { insert } from "../CorrectionStore.ts";
import { rememberThread, threadFacts } from "./threads.ts";

const KIND = {
  failed: "provider_turn_failed",
  interrupted: "provider_turn_interrupted",
} as const;

/**
 * A provider turn that ends failed or interrupted is one correction. The turn
 * can update again after it ends, so the source key carries the status too.
 */
export const handlers: Handlers<SqlError.SqlError> = {
  "thread.created": (stored) => rememberThread(stored.event.payload),
  "provider-turn.updated": (stored) =>
    Effect.gen(function* () {
      const turn = stored.event.payload;
      if (turn.status !== "failed" && turn.status !== "interrupted") return;
      const threadId = stored.event.threadId;
      const thread = yield* threadFacts(threadId);
      if (thread === undefined) {
        return yield* Effect.logWarning("learning: turn failure skipped, thread unknown", {
          threadId,
          turnId: turn.id,
        });
      }
      yield* insert({
        projectId: thread.project_id,
        threadId,
        failureKind: KIND[turn.status],
        description: `Provider turn ${turn.ordinal} ${turn.status}.`,
        sourceEventIds: [stored.event.id],
        sourceKey: `${turn.id}:${turn.status}`,
        occurredAt: stored.event.occurredAt,
      });
    }),
};
