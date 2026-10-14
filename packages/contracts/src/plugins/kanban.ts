import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "../auth.ts";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { definePluginMethods } from "./method.ts";

/** Stream RPCs keep their own tag; every other kanban method is in `KANBAN_METHODS`. */
export const KANBAN_WS_METHODS = {
  subscribe: "kanban.subscribe",
} as const;

export const KanbanStatus = Schema.Literals([
  "triage",
  "inbox",
  "todo",
  "in_progress",
  "in_review",
  "done",
]);
export type KanbanStatus = typeof KanbanStatus.Type;
export const KANBAN_STATUSES = KanbanStatus.literals;

export const KanbanPriority = Schema.Literals(["p0", "p1", "p2", "p3", "p4", "p5"]);
export type KanbanPriority = typeof KanbanPriority.Type;
export const KANBAN_PRIORITIES = KanbanPriority.literals;

export const KanbanVerification = Schema.Literals(["unverified", "partial", "verified"]);
export type KanbanVerification = typeof KanbanVerification.Type;
export const KANBAN_VERIFICATIONS = KanbanVerification.literals;

/**
 * Where a decision stands. `superseded` is set only by `decision.supersede`, which links the
 * replacement; any other state may follow any other.
 */
export const KanbanDecisionState = Schema.Literals([
  "proposed",
  "accepted",
  "rejected",
  "deferred",
  "conflicted",
  "superseded",
]);
export type KanbanDecisionState = typeof KanbanDecisionState.Type;
export const KANBAN_DECISION_STATES = KanbanDecisionState.literals;

/** What became of one option a decision weighed. */
export const KanbanAlternativeDisposition = Schema.Literals([
  "chosen",
  "rejected",
  "deferred",
  "unverified",
  "out_of_scope",
]);
export type KanbanAlternativeDisposition = typeof KanbanAlternativeDisposition.Type;

/**
 * Whether the reason holds for good, only in today's context, or for want of evidence. A
 * contextual or unverified rejection is the one worth reconsidering.
 */
export const KanbanAlternativeReasonKind = Schema.Literals([
  "permanent",
  "contextual",
  "lack_of_evidence",
]);
export type KanbanAlternativeReasonKind = typeof KanbanAlternativeReasonKind.Type;

export const KanbanAlternative = Schema.Struct({
  title: TrimmedNonEmptyString,
  disposition: KanbanAlternativeDisposition,
  reason: Schema.String,
  reasonKind: KanbanAlternativeReasonKind,
});
export type KanbanAlternative = typeof KanbanAlternative.Type;

/** `user`, `system` (automation), `spec` (a validated spec admitting a card), or `thread:<threadId>`. */
export const KanbanActor = TrimmedNonEmptyString;
export type KanbanActor = typeof KanbanActor.Type;

/** The filename stem of an issue or decision file, or a decision category. */
export const KanbanSlug = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,79}$/),
);
export type KanbanSlug = typeof KanbanSlug.Type;

export const KanbanLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(40));

export const KanbanBlock = Schema.Struct({
  reason: Schema.String,
  at: IsoDateTime,
  by: KanbanActor,
});
export type KanbanBlock = typeof KanbanBlock.Type;

export const KanbanThreadLink = Schema.Struct({ id: ThreadId, linkedAt: IsoDateTime });

/** The model class the author expects the work to need. */
export const KanbanTier = Schema.Literals(["cheap", "standard", "strong"]);
export type KanbanTier = typeof KanbanTier.Type;
export const KANBAN_TIERS = KanbanTier.literals;

/** One checkable sentence defining done. Ids are server-made. */
export const KanbanCriterion = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: Schema.String,
  checked: Schema.Boolean,
});
export type KanbanCriterion = typeof KanbanCriterion.Type;

/** Why a Done card came back: the work was wrong, or the ask changed. */
export const KanbanReopenReason = Schema.Literals(["defect", "scope_change"]);
export type KanbanReopenReason = typeof KanbanReopenReason.Type;

export const KanbanReopen = Schema.Struct({
  reason: KanbanReopenReason,
  at: IsoDateTime,
  by: KanbanActor,
});
export type KanbanReopen = typeof KanbanReopen.Type;

