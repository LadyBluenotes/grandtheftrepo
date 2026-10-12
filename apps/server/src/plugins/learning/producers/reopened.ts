import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type { Handlers } from "../../PluginReactor.ts";
import { insert } from "../CorrectionStore.ts";
import { rememberThread, threadFacts } from "./threads.ts";

/**
 * A thread unsettled after it settled is one correction. An unsettle with no
 * settle before it, such as a thread forced active, is not. The settled mark
 * clears with the reopen, so the next one needs a settle of its own.
 */
export const handlers: Handlers<SqlError.SqlError> = {
  "thread.settled": (stored) =>
    Effect.gen(function* () {
      yield* rememberThread(stored.event.payload);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET settled = 1 WHERE thread_id = ${stored.event.threadId}`;
    }),
  "thread.unsettled": (stored) =>
    Effect.gen(function* () {
      const thread = stored.event.payload;
      yield* rememberThread(thread);
      const facts = yield* threadFacts(thread.id);
      if (facts?.settled !== 1) return;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET settled = 0 WHERE thread_id = ${thread.id}`;
      yield* insert({
        projectId: thread.projectId,
        threadId: thread.id,
        failureKind: "reopened_after_settlement",
        description: "Thread reopened after it was settled.",
        sourceEventIds: [stored.event.id],
        sourceKey: `${thread.id}:${DateTime.formatIso(stored.event.occurredAt)}`,
        occurredAt: stored.event.occurredAt,
      });
    }),
};
