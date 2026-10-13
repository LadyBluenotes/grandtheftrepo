import { type ReviewOutcome, ReviewVerdictError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { latestCheckpoint, type RequestRow } from "./ReviewRequests.ts";

export class ReviewGate extends Context.Service<
  ReviewGate,
  {
    /**
     * Whether review lets the thread's work complete; a ticket's completion asks it first. A thread
     * nobody asked to review passes. Otherwise its newest request decides, and the refusal is a
     * `gated` error saying why: the request is stale or names a checkpoint the thread has moved
     * past, it has no verdict yet, or the newest verdict on its checkpoint asked for changes.
     */
    readonly check: (threadId: ThreadId) => Effect.Effect<void, ReviewVerdictError>;
  }
>()("t3/plugins/review/ReviewGate") {}

const refuse = (message: string) => Effect.fail(new ReviewVerdictError({ code: "gated", message }));

const outOfDate = (checkpointId: string) =>
  refuse(`The review is out of date: the thread changed after checkpoint ${checkpointId}.`);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const io = (cause: SqlError.SqlError | Orchestrator.OrchestratorV2Error) =>
    Effect.logWarning("review: the gate could not read", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new ReviewVerdictError({ code: "io", message: "The review state could not be read." }),
        ),
      ),
    );

  const check: ReviewGate["Service"]["check"] = (threadId) =>
    Effect.gen(function* () {
      const [newest] = yield* sql<RequestRow>`SELECT * FROM review_request
        WHERE thread_id = ${threadId} ORDER BY requested_at DESC, id DESC LIMIT 1`;
      if (newest === undefined) return;
      if (newest.status === "stale") return yield* outOfDate(newest.checkpoint_id);
      // The sweep marks a request stale on its next tick; until then the thread itself says so.
      const latest = yield* latestCheckpoint(threads, threadId).pipe(Effect.catch(io));
      if (latest !== null && latest !== undefined && latest.id !== newest.checkpoint_id) {
        return yield* outOfDate(newest.checkpoint_id);
      }
      if (newest.status === "open") {
        return yield* refuse("A review was requested and has no verdict yet.");
      }
      const [verdict] = yield* sql<{ readonly outcome: ReviewOutcome }>`
        SELECT outcome FROM review_verdicts
        WHERE reviewed_thread_id = ${threadId} AND checkpoint_id = ${newest.checkpoint_id}
          AND invalidated_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`;
      if (verdict?.outcome === "changes_requested") {
        return yield* refuse("The latest review asked for changes.");
      }
    }).pipe(Effect.catchTags({ SqlError: io }));

  return ReviewGate.of({ check });
});

export const layer = Layer.effect(ReviewGate, make);
