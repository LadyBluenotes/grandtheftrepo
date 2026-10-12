import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "../auth.ts";
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

/** The review failure modes a reviewer or person can declare. */
export const LearningDeclaredMode = Schema.Literals([
  "wrong_target",
  "incomplete",
  "regression",
  "unverified",
  "scope_creep",
  "unsafe",
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

const error = Schema.Union([LearningError, EnvironmentAuthorizationError]);

export const LEARNING_RPCS = [
  Rpc.make(LEARNING_WS_METHODS.corrections, {
    payload: LearningCorrectionsInput,
    success: Schema.Array(LearningCorrection),
    error,
  }),
  Rpc.make(LEARNING_WS_METHODS.correction, {
    payload: LearningCorrectionInput,
    success: LearningCorrection,
    error,
  }),
] as const;

/** Reads: server-side authorization only. */
export const LEARNING_RPC_SCOPES = {
  [LEARNING_WS_METHODS.corrections]: AuthOrchestrationReadScope,
  [LEARNING_WS_METHODS.correction]: AuthOrchestrationReadScope,
} as const;

export const LEARNING_RPC_SUBSYSTEMS = {
  [LEARNING_WS_METHODS.corrections]: "learning",
  [LEARNING_WS_METHODS.correction]: "learning",
} as const;
