import {
  OrchestratorMcpFailure,
  PONYTAIL_RUNG_IDS,
  ReviewRequest,
  ReviewRequestInput,
  ReviewVerdict,
  ReviewVerdictInput,
  ReviewVerdictResult,
  ReviewVerdictsInput,
  type ReviewVerdictError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readCaller } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as CorrectionStore from "../learning/CorrectionStore.ts";
import * as ReviewRequests from "./ReviewRequests.ts";
import * as VerdictStore from "./VerdictStore.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const ReviewVerdictTool = Tool.make("review_verdict", {
  ...shared,
  description: `Judge one checkpoint of another thread's work as the reviewer. outcome is approve or changes_requested. changes_requested needs failureMode, the one reason the work was sent back: defect (the change is wrong), incomplete (part of the request is missing), scope_drift (it changed things nobody asked for), missing_verification (no tests or evidence it works), convention (it breaks a project convention) or unclear_spec (the request itself was ambiguous); approve takes none. checkpointId must be a ready checkpoint of threadId, and threadId cannot be your own thread. Reviewing against the ponytail ladder, check these rungs in order: ${PONYTAIL_RUNG_IDS.join(", ")}. A failed rung is a convention verdict whose summary starts with rung:<id>, naming the earliest failing rung; when another failure mode is more severe, that one stands in place of convention. A convention summary starting with rung: must name one of those ids, else the verdict is refused. summary is for people, at most 1000 characters; nothing reads it to learn what went wrong, so put the reason in failureMode. A changes_requested verdict also records a correction. Answers with verdictId and correctionId (null on approve). Reviewing the same checkpoint again with the same payload returns the stored verdict; a different payload is refused.`,
  parameters: ReviewVerdictInput,
  success: ReviewVerdictResult,
})
  .annotate(Tool.Title, "Review verdict")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReviewVerdictsTool = Tool.make("review_verdicts", {
  ...shared,
  description:
    "The verdicts reviewers gave on one thread's checkpoints, oldest first: outcome, failureMode, summary, the correction it recorded, and invalidatedAt once later commits made it stale.",
  parameters: ReviewVerdictsInput,
  success: Schema.Array(ReviewVerdict),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ReviewRequestTool = Tool.make("review_request", {
  ...shared,
  description:
    "Ask for a review of threadId's latest checkpoint; it can be your own thread. Answers with the request: its checkpointId, and status open until a review_verdict names that checkpoint, then answered. Asking again at the same checkpoint returns the same request. Once the thread's latest checkpoint is another one, the supervisor marks the request stale for good and opens a new one at the latest, so a review always describes the current work. Refused while the thread has no checkpoint.",
  parameters: ReviewRequestInput,
  success: ReviewRequest,
})
  .annotate(Tool.Title, "Request a review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReviewRequestsTool = Tool.make("review_requests", {
  ...shared,
  description:
    "The review requests made for one thread, newest first: the checkpoint each names, status open, answered or stale, who asked and when, and for a stale one when it went stale and the id of the request that superseded it.",
  parameters: ReviewRequestInput,
  success: Schema.Array(ReviewRequest),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ReviewToolkit = Toolkit.make(
  ReviewVerdictTool,
  ReviewVerdictsTool,
  ReviewRequestTool,
  ReviewRequestsTool,
);

const failure = (error: ReviewVerdictError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "io" || error.code === "inactive" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const inactive = (plugin: string) =>
  Effect.fail(
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: `Plugin "${plugin}" is not running.`,
    }),
  );

/**
 * The stores are read when the handlers are built, not declared as tool dependencies: plugin
 * services are typed as absent from the server chain, and these tools only register while the
 * plugin, and so learning, is active, which is when they are there.
 */
export const handlers = McpToolAccess.toLayer(
  ReviewToolkit,
  Effect.map(
    Effect.all([
      Effect.serviceOption(VerdictStore.VerdictStore),
      Effect.serviceOption(CorrectionStore.CorrectionStore),
      Effect.serviceOption(ReviewRequests.ReviewRequests),
    ]),
    ([verdictsOption, correctionsOption, requestsOption]) => {
      const verdicts = Option.match(verdictsOption, {
        onNone: () => inactive("review"),
        onSome: Effect.succeed,
      });
      const requests = Option.match(requestsOption, {
        onNone: () => inactive("review"),
        onSome: Effect.succeed,
      });
      const corrections = Option.match(correctionsOption, {
        onNone: () => inactive("learning"),
        onSome: Effect.succeed,
      });
      return {
        review_verdict: McpToolAccess.actsAsCaller((input) =>
          Effect.gen(function* () {
            const { caller } = yield* readCaller();
            if (caller === undefined) {
              return yield* new OrchestratorMcpFailure({
                code: "thread_credential_required",
                message:
                  "A verdict is given by a T3 thread; this MCP client is not running in one.",
              });
            }
            const store = yield* verdicts;
            return yield* store
              .record(caller.id, input)
              .pipe(
                Effect.provideServiceEffect(CorrectionStore.CorrectionStore, corrections),
                Effect.catchTags({ ReviewVerdictError: (error) => Effect.fail(failure(error)) }),
              );
          }),
        ),
        review_verdicts: McpToolAccess.reads((input) =>
          Effect.gen(function* () {
            yield* readCaller();
            const store = yield* verdicts;
            return yield* store.list(input);
          }).pipe(Effect.catchTags({ ReviewVerdictError: (error) => Effect.fail(failure(error)) })),
        ),
        review_request: McpToolAccess.actsAsCaller((input) =>
          Effect.gen(function* () {
            const { caller } = yield* readCaller();
            if (caller === undefined) {
              return yield* new OrchestratorMcpFailure({
                code: "thread_credential_required",
                message:
                  "A review is requested by a T3 thread; this MCP client is not running in one.",
              });
            }
            const store = yield* requests;
            return yield* store.request({
              threadId: input.threadId,
              requestedBy: `thread:${caller.id}`,
            });
          }).pipe(Effect.catchTags({ ReviewVerdictError: (error) => Effect.fail(failure(error)) })),
        ),
        review_requests: McpToolAccess.reads((input) =>
          Effect.gen(function* () {
            yield* readCaller();
            const store = yield* requests;
            return yield* store.list(input);
          }).pipe(Effect.catchTags({ ReviewVerdictError: (error) => Effect.fail(failure(error)) })),
        ),
      };
    },
  ),
);
