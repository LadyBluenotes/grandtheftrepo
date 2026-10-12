import * as Schema from "effect/Schema";
import { EventId, IsoDateTime, ProjectId, ThreadId } from "../baseSchemas.ts";

export const LEARNING_WS_METHODS = {
  corrections: "learning.corrections",
  correction: "learning.correction",
} as const;

/** Which kind of event produced a correction. */
export const LearningFailureKind = Schema.Literals([
  "provider_turn_failed",
  "provider_turn_interrupted",
  "changes_requested",
  "reopened_after_settlement",
  "review_verdict",
  "manual",
]);
export type LearningFailureKind = typeof LearningFailureKind.Type;

/** The review failure modes a reviewer or person can declare, the six the review verdict uses. */
export const LearningDeclaredMode = Schema.Literals([
  "defect",
  "incomplete",
  "scope_drift",
  "missing_verification",
  "convention",
  "unclear_spec",
]);
export type LearningDeclaredMode = typeof LearningDeclaredMode.Type;

/** One recorded instance of work being wrong or failing. */
export const LearningCorrection = Schema.Struct({
  id: Schema.Int,
  projectId: ProjectId,
  threadId: ThreadId,
  failureKind: LearningFailureKind,
  /** Why it happened; `unclassified` until something classifies it. */
  causeClass: Schema.String,
  /** Set only when a reviewer or person declared it. */
  declaredMode: Schema.NullOr(LearningDeclaredMode),
  /** Bounded, with secrets redacted. */
  description: Schema.String,
  sourceEventIds: Schema.Array(EventId),
  /** Derived from the source event and unique with `failureKind`; null for a manual row. */
  sourceKey: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LearningCorrection = typeof LearningCorrection.Type;

export class LearningError extends Schema.TaggedError<LearningError>()("LearningError", {
  code: Schema.Literals(["inactive", "not_found", "io"]),
  message: Schema.String,
}) {}

/** A project's corrections created between `from` and `to`, inclusive. */
export const LearningCorrectionsInput = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
  failureKind: Schema.optional(LearningFailureKind),
});
export type LearningCorrectionsInput = typeof LearningCorrectionsInput.Type;

export const LearningCorrectionInput = Schema.Struct({ id: Schema.Int });
export type LearningCorrectionInput = typeof LearningCorrectionInput.Type;

/**
 * The plugin's methods and the gateway each answers behind. They are not in the WebSocket RPC
 * group, which is at TypeScript's instantiation limit; the gateway RPCs dispatch them by name.
 */
export const LEARNING_METHODS = {
  corrections: {
    method: LEARNING_WS_METHODS.corrections,
    gateway: "read",
    input: LearningCorrectionsInput,
    output: Schema.Array(LearningCorrection),
  },
  correction: {
    method: LEARNING_WS_METHODS.correction,
    gateway: "read",
    input: LearningCorrectionInput,
    output: LearningCorrection,
  },
} as const;
