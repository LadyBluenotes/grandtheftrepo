import type {
  LearningCorrection,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
  OrchestrationV2TurnItem,
  ReviewVerdict,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ItemDelivery } from "../learning/items/ItemStore.ts";
import { outputTokens } from "./outputTokens.ts";

/*
 * Every value the reactor stores comes out of an event through one of these, keyed by the path a
 * measure names in `provenance`. The provenance test reads its fixtures through the same
 * functions, so a cited path is the field a column was filled from.
 */

const iso = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

const ToolInputPath = Schema.Struct({
  file_path: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});
const decodeToolInputPath = Schema.decodeUnknownOption(ToolInputPath);

/** The path a tool's input names, under the keys the providers use for it. */
const inputPath = (input: unknown) =>
  Option.match(decodeToolInputPath(input), {
    onNone: () => null,
    onSome: (fields) => fields.file_path ?? fields.filePath ?? fields.path ?? null,
  });

/** The latest merge among the thread's pull requests, normalized like every stored instant. */
const latestMerge = (thread: OrchestrationV2AppThread) =>
  visibleThreadPullRequests(thread.pullRequests ?? []).reduce<string | null>((latest, link) => {
    const mergedAt = link.snapshot?.state === "merged" ? link.snapshot.mergedAt : undefined;
    const at =
      typeof mergedAt === "string"
        ? Option.getOrNull(Option.map(DateTime.make(mergedAt), DateTime.formatIso))
        : null;
    return at !== null && (latest === null || at > latest) ? at : latest;
  }, null);

type ProviderTurnUpdated = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "provider-turn.updated" }
>;

/** A provider turn's usage report, or undefined when the event carries none. */
export const turnUsageFields = (event: ProviderTurnUpdated) => {
  const usage = event.payload.tokenUsage;
  return usage === undefined
    ? undefined
    : {
        "providerTurn.id": event.payload.id,
        "provider-turn.updated.threadId": event.threadId,
        "provider-turn.updated.runId": event.runId ?? null,
        "providerTurn.tokenUsage.inputTokens": usage.inputTokens ?? null,
        "providerTurn.tokenUsage.cachedInputTokens": usage.cachedInputTokens ?? null,
        "providerTurn.tokenUsage.outputTokens": usage.outputTokens ?? null,
        "providerTurn.tokenUsage.reasoningOutputTokens": usage.reasoningOutputTokens ?? null,
        "providerTurn.tokenUsage.updatedAt": usage.updatedAt,
      };
};

export const runFields = (run: OrchestrationV2Run) => ({
  "run.id": run.id,
  "run.threadId": run.threadId,
  /** The turn is the user message the run answers. */
  "run.userMessageId": run.userMessageId,
  "run.ordinal": run.ordinal,
  "run.status": run.status,
  /** With the model, which routing tier the run was on. */
  "run.providerInstanceId": run.providerInstanceId,
  "run.modelSelection.model": run.modelSelection.model,
  "run.startedAt": iso(run.startedAt),
  "run.completedAt": iso(run.completedAt),
});

export const toolCallFields = (item: OrchestrationV2TurnItem) => ({
  "turnItem.id": item.id,
  "turnItem.runId": item.runId,
  "turnItem.threadId": item.threadId,
  "turnItem.ordinal": item.ordinal,
  "turnItem.type": item.type,
  "turnItem.status": item.status,
  "turnItem.toolName": item.type === "dynamic_tool" ? item.toolName : null,
  /** The path in a dynamic tool's input, such as a read's `file_path`. */
  "turnItem.input": item.type === "dynamic_tool" ? inputPath(item.input) : null,
  /** The path a file change edited. */
  "turnItem.fileName": item.type === "file_change" ? item.fileName : null,
});

/**
 * How much of a command line is kept. A tool key needs only the program, which comes first, even
 * behind a shell wrapper.
 */
const COMMAND_CHARS = 512;

/**
 * What the tool output measures read of a tool call besides its name. `turnItem.input` is read
 * here as a command's command line, where `toolCallFields` reads a path out of a dynamic tool's.
 * Sizes are `outputTokens` estimates, 0 for an item with no output and null for an item that has
 * none to give, such as a file change.
 */
export const toolOutputFields = (item: OrchestrationV2TurnItem) => ({
  "turnItem.input": item.type === "command_execution" ? item.input.slice(0, COMMAND_CHARS) : null,
  /** A dynamic tool's or command's output. */
  "turnItem.output":
    item.type === "dynamic_tool" || item.type === "command_execution"
      ? outputTokens(item.output)
      : null,
  /** A file or web search's results. */
  "turnItem.results":
    item.type === "file_search" || item.type === "web_search" ? outputTokens(item.results) : null,
});

export const threadFields = (thread: OrchestrationV2AppThread) => ({
  "thread.id": thread.id,
  "thread.projectId": thread.projectId,
  "thread.createdAt": DateTime.formatIso(thread.createdAt),
  "thread.lineage.parentThreadId": thread.lineage.parentThreadId,
  "thread.lineage.relationshipToParent": thread.lineage.relationshipToParent,
  "thread.settledAt": iso(thread.settledAt),
  "thread.unsettledAt": iso(thread.unsettledAt),
  "thread.pullRequests.snapshot.mergedAt": latestMerge(thread),
});

/** Who settled a thread: the automatic settlement sweep dispatches under this command id prefix. */
export const settledFields = (stored: Pick<OrchestrationV2StoredEvent, "commandId">) => ({
  "thread.settled.commandId": stored.commandId,
});

/**
 * When a thread was pinned. Pinning a settled thread reopens it without a `thread.unsettled`, and
 * the pinned thread does not carry the reopen, so the event's own time is it.
 */
export const pinnedFields = (event: Pick<OrchestrationV2DomainEvent, "occurredAt">) => ({
  "thread.pinned.occurredAt": DateTime.formatIso(event.occurredAt),
});

/** A correction as the learning plugin lists it. */
export const correctionFields = (correction: LearningCorrection) => ({
  "learning.correction.createdAt": correction.createdAt,
  /** Set only when a reviewer or person declared the failure mode. */
  "learning.correction.declaredMode": correction.declaredMode,
});

/** A verdict as the review plugin lists it. */
export const verdictFields = (verdict: ReviewVerdict) => ({
  "review.verdict.id": verdict.id,
  "review.verdict.reviewedThreadId": verdict.reviewedThreadId,
  "review.verdict.outcome": verdict.outcome,
  "review.verdict.createdAt": verdict.createdAt,
});

/**
 * A failure mode's handover as `ItemStore.deliveredAt` lists it: the earliest delivered
 * promotion's `updatedAt`, which delivery sets and nothing changes after. It is read from the
 * promotion records, not the item, whose `updatedAt` moves with every later piece of evidence and
 * whose state with a person's later choice.
 */
export const deliveredFields = (delivery: ItemDelivery) => ({
  "learning.promotion.failureMode": delivery.failureMode,
  "learning.promotion.updatedAt": delivery.deliveredAt,
});

/** A path a measure may cite in `provenance`. */
export type FieldPath =
  | keyof NonNullable<ReturnType<typeof turnUsageFields>>
  | keyof ReturnType<typeof runFields>
  | keyof ReturnType<typeof toolCallFields>
  | keyof ReturnType<typeof toolOutputFields>
  | keyof ReturnType<typeof threadFields>
  | keyof ReturnType<typeof settledFields>
  | keyof ReturnType<typeof pinnedFields>
  | keyof ReturnType<typeof correctionFields>
  | keyof ReturnType<typeof verdictFields>
  | keyof ReturnType<typeof deliveredFields>;
