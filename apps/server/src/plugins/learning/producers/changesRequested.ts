import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type { Handlers } from "../../PluginReactor.ts";
import { insert } from "../CorrectionStore.ts";
import { rememberThread, threadFacts } from "./threads.ts";

/** Message ids `PullRequestWatchReactor` gives its wakes. */
const WAKE_PREFIX = "message:pr-watch:";

/**
 * A pull request watch wake about new comments, while the thread's pull
 * request snapshot says changes are requested, is one correction. The
 * orchestrator records the synced thread before the wake message, so the
 * snapshot the wake is judged by is the one that came with it. The wake text
 * only describes the correction; the kind never comes from it.
 */
export const handlers: Handlers<SqlError.SqlError> = {
  "thread.pull-request-synced": (stored) =>
    Effect.gen(function* () {
      const thread = stored.event.payload;
      yield* rememberThread(thread);
      const changesRequested = visibleThreadPullRequests(thread.pullRequests ?? []).some(
        (link) => link.snapshot?.reviewDecision === "changes-requested",
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET changes_requested = ${changesRequested ? 1 : 0}
        WHERE thread_id = ${thread.id}`;
    }),
  "message.updated": (stored) =>
    Effect.gen(function* () {
      const message = stored.event.payload;
      if (
        !message.id.startsWith(WAKE_PREFIX) ||
        message.notification?.source.kind !== "monitor" ||
        !message.notification.summary.includes("new comments")
      ) {
        return;
      }
      const thread = yield* threadFacts(message.threadId);
      if (thread === undefined) {
        return yield* Effect.logWarning("learning: pull request wake skipped, thread unknown", {
          threadId: message.threadId,
          messageId: message.id,
        });
      }
      if (thread.changes_requested === 0) return;
      yield* insert({
        projectId: thread.project_id,
        threadId: message.threadId,
        failureKind: "changes_requested",
        description: message.text,
        sourceEventIds: [stored.event.id],
        sourceKey: message.id,
      });
    }),
};
