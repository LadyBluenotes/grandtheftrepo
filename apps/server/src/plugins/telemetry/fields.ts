import type {
  LearningCorrection,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

/** A correction as the learning plugin lists it. */
export const correctionFields = (correction: LearningCorrection) => ({
  "learning.correction.createdAt": correction.createdAt,
});

/** A path a measure may cite in `provenance`. */
export type FieldPath =
  | keyof NonNullable<ReturnType<typeof turnUsageFields>>
  | keyof ReturnType<typeof runFields>
  | keyof ReturnType<typeof toolCallFields>
  | keyof ReturnType<typeof threadFields>
  | keyof ReturnType<typeof settledFields>
  | keyof ReturnType<typeof correctionFields>;
