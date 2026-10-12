import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const KANBAN_WS_METHODS = {
  subscribe: "kanban.subscribe",
  getIssue: "kanban.getIssue",
  listDecisions: "kanban.listDecisions",
  write: "kanban.write",
  setDirectory: "kanban.setDirectory",
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

export const KanbanStance = Schema.Literals(["for", "against"]);
export type KanbanStance = typeof KanbanStance.Type;

/** `user`, `system` (automation), or `thread:<threadId>`. */
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

/** What the board needs per card; the body, log and criteria travel only with `getIssue`. */
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
  description: Schema.String,
  log: Schema.Array(KanbanLogEntry),
});
export type KanbanIssue = typeof KanbanIssue.Type;

export const KanbanDecision = Schema.Struct({
  category: KanbanSlug,
  id: KanbanSlug,
  stance: KanbanStance,
  title: TrimmedNonEmptyString,
  why: Schema.String,
  issues: Schema.Array(KanbanSlug),
  by: KanbanActor,
  at: IsoDateTime,
});
export type KanbanDecision = typeof KanbanDecision.Type;

export const KanbanBoard = Schema.Struct({
  /** Absolute base folder holding `issues/` and `decisions/`. */
  directory: Schema.String,
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
  "criterion.add",
  "criterion.update",
  "criterion.remove",
  "decision.create",
  "decision.update",
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
  /** Block reason for `issue.block`. */
  reason: Schema.optional(Schema.String),
  threadId: Schema.optional(ThreadId),
  category: Schema.optional(KanbanSlug),
  stance: Schema.optional(KanbanStance),
  why: Schema.optional(Schema.String),
  /** Related issue ids for a decision. */
  issues: Schema.optional(Schema.Array(KanbanSlug)),
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

const error = Schema.Union([KanbanError, EnvironmentAuthorizationError]);

export const KANBAN_RPCS = [
  Rpc.make(KANBAN_WS_METHODS.subscribe, {
    payload: KanbanProjectInput,
    success: KanbanBoard,
    error,
    stream: true,
  }),
  Rpc.make(KANBAN_WS_METHODS.getIssue, {
    payload: KanbanGetIssueInput,
    success: KanbanIssue,
    error,
  }),
  Rpc.make(KANBAN_WS_METHODS.listDecisions, {
    payload: KanbanListDecisionsInput,
    success: Schema.Array(KanbanDecision),
    error,
  }),
  Rpc.make(KANBAN_WS_METHODS.write, {
    payload: KanbanWriteInput,
    success: KanbanWriteResult,
    error,
  }),
  Rpc.make(KANBAN_WS_METHODS.setDirectory, {
    payload: KanbanSetDirectoryInput,
    success: Schema.Struct({}),
    error,
  }),
] as const;

/** Reads and subscriptions: server-side authorization only. */
export const KANBAN_RPC_SCOPES = {
  [KANBAN_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [KANBAN_WS_METHODS.getIssue]: AuthOrchestrationReadScope,
  [KANBAN_WS_METHODS.listDecisions]: AuthOrchestrationReadScope,
} as const;

/** Writes: clients check the grant before calling, the server checks it again. */
export const KANBAN_GUARDED_RPC_SCOPES = {
  [KANBAN_WS_METHODS.write]: AuthOrchestrationOperateScope,
  [KANBAN_WS_METHODS.setDirectory]: AuthSettingsWriteScope,
} as const;

export const KANBAN_RPC_SUBSYSTEMS = {
  [KANBAN_WS_METHODS.subscribe]: "kanban",
  [KANBAN_WS_METHODS.getIssue]: "kanban",
  [KANBAN_WS_METHODS.listDecisions]: "kanban",
  [KANBAN_WS_METHODS.write]: "kanban",
  [KANBAN_WS_METHODS.setDirectory]: "kanban",
} as const;
