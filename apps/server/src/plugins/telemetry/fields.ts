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
import { digest } from "./digest.ts";
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
  notebook_path: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});
const decodeToolInputPath = Schema.decodeUnknownOption(ToolInputPath);

/** The path a tool's input names, under the keys the providers use for it. */
const inputPath = (input: unknown) =>
  Option.match(decodeToolInputPath(input), {
    onNone: () => null,
    onSome: (fields) =>
      fields.file_path ?? fields.filePath ?? fields.notebook_path ?? fields.path ?? null,
  });

const ToolInputPattern = Schema.Struct({
  pattern: Schema.optional(Schema.String),
  glob: Schema.optional(Schema.String),
});
const decodeToolInputPattern = Schema.decodeUnknownOption(ToolInputPattern);

/** What a search tool's input looks for: its `pattern`, else its `glob`. */
const inputPattern = (input: unknown) =>
  Option.match(decodeToolInputPattern(input), {
    onNone: () => null,
    onSome: (fields) => fields.pattern ?? fields.glob ?? null,
  });

const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** A tool input as one text: a string as it is, nothing as empty, anything else as its JSON. */
const inputText = (input: unknown) =>
  input === undefined || input === null
    ? ""
    : typeof input === "string"
      ? input
      : Option.getOrElse(encodeJson(input), () => "");

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
  /** Groups a call with no run, which a provider's subagent makes, with the rest of its turn. */
  "turnItem.providerTurnId": item.providerTurnId,
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
export const COMMAND_CHARS = 512;

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
  /**
   * When the item started, else when it last changed: where a call with no run, which a provider's
   * subagent makes, falls in a window. A call with a run is placed by its run.
   */
  "turnItem.startedAt": iso(item.startedAt),
  "turnItem.updatedAt": iso(item.updatedAt),
});

/**
 * A tool call's input: a command's command line, a dynamic tool's input, a file search's pattern
 * or a web search's patterns. A file change, or an item that is no tool call, has none.
 */
const toolInput = (item: OrchestrationV2TurnItem): { readonly input: unknown } | null => {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool":
      return { input: item.input };
    case "file_search":
      return { input: item.pattern };
    case "web_search":
      return { input: item.patterns };
    default:
      return null;
  }
};

/** An object input's keys, sorted and joined with commas; none for anything else. */
const inputKeys = (input: unknown) =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.keys(input).toSorted().join(",")
    : "";

/**
 * What the repeated work measures read of a tool call's input to shape it and to compare two
 * calls. The input itself is not kept: `turnItem.input` holds a dynamic tool's input keys (null
 * for other items), the input text's size in estimated tokens, its characters over four with no
 * allowance for images, and its sha256, which tells two equal inputs apart. A file change has no
 * recorded input, so all of it is null.
 */
export const toolInputFields = (item: OrchestrationV2TurnItem) => {
  const tool = toolInput(item);
  const text = tool === null ? "" : inputText(tool.input);
  return {
    /** A file search's pattern, or the `pattern`, else the `glob`, in a dynamic tool's input. */
    "turnItem.pattern":
      item.type === "file_search"
        ? (item.pattern ?? null)
        : item.type === "dynamic_tool"
          ? inputPattern(item.input)
          : null,
    "turnItem.input":
      tool === null
        ? null
        : {
            keys: item.type === "dynamic_tool" ? inputKeys(item.input) : null,
            tokens: Math.ceil(text.length / 4),
            digest: digest(text),
          },
  };
};

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
  | keyof ReturnType<typeof toolInputFields>
  | keyof ReturnType<typeof threadFields>
  | keyof ReturnType<typeof settledFields>
  | keyof ReturnType<typeof pinnedFields>
  | keyof ReturnType<typeof correctionFields>
  | keyof ReturnType<typeof verdictFields>
  | keyof ReturnType<typeof deliveredFields>;
