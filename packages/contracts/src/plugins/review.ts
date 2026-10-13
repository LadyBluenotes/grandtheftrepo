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
    /**
     * `gated` is `ReviewGate.check` refusing completion, or a security hold refusing a review
     * request or verdict; its message says why. `scan_pending` refuses a review request, verdict or
     * completion in a `block` project until the security scan of the checkpoint has finished;
     * asking again later succeeds or meets the hold.
     */
    code: Schema.Literals([
      "inactive",
      "invalid",
      "not_found",
      "conflict",
      "gated",
      "scan_pending",
      "io",
    ]),
    message: Schema.String,
  },
) {}

const ReviewRequestStatus = Schema.Literals(["open", "answered", "stale"]);

/**
 * A thread's ask for a review of one checkpoint, the thread's latest when it was made. A verdict on
 * that checkpoint answers it. Once the thread's latest checkpoint is another one, the supervisor
 * marks it `stale`, for good, and opens the request that supersedes it at the latest.
 */
export const ReviewRequest = Schema.Struct({
  id: Schema.Int,
  threadId: ThreadId,
  checkpointId: CheckpointId,
  status: ReviewRequestStatus,
  /** `user` for a client, `thread:<id>` for an agent, `supervisor` for a superseding request. */
  requestedBy: Schema.String,
  requestedAt: IsoDateTime,
  staleAt: Schema.NullOr(IsoDateTime),
  /** The request that replaced this one once it went stale. */
  supersededBy: Schema.NullOr(Schema.Int),
});
export type ReviewRequest = typeof ReviewRequest.Type;

/** A request for a review of one thread's latest checkpoint, or the requests made for it. */
export const ReviewRequestInput = Schema.Struct({ threadId: ThreadId });

/**
 * What the security scan does with a project's turns: `off` skips it, `warn` records findings, and
 * `block` also holds the thread's review requests until someone acknowledges them.
 */
export const SecurityMode = Schema.Literals(["off", "warn", "block"]);
export type SecurityMode = typeof SecurityMode.Type;

/**
 * The fixed patterns the scan tests a turn's added lines against. `scan_failed` is no pattern: in a
 * `block` project it stands for a turn the scan could not read, with an empty file and line 0, and
 * holds the thread like a finding until someone checks the turn and acknowledges it.
 */
export const SecurityPatternId = Schema.Literals([
  "secret.token",
  "secret.private_key",
  "rce.eval_fetched",
  "rce.pipe_to_shell",
  "workflow.injection",
  "shell.untrusted",
  "scan_failed",
]);
export type SecurityPatternId = typeof SecurityPatternId.Type;

/** One pattern matched on one line a turn added. The matched text is never stored. */
export const SecurityFinding = Schema.Struct({
  id: Schema.Int,
  threadId: ThreadId,
  /** The checkpoint whose turn added the line. */
  checkpointId: CheckpointId,
  patternId: SecurityPatternId,
  file: Schema.String,
  /** The line in the file as the checkpoint has it, from 1. */
  line: Schema.Int,
  /** The `security` correction it recorded in the learning plugin; null until recorded. */
  correctionId: Schema.NullOr(Schema.Int),
  createdAt: IsoDateTime,
  acknowledgedAt: Schema.NullOr(IsoDateTime),
  ackReason: Schema.NullOr(Schema.String),
});
export type SecurityFinding = typeof SecurityFinding.Type;

/** The security findings on one thread. */
export const SecurityFindingsInput = Schema.Struct({ threadId: ThreadId });

/** Acknowledges every open finding on the thread; the service refuses an empty reason. */
export const SecurityAckInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.String.check(Schema.isMaxLength(1000)),
});

export const SecurityModeInput = Schema.Struct({ projectId: ProjectId });

/** A project's security mode; a project with none saved is `warn`. */
export const SecurityModeSetting = Schema.Struct({ projectId: ProjectId, mode: SecurityMode });
export type SecurityModeSetting = typeof SecurityModeSetting.Type;

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
  request: {
    method: "review.request",
    gateway: "operate",
    input: ReviewRequestInput,
    output: ReviewRequest,
    error: ReviewVerdictError,
  },
  requestsList: {
    method: "review.requests.list",
    gateway: "read",
    input: ReviewRequestInput,
    output: Schema.Array(ReviewRequest),
    error: ReviewVerdictError,
  },
  /** Answers with the findings it acknowledged. */
  securityAck: {
    method: "review.security.ack",
    gateway: "operate",
    input: SecurityAckInput,
    output: Schema.Array(SecurityFinding),
    error: ReviewVerdictError,
  },
  securityFindings: {
    method: "review.security.findings",
    gateway: "read",
    input: SecurityFindingsInput,
    output: Schema.Array(SecurityFinding),
    error: ReviewVerdictError,
  },
  securityGetMode: {
    method: "review.security.getMode",
    gateway: "read",
    input: SecurityModeInput,
    output: SecurityModeSetting,
    error: ReviewVerdictError,
  },
  securitySetMode: {
    method: "review.security.setMode",
    gateway: "settingsWrite",
    input: SecurityModeSetting,
    output: SecurityModeSetting,
    error: ReviewVerdictError,
  },
});