/** Why an issue needed no decision, stated in place of a linked one so it can move to Done. */
export const KanbanNoDecision = Schema.Struct({
  reason: Schema.String,
  at: IsoDateTime,
  by: KanbanActor,
});
export type KanbanNoDecision = typeof KanbanNoDecision.Type;

/** How far a finding was confirmed. */
export const KanbanFindingTruth = Schema.Literals([
  "seen",
  "partially_verified",
  "reproduced",
  "refuted",
  "unknown",
]);
export type KanbanFindingTruth = typeof KanbanFindingTruth.Type;

/** How a finding relates to the change the agent was making when it found it. */
export const KanbanFindingScope = Schema.Literals([
  "caused_by_current_change",
  "pre_existing",
  "adjacent",
  "unrelated",
  "unknown",
]);
export type KanbanFindingScope = typeof KanbanFindingScope.Type;

/** What is to be done about a finding: `open` until a review decides, and again once reopened. */
export const KanbanFindingDisposition = Schema.Literals([
  "open",
  "fix_now",
  "ticketed",
  "accepted_risk",
  "duplicate",
  "rejected",
  "wont_fix",
]);
export type KanbanFindingDisposition = typeof KanbanFindingDisposition.Type;
export const KANBAN_FINDING_DISPOSITIONS = KanbanFindingDisposition.literals;

/** The latest review: who set the disposition, when and why. */
export const KanbanFindingReview = Schema.Struct({
  by: KanbanActor,
  at: IsoDateTime,
  reason: Schema.String,
});

/**
 * A problem an agent found outside its task, kept on the issue it concerns or on the Triage issue
 * labeled `finding` opened for it. The id is server-made and unique in the project, and stays
 * the same when the finding moves to another issue.
 */
export const KanbanFinding = Schema.Struct({
  id: KanbanSlug,
  title: TrimmedNonEmptyString,
  evidence: Schema.String,
  truthStatus: KanbanFindingTruth,
  scopeRelation: KanbanFindingScope,
  disposition: KanbanFindingDisposition,
  /** `thread:<threadId>` of the agent that captured it, which may not review it. */
  proposedBy: KanbanActor,
  /** When it was captured; a move keeps it. */
  proposedAt: IsoDateTime,
  /** The thread it was found in. */
  threadId: ThreadId,
  /**
   * The latest review, null until someone other than the proposer reviews it. The reviewer owns
   * the finding from then on, so a finding with no review has no owner.
   */
  review: Schema.NullOr(KanbanFindingReview),
});
export type KanbanFinding = typeof KanbanFinding.Type;

const KanbanIssueFields = {
  id: KanbanSlug,
  title: TrimmedNonEmptyString,
  status: KanbanStatus,
  priority: KanbanPriority,
  labels: Schema.Array(KanbanLabel),
  verification: KanbanVerification,
  tier: Schema.NullOr(KanbanTier),
  blocked: Schema.NullOr(KanbanBlock),
  /** The latest reopen; null until a Done card comes back. */
  reopened: Schema.NullOr(KanbanReopen),
  threads: Schema.Array(KanbanThreadLink),
  createdAt: IsoDateTime,
  createdBy: KanbanActor,
  updatedAt: IsoDateTime,
  doneAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
};

/** What the board needs per card; the body, log, criteria and findings travel only with `getIssue`. */
export const KanbanIssueSummary = Schema.Struct({
  ...KanbanIssueFields,
  criteriaOpen: Schema.Int,
  criteriaTotal: Schema.Int,
});
export type KanbanIssueSummary = typeof KanbanIssueSummary.Type;

export const KanbanLogKind = Schema.Literals([
  "note",
  "status",
  "blocked",
  "unblocked",
  "reopened",
  "criterion",
]);
export type KanbanLogKind = typeof KanbanLogKind.Type;

export const KanbanLogEntry = Schema.Struct({
  at: IsoDateTime,
  by: KanbanActor,
  kind: KanbanLogKind,
  text: Schema.String,
});
export type KanbanLogEntry = typeof KanbanLogEntry.Type;

export const KanbanIssue = Schema.Struct({
  ...KanbanIssueFields,
  criteria: Schema.Array(KanbanCriterion),
  // A server from before findings sends none; an older client ignores the field.
  findings: Schema.Array(KanbanFinding).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Whether Done also needs a decision listing this issue or a `noDecision`, and no open finding.
   * Every issue filed since that check began has it; an older issue file does not, and is exempt,
   * as is every issue a server from before the check sends.
   */
  closureCheck: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  noDecision: Schema.NullOr(KanbanNoDecision).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  description: Schema.String,
  log: Schema.Array(KanbanLogEntry),
});
export type KanbanIssue = typeof KanbanIssue.Type;

