import * as Schema from "effect/Schema";
import { CheckpointId, IsoDateTime, ProjectId, ThreadId } from "../baseSchemas.ts";
import { LearningDeclaredMode } from "./learning.ts";
import { definePluginMethods } from "./method.ts";

export const ReviewOutcome = Schema.Literals(["approve", "changes_requested"]);
export type ReviewOutcome = typeof ReviewOutcome.Type;

/**
 * What a reviewing agent says about one checkpoint of another thread. `failureMode` is one of the
 * six `LearningDeclaredMode` values, so a mode outside the list never gets past the schema; the
 * service requires it with `changes_requested` and refuses it with `approve`. The summary is for
 * people: nothing reads it to learn what went wrong.
 */
export const ReviewVerdictInput = Schema.Struct({
  threadId: ThreadId,
  checkpointId: CheckpointId,
  outcome: ReviewOutcome,
  failureMode: Schema.optional(LearningDeclaredMode),
  summary: Schema.String.check(Schema.isMaxLength(1000)),
});
export type ReviewVerdictInput = typeof ReviewVerdictInput.Type;

export const ReviewVerdictResult = Schema.Struct({
  verdictId: Schema.String,
  /** The correction a `changes_requested` verdict recorded; null for `approve`. */
  correctionId: Schema.NullOr(Schema.Int),
});
export type ReviewVerdictResult = typeof ReviewVerdictResult.Type;

/** A reviewer's typed judgement of one checkpoint. */
export const ReviewVerdict = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  /** The thread whose work is judged. */
  reviewedThreadId: ThreadId,
  reviewerThreadId: ThreadId,
  checkpointId: CheckpointId,
  outcome: ReviewOutcome,
  /** Null on `approve`. */
  failureMode: Schema.NullOr(LearningDeclaredMode),
  summary: Schema.String,
  correctionId: Schema.NullOr(Schema.Int),
  createdAt: IsoDateTime,
  /** Null until later commits make the verdict stale. */
  invalidatedAt: Schema.NullOr(IsoDateTime),
});
export type ReviewVerdict = typeof ReviewVerdict.Type;

/** The verdicts given on one thread's work. */
export const ReviewVerdictsInput = Schema.Struct({ threadId: ThreadId });
export type ReviewVerdictsInput = typeof ReviewVerdictsInput.Type;

export class ReviewVerdictError extends Schema.TaggedError<ReviewVerdictError>()(
  "ReviewVerdictError",
  {
    code: Schema.Literals(["inactive", "invalid", "not_found", "conflict", "io"]),
    message: Schema.String,
  },
) {}

/**
 * The plugin's methods and the gateway each answers behind. They are not in the WebSocket RPC
 * group, which is at TypeScript's instantiation limit; the gateway RPCs dispatch them by name.
 */
export const REVIEW_METHODS = definePluginMethods({
  verdicts: {
    method: "review.verdicts",
    gateway: "read",
    input: ReviewVerdictsInput,
    output: Schema.Array(ReviewVerdict),
    error: ReviewVerdictError,
  },
});
