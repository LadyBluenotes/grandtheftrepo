import * as Schema from "effect/Schema";
import { EventId, IsoDateTime, ProjectId, ThreadId } from "../baseSchemas.ts";
import { definePluginMethods } from "./method.ts";

const LEARNING_WS_METHODS = {
  corrections: "learning.corrections",
  correction: "learning.correction",
  items: "learning.items",
  item: "learning.item",
  itemsSetDisposition: "learning.itemsSetDisposition",
} as const;

/** Which kind of event produced a correction. */
export const LearningFailureKind = Schema.Literals([
  "provider_turn_failed",
  "provider_turn_interrupted",
  "changes_requested",
  "reopened_after_settlement",
  "review_verdict",
  "security",
  "manual",
]);
export type LearningFailureKind = typeof LearningFailureKind.Type;

/** The six failure modes a reviewer declares on a verdict. */
export const ReviewFailureMode = Schema.Literals([
  "defect",
  "incomplete",
  "scope_drift",
  "missing_verification",
  "convention",
  "unclear_spec",
]);

/**
 * The failure mode a correction declares: a review failure mode, which a reviewer, a person or a
 * reopened ticket names, or `security`, which the security scan names.
 */
export type ReviewFailureMode = typeof ReviewFailureMode.Type;

export const LearningDeclaredMode = Schema.Literals([...ReviewFailureMode.literals, "security"]);
export type LearningDeclaredMode = typeof LearningDeclaredMode.Type;

/** One recorded instance of work being wrong or failing. */
export const LearningCorrection = Schema.Struct({
  id: Schema.Int,
  projectId: ProjectId,
  threadId: ThreadId,
  failureKind: LearningFailureKind,
  /** Why it happened: the declared mode once classified, otherwise `unclassified`. */
  causeClass: Schema.String,
  /** Set only when its source names one; a provider failure never does. */
  declaredMode: Schema.NullOr(LearningDeclaredMode),
  /** Bounded, with secrets redacted. */
  description: Schema.String,
  sourceEventIds: Schema.Array(EventId),
  /** Derived from the source event and unique with `failureKind`; null for a manual row. */
  sourceKey: Schema.NullOr(Schema.String),
  /** When the classify sweep looked at it; null until then. */
  classifiedAt: Schema.NullOr(IsoDateTime),
  /** Why it got its cause class, such as `provider failure` or `no declared mode`. */
  classificationReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LearningCorrection = typeof LearningCorrection.Type;

/** Who should act on a learning item; `local_only` has nothing to hand over. */
export const LearningOwnerKind = Schema.Literals([
  "project_knowledge",
  "prompt",
  "policy",
  "local_only",
]);
export type LearningOwnerKind = typeof LearningOwnerKind.Type;

/** `candidate` waits for promotion, `promoted` was handed over; only a person closes. */
export const LearningItemState = Schema.Literals(["open", "candidate", "promoted", "closed"]);
export type LearningItemState = typeof LearningItemState.Type;

/**
 * The durable record for one recurring failure mode in one project. Its failure mode is one of
 * the declared modes, or another mode a later producer opens, such as an efficiency regression.
 */
export const LearningItem = Schema.Struct({
  id: Schema.Int,
  projectId: ProjectId,
  failureMode: Schema.String,
  /** How many distinct pieces of evidence it has. */
  occurrences: Schema.Int,
  state: LearningItemState,
  /** Null while no rule or person has picked one. */
  ownerKind: Schema.NullOr(LearningOwnerKind),
  /** A rule never changes an item a person has set. */
  dispositionBy: Schema.Literals(["rule", "person"]),
  /**
   * When a person last set the disposition; null while the rules own it, and for a person's
   * choice made before this was recorded. New evidence moves `updatedAt`, never this.
   */
  dispositionAt: Schema.NullOr(IsoDateTime),
  reason: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LearningItem = typeof LearningItem.Type;

/** One occurrence of an item's failure mode; the key is unique per item, such as `correction:12`. */
export const LearningItemEvidence = Schema.Struct({
  evidenceKey: Schema.String,
  summary: Schema.String,
  createdAt: IsoDateTime,
});
export type LearningItemEvidence = typeof LearningItemEvidence.Type;

/** Handing an item to one owner kind, once per project, failure mode and owner kind. */
export const LearningPromotion = Schema.Struct({
  id: Schema.Int,
  itemId: Schema.Int,
  projectId: ProjectId,
  failureMode: Schema.String,
  ownerKind: LearningOwnerKind,
  state: Schema.Literals(["pending", "delivered", "failed"]),
  /** Failed attempts so far; the fifth makes it `failed`. */
  attempts: Schema.Int,
  /** The earliest the next attempt runs, after a failed one; null when nothing is waiting on time. */
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LearningPromotion = typeof LearningPromotion.Type;

export const LearningItemDetail = Schema.Struct({
  item: LearningItem,
  evidence: Schema.Array(LearningItemEvidence),
  promotions: Schema.Array(LearningPromotion),
});
export type LearningItemDetail = typeof LearningItemDetail.Type;

export class LearningError extends Schema.TaggedError<LearningError>()("LearningError", {
  code: Schema.Literals(["inactive", "not_found", "invalid", "io"]),
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

/** A project's items, most recently updated first, narrowed to one state when given. */
export const LearningItemsInput = Schema.Struct({
  projectId: ProjectId,
  state: Schema.optional(LearningItemState),
});
export type LearningItemsInput = typeof LearningItemsInput.Type;

export const LearningItemInput = Schema.Struct({ id: Schema.Int });
export type LearningItemInput = typeof LearningItemInput.Type;

/**
 * A person's disposition: an owner kind, null to clear it, and `open` or `closed`, at least one of
 * the two. An open item is a `candidate` while its owner kind has something to hand over;
 * `candidate` and `promoted` themselves are refused, since the owner kind and delivery set them.
 */
export const LearningItemsSetDispositionInput = Schema.Struct({
  id: Schema.Int,
  ownerKind: Schema.optional(Schema.NullOr(LearningOwnerKind)),
  state: Schema.optional(LearningItemState),
}).check(
  Schema.makeFilter(
    (input) =>
      input.ownerKind !== undefined ||
      input.state !== undefined ||
      "A disposition needs an owner kind, a state or both.",
  ),
);
export type LearningItemsSetDispositionInput = typeof LearningItemsSetDispositionInput.Type;

/**
 * The plugin's methods and the gateway each answers behind. They are not in the WebSocket RPC
 * group, which is at TypeScript's instantiation limit; the gateway RPCs dispatch them by name.
 */
export const LEARNING_METHODS = definePluginMethods({
  corrections: {
    method: LEARNING_WS_METHODS.corrections,
    gateway: "read",
    input: LearningCorrectionsInput,
    output: Schema.Array(LearningCorrection),
    error: LearningError,
  },
  correction: {
    method: LEARNING_WS_METHODS.correction,
    gateway: "read",
    input: LearningCorrectionInput,
    output: LearningCorrection,
    error: LearningError,
  },
  items: {
    method: LEARNING_WS_METHODS.items,
    gateway: "read",
    input: LearningItemsInput,
    output: Schema.Array(LearningItem),
    error: LearningError,
  },
  item: {
    method: LEARNING_WS_METHODS.item,
    gateway: "read",
    input: LearningItemInput,
    output: LearningItemDetail,
    error: LearningError,
  },
  itemsSetDisposition: {
    method: LEARNING_WS_METHODS.itemsSetDisposition,
    gateway: "operate",
    input: LearningItemsSetDispositionInput,
    output: LearningItem,
    error: LearningError,
  },
});