/** A decision as `<category>/<id>`; ids are unique only within a category. */
export const KanbanDecisionRef = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,79}$/),
);
export type KanbanDecisionRef = typeof KanbanDecisionRef.Type;

/** One change to a decision, appended by every write that changes it and never removed. */
export const KanbanDecisionRevision = Schema.Struct({
  at: IsoDateTime,
  by: KanbanActor,
  change: Schema.String,
});
export type KanbanDecisionRevision = typeof KanbanDecisionRevision.Type;

export const KanbanDecision = Schema.Struct({
  category: KanbanSlug,
  id: KanbanSlug,
  state: KanbanDecisionState,
  title: TrimmedNonEmptyString,
  why: Schema.String,
  /** The options weighed, the chosen one included, each with why it went that way. */
  alternatives: Schema.Array(KanbanAlternative),
  /** What would make this worth deciding again. */
  reconsiderWhen: Schema.NullOr(Schema.String),
  supersedes: Schema.Array(KanbanDecisionRef),
  /** Set with the `superseded` state, and cleared when the decision leaves it. */
  supersededBy: Schema.NullOr(KanbanDecisionRef),
  issues: Schema.Array(KanbanSlug),
  /** Threads where the decision was made or applied. */
  threads: Schema.Array(ThreadId),
  /** Who recorded it, and when. */
  by: KanbanActor,
  at: IsoDateTime,
  revisions: Schema.Array(KanbanDecisionRevision),
});
export type KanbanDecision = typeof KanbanDecision.Type;

export const KanbanBoard = Schema.Struct({
  /** Absolute base folder holding `issues/` and `decisions/`. */
  directory: Schema.String,
  /** Whether a settled thread's last reply is read for decisions and findings it did not record. */
  capture: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  issues: Schema.Array(KanbanIssueSummary),
  decisionCategories: Schema.Array(Schema.Struct({ category: KanbanSlug, count: Schema.Int })),
});
export type KanbanBoard = typeof KanbanBoard.Type;

export const KanbanWriteAction = Schema.Literals([
  "issue.create",
  "issue.update",
  "issue.move",
  "issue.note",
  "issue.block",
  "issue.unblock",
  "issue.link",
  "issue.unlink",
  "issue.archive",
  "issue.unarchive",
  "issue.delete",
  "issue.noDecision",
  "criterion.add",
  "criterion.update",
  "criterion.remove",
  "decision.create",
  "decision.update",
  "decision.setState",
  "decision.supersede",
  "decision.delete",
]);
export type KanbanWriteAction = typeof KanbanWriteAction.Type;

/**
 * One flat shape for every change, shared by the RPC and the MCP tool so the
 * schema is paid for once. The server checks the fields each action needs.
 */
export const KanbanWrite = Schema.Struct({
  action: KanbanWriteAction,
  /** Issue id, or decision id for `decision.*`. */
  id: Schema.optional(KanbanSlug),
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  priority: Schema.optional(KanbanPriority),
  labels: Schema.optional(Schema.Array(KanbanLabel)),
  verification: Schema.optional(KanbanVerification),
  tier: Schema.optional(KanbanTier),
  status: Schema.optional(KanbanStatus),
  /** Required by `issue.move` when the card leaves Done. */
  reopenReason: Schema.optional(KanbanReopenReason),
  /** Note text for `issue.note`; criterion text for `criterion.add` and `criterion.update`. */
  text: Schema.optional(Schema.String),
  criterionId: Schema.optional(TrimmedNonEmptyString),
  /** New checked state for `criterion.update`. */
  checked: Schema.optional(Schema.Boolean),
  /**
   * Block reason for `issue.block`; for `issue.noDecision`, why the issue needed no decision, and
   * empty clears it.
   */
  reason: Schema.optional(Schema.String),
  threadId: Schema.optional(ThreadId),
  category: Schema.optional(KanbanSlug),
  /** A decision's state for `decision.create` and `decision.setState`. */
  state: Schema.optional(KanbanDecisionState),
  why: Schema.optional(Schema.String),
  alternatives: Schema.optional(Schema.Array(KanbanAlternative)),
  /** Empty clears it. */
  reconsiderWhen: Schema.optional(Schema.String),
  /** Related issue ids for a decision. */
  issues: Schema.optional(Schema.Array(KanbanSlug)),
  /** Threads a decision was made or applied in. */
  threads: Schema.optional(Schema.Array(ThreadId)),
  /** The replacing decision for `decision.supersede`. */
  by: Schema.optional(KanbanDecisionRef),
});
export type KanbanWrite = typeof KanbanWrite.Type;

