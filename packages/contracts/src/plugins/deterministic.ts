import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ProjectScript } from "../project.ts";
import { KanbanSlug } from "./kanban.ts";
import { LearningError } from "./learning.ts";
import { definePluginMethods } from "./method.ts";
import { TelemetryExtractionCandidate, TelemetryExtractionForm } from "./telemetry.ts";

/**
 * `waiting` has no draft yet because its form's target is off or absent, and the weekly sweep
 * tries again; `pending` has a draft waiting for a person; `accepted` and `dismissed` are decided.
 */
export const DeterministicProposalState = Schema.Literals([
  "waiting",
  "pending",
  "accepted",
  "dismissed",
]);
export type DeterministicProposalState = typeof DeterministicProposalState.Type;

/**
 * What a proposal drafted, by form. A project script has no draft state of its own, so its draft
 * is held here until accepted; every other draft lives in its target, as a proposed prompt, a
 * knowledge draft, a paused scheduled task or a Triage card labeled `deterministic`.
 */
export const DeterministicDraft = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("script"), script: ProjectScript }),
  Schema.Struct({ kind: Schema.Literal("prompt"), promptId: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("knowledge"), pageId: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("scheduled_task"), taskId: ScheduledTaskId }),
  Schema.Struct({ kind: Schema.Literal("kanban"), issueId: KanbanSlug }),
]);
export type DeterministicDraft = typeof DeterministicDraft.Type;

/**
 * One extraction candidate the weekly sweep turned into a draft for a person to accept or dismiss.
 * A candidate is proposed once; a dismissed one comes back only when a later week's cost is at
 * least twice what it was when dismissed.
 */
export const DeterministicProposal = Schema.Struct({
  id: Schema.Int,
  projectId: ProjectId,
  /** The candidate's id, the same in every window. */
  candidateId: Schema.String,
  form: TelemetryExtractionForm,
  /** One line naming the repeated work. */
  title: Schema.String,
  steps: Schema.Array(Schema.String),
  threads: NonNegativeInt,
  occurrences: NonNegativeInt,
  deterministicRatio: Schema.Finite,
  /**
   * What the work cost in the week it was proposed from, in estimated tokens: about what doing it
   * without a model saves in such a week.
   */
  estimatedTokens: NonNegativeInt,
  example: TelemetryExtractionCandidate.fields.example,
  /** The first instant of the seven days the candidate was found in, a Monday at 00:00 UTC. */
  windowFrom: IsoDateTime,
  state: DeterministicProposalState,
  /** Null while `waiting`. */
  draft: Schema.NullOr(DeterministicDraft),
  /** Why a `waiting` proposal has no draft yet. */
  waitingReason: Schema.NullOr(Schema.String),
  /** `user` for a person, `thread:<id>` for an agent. */
  decidedBy: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(IsoDateTime),
  dismissReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type DeterministicProposal = typeof DeterministicProposal.Type;

/** The most proposals a list answers with. */
export const DETERMINISTIC_PROPOSALS_LIMIT = 100;

/** A project's proposals, newest first, at most `DETERMINISTIC_PROPOSALS_LIMIT`; `state` narrows. */
export const DeterministicProposalsInput = Schema.Struct({
  projectId: ProjectId,
  state: Schema.optional(DeterministicProposalState),
});
export type DeterministicProposalsInput = typeof DeterministicProposalsInput.Type;

export const DeterministicAcceptInput = Schema.Struct({ id: Schema.Int });
export type DeterministicAcceptInput = typeof DeterministicAcceptInput.Type;

export const DETERMINISTIC_DISMISS_REASON_MAX_LENGTH = 500;
export const DeterministicDismissInput = Schema.Struct({
  id: Schema.Int,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(DETERMINISTIC_DISMISS_REASON_MAX_LENGTH)),
});
export type DeterministicDismissInput = typeof DeterministicDismissInput.Type;

/**
 * The review of repeated work lives in the learning plugin, so its methods answer with
 * `LearningError` and are named under `learning.`. Accepting writes project settings, instruction
 * files or schedules, so it needs the settings grant.
 */
export const DETERMINISTIC_METHODS = definePluginMethods({
  list: {
    method: "learning.deterministicProposals",
    gateway: "read",
    input: DeterministicProposalsInput,
    output: Schema.Array(DeterministicProposal),
    error: LearningError,
  },
  /**
   * Only a `pending` proposal: a script joins the project's scripts, a prompt becomes active, a
   * knowledge page is accepted and installed, a task is turned on, a card moves to Todo.
   */
  accept: {
    method: "learning.deterministicAccept",
    gateway: "settingsWrite",
    input: DeterministicAcceptInput,
    output: DeterministicProposal,
    error: LearningError,
  },
  /**
   * A `waiting` or `pending` proposal, with a reason. A draft still undecided in its target is
   * withdrawn: the prompt archived, the knowledge draft discarded, the paused task deleted, the
   * Triage card archived.
   */
  dismiss: {
    method: "learning.deterministicDismiss",
    gateway: "operate",
    input: DeterministicDismissInput,
    output: DeterministicProposal,
    error: LearningError,
  },
});