export const KanbanWriteResult = Schema.Struct({ id: KanbanSlug });
export type KanbanWriteResult = typeof KanbanWriteResult.Type;

export class KanbanError extends Schema.TaggedError<KanbanError>()("KanbanError", {
  code: Schema.Literals(["inactive", "not_found", "invalid", "gated", "io"]),
  message: Schema.String,
}) {}

const KanbanProjectInput = Schema.Struct({ projectId: ProjectId });
export const KanbanGetIssueInput = Schema.Struct({ projectId: ProjectId, id: KanbanSlug });
export type KanbanGetIssueInput = typeof KanbanGetIssueInput.Type;
export const KanbanListDecisionsInput = Schema.Struct({
  projectId: ProjectId,
  category: Schema.optional(KanbanSlug),
  issue: Schema.optional(KanbanSlug),
  /** Only decisions linked to this thread, as the thread header counts them. */
  thread: Schema.optional(ThreadId),
  state: Schema.optional(KanbanDecisionState),
  /**
   * Words to look for in a decision's text; a decision matching any is kept, and the list is
   * ordered by how many it matches, then newest first.
   */
  query: Schema.optional(Schema.String),
});
export type KanbanListDecisionsInput = typeof KanbanListDecisionsInput.Type;
export const KanbanWriteInput = Schema.Struct({ projectId: ProjectId, ...KanbanWrite.fields });
export type KanbanWriteInput = typeof KanbanWriteInput.Type;
export const KanbanSetDirectoryInput = Schema.Struct({
  projectId: ProjectId,
  /** Absolute path, or null to return to the default under T3 home. */
  directory: Schema.NullOr(TrimmedNonEmptyString),
});
export type KanbanSetDirectoryInput = typeof KanbanSetDirectoryInput.Type;
export const KanbanSetCaptureInput = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
export type KanbanSetCaptureInput = typeof KanbanSetCaptureInput.Type;

/** Sets a finding's disposition; `open` reopens it. Its proposer is refused. */
export const KanbanFindingReviewInput = Schema.Struct({
  projectId: ProjectId,
  id: KanbanSlug,
  disposition: KanbanFindingDisposition,
  reason: TrimmedNonEmptyString,
});
export type KanbanFindingReviewInput = typeof KanbanFindingReviewInput.Type;

export const KanbanFindingMoveInput = Schema.Struct({
  projectId: ProjectId,
  id: KanbanSlug,
  /** Where it goes; omitted, a Triage issue labeled `finding` is opened for it. */
  issueId: Schema.optional(KanbanSlug),
});
export type KanbanFindingMoveInput = typeof KanbanFindingMoveInput.Type;

/** A finding and the issue holding it, after a capture, review or move. */
export const KanbanFindingPlacement = Schema.Struct({
  projectId: ProjectId,
  issueId: KanbanSlug,
  finding: KanbanFinding,
});
export type KanbanFindingPlacement = typeof KanbanFindingPlacement.Type;

/**
 * The emergency stop while it is set: nothing the supervisor starts may launch a ticket. It
 * does not stop running agents, and a person starting work by hand is never blocked.
 */
export const KanbanStop = Schema.Struct({
  setAt: IsoDateTime,
  /** `user`, or `thread:<threadId>` for an agent. */
  setBy: KanbanActor,
  reason: Schema.NullOr(Schema.String),
});
export type KanbanStop = typeof KanbanStop.Type;

export const KanbanStopSetInput = Schema.Struct({ reason: Schema.optional(Schema.String) });
export type KanbanStopSetInput = typeof KanbanStopSetInput.Type;

/** Where a spec attempt's text came from: a drafting thread, or the issue's own description. */
export const KanbanSpecSource = Schema.Literals(["child", "existing"]);
export type KanbanSpecSource = typeof KanbanSpecSource.Type;

export const KanbanSpecStatus = Schema.Literals(["running", "valid", "malformed"]);
export type KanbanSpecStatus = typeof KanbanSpecStatus.Type;

/**
 * One try at turning an issue into a checkable spec: `## Goal`, `## Approach`, `## Acceptance`
 * and an optional `## Out of scope`. A valid one admitted the issue with its Acceptance items as
 * criteria; a malformed one left the issue as it was. The description is never edited.
 */
export const KanbanSpecAttempt = Schema.Struct({
  id: PositiveInt,
  projectId: ProjectId,
  issueId: KanbanSlug,
  source: KanbanSpecSource,
  /** The drafting thread, for `child`. */
  childThreadId: Schema.NullOr(ThreadId),
  status: KanbanSpecStatus,
  /** The text the validator checked; null while the child is drafting. */
  text: Schema.NullOr(Schema.String),
  /** Why the text was refused, when `malformed`. */
  reason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanSpecAttempt = typeof KanbanSpecAttempt.Type;

/**
 * The latest attempt with the status its issue is in now. A `valid` attempt says the spec passed,
 * not that the card moved: the admission can have failed after the attempt was stored, or the card
 * can have been moved on while a drafting thread worked.
 */
export const KanbanSpecReport = Schema.Struct({
  attempt: KanbanSpecAttempt,
  /** Null when the issue no longer exists: it was deleted after the attempt. */
  issueStatus: Schema.NullOr(KanbanStatus),
});
export type KanbanSpecReport = typeof KanbanSpecReport.Type;

export const KanbanSpecifyInput = Schema.Struct({
  projectId: ProjectId,
  id: KanbanSlug,
  /** Validate the description as written: no drafting thread, no model. */
  useExisting: Schema.optional(Schema.Boolean),
});
export type KanbanSpecifyInput = typeof KanbanSpecifyInput.Type;

/**
 * What a strip row is about: `question` and `permission` for a request an agent is waiting on,
 * the flag's own kind otherwise.
 */
export const KanbanAttentionKind = Schema.Literals([
  "question",
  "permission",
  "budget_breach",
  "routing_mismatch",
  "two_writers",
  "stale_review",
  "security_hold",
  "unowned_finding",
  "delivery_drift",
  "promotion_ineffective",
  "promotion_settled",
  "decision_conflict",
  "promotion_review",
  "closure_held",
  "deterministic_proposals",
]);
export type KanbanAttentionKind = typeof KanbanAttentionKind.Type;

/**
 * How each kind reads on a strip row, as a short label. Keyed by every kind, so a plugin that adds
 * one fails to typecheck here and no client keeps a list of its own.
 */
export const KANBAN_ATTENTION_KIND_LABELS: Record<KanbanAttentionKind, string> = {
  question: "Question",
  permission: "Permission",
  budget_breach: "Budget breach",
  routing_mismatch: "Routing mismatch",
  two_writers: "Two writers",
  stale_review: "Stale review",
  security_hold: "Security hold",
  unowned_finding: "Unowned finding",
  delivery_drift: "Delivery drift",
  promotion_ineffective: "Handover ineffective",
  promotion_settled: "Handover settled",
  decision_conflict: "Decision conflict",
  promotion_review: "Handover review",
  closure_held: "Held from Done",
  deterministic_proposals: "Could be deterministic",
};

/**
 * What to do about a flag: a label and the screen it leads to, on the board's environment. A
 * `plugin` target opens `/plugins/<pluginId>` on `tab` with `recordId` open, each when given;
 * mobile, which has no plugin screens, stays on the board.
 */
export const AttentionResumeAction = Schema.Union([
  Schema.Struct({
    label: Schema.String,
    target: Schema.Literals(["thread", "board", "settings"]),
  }),
  Schema.Struct({
    label: Schema.String,
    target: Schema.Literal("plugin"),
    pluginId: Schema.String,
    tab: Schema.optional(Schema.String),
    /** The plugin's own id for the record, such as a learning item's. */
    recordId: Schema.optional(Schema.String),
  }),
]);
export type AttentionResumeAction = typeof AttentionResumeAction.Type;

/**
 * One thing in a project waiting on a person: a live request on one of its threads, or a flag a
 * plugin raised. A row leaves when its cause clears; nothing dismisses it.
 */
export const KanbanAttentionRow = Schema.Struct({
  source: Schema.Literals(["request", "flag"]),
  id: TrimmedNonEmptyString,
  /** Null for a flag about the project rather than one thread, such as a budget breach. */
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  kind: KanbanAttentionKind,
  /** One sentence. */
  text: Schema.String,
  resumeAction: AttentionResumeAction,
  /** When it started waiting; rows are ordered by it, oldest first. */
  since: IsoDateTime,
});
export type KanbanAttentionRow = typeof KanbanAttentionRow.Type;

export const KANBAN_METHODS = definePluginMethods({
  getIssue: {
    method: "kanban.getIssue",
    gateway: "read",
    input: KanbanGetIssueInput,
    output: KanbanIssue,
    error: KanbanError,
  },
  listDecisions: {
    method: "kanban.listDecisions",
    gateway: "read",
    input: KanbanListDecisionsInput,
    output: Schema.Array(KanbanDecision),
    error: KanbanError,
  },
  write: {
    method: "kanban.write",
    gateway: "operate",
    input: KanbanWriteInput,
    output: KanbanWriteResult,
    error: KanbanError,
  },
  setDirectory: {
    method: "kanban.setDirectory",
    gateway: "settingsWrite",
    input: KanbanSetDirectoryInput,
    output: Schema.Struct({}),
    error: KanbanError,
  },
  /**
   * Turns settle-time capture on or off for a project: when one of its threads settles, a cheap
   * turn reads the last reply and files what it decided or found, unrecorded, as drafts.
   */
  setCapture: {
    method: "kanban.setCapture",
    gateway: "settingsWrite",
    input: KanbanSetCaptureInput,
    output: Schema.Struct({}),
    error: KanbanError,
  },
  /** Sets the stop; when it is already set, answers with the stop that was there first. */
  stopSet: {
    method: "kanban.stop.set",
    gateway: "operate",
    input: KanbanStopSetInput,
    output: KanbanStop,
    error: KanbanError,
  },
  /** Clears the stop; succeeds when it was not set. */
  stopClear: {
    method: "kanban.stop.clear",
    gateway: "operate",
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    error: KanbanError,
  },
  stopGet: {
    method: "kanban.stop.get",
    gateway: "read",
    input: Schema.Struct({}),
    output: Schema.NullOr(KanbanStop),
    error: KanbanError,
  },
  /**
   * Starts one attempt at a spec for a Triage or Inbox issue and returns it: `running` while a
   * drafting thread works, or already decided with `useExisting`.
   */
  ticketSpecify: {
    method: "kanban.ticket.specify",
    gateway: "operate",
    input: KanbanSpecifyInput,
    output: KanbanSpecAttempt,
    error: KanbanError,
  },
  /** The issue's latest spec attempt and the status the issue is in now (null once it is deleted), or null without an attempt. */
  specGet: {
    method: "kanban.spec.get",
    gateway: "read",
    input: KanbanGetIssueInput,
    output: Schema.NullOr(KanbanSpecReport),
    error: KanbanError,
  },
  /** What waits on a person in a project, oldest first. */
  attentionList: {
    method: "kanban.attention.list",
    gateway: "read",
    input: KanbanProjectInput,
    output: Schema.Array(KanbanAttentionRow),
    error: KanbanError,
  },
  findingReview: {
    method: "kanban.finding.review",
    gateway: "operate",
    input: KanbanFindingReviewInput,
    output: KanbanFindingPlacement,
    error: KanbanError,
  },
  findingMove: {
    method: "kanban.finding.move",
    gateway: "operate",
    input: KanbanFindingMoveInput,
    output: KanbanFindingPlacement,
    error: KanbanError,
  },
});

export const KANBAN_RPCS = [
  Rpc.make(KANBAN_WS_METHODS.subscribe, {
    payload: KanbanProjectInput,
    success: KanbanBoard,
    error: Schema.Union([KanbanError, EnvironmentAuthorizationError]),
    stream: true,
  }),
] as const;

/** Subscriptions: server-side authorization only. */
export const KANBAN_RPC_SCOPES = {
  [KANBAN_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
} as const;

export const KANBAN_RPC_SUBSYSTEMS = {
  [KANBAN_WS_METHODS.subscribe]: "kanban",
} as const;
