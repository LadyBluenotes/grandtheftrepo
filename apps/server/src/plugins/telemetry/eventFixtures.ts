import {
  CheckpointId,
  CommandId,
  EventId,
  type LearningCorrection,
  type LearningPromotion,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ReviewVerdict,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ItemDelivery } from "../learning/items/ItemStore.ts";

/** Events for the reactor and provenance tests, each with every field the measures read set. */
export const at = DateTime.makeUnsafe("2026-10-02T12:00:00.000Z");
export const projectId = ProjectId.make("project:telemetry");
export const threadId = ThreadId.make("thread:telemetry");
export const runId = RunId.make("run:telemetry");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

let sequence = 0;
const nextEventId = () => EventId.make(`event:telemetry-${++sequence}`);

/** A child task, settled by the sweep after its pull request merged, reopened before that. */
export const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "mcp",
  id: threadId,
  projectId,
  title: "Thread",
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: ThreadId.make("thread:parent"),
    relationshipToParent: "subagent",
    rootThreadId: ThreadId.make("thread:parent"),
  },
  forkedFrom: null,
  pullRequests: [
    {
      host: "github.com",
      repository: "o/r",
      number: 7,
      url: "https://github.com/o/r/pull/7",
      source: "manual",
      linkedAt: "2026-10-02T09:00:00.000Z",
      snapshot: {
        state: "merged",
        title: "Add it",
        headBranch: "feat",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: "2026-10-02T11:00:00.000Z",
        mergedAt: "2026-10-02T10:00:00Z",
      },
      stack: null,
    },
  ],
  createdAt: DateTime.makeUnsafe("2026-10-02T08:00:00.000Z"),
  updatedAt: at,
  archivedAt: null,
  settledOverride: "settled",
  settledAt: at,
  unsettledAt: DateTime.makeUnsafe("2026-10-02T09:30:00.000Z"),
  lastVisitedAt: null,
  deletedAt: null,
};

export const run: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: 2,
  providerInstanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message:telemetry"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "failed",
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  checkpointId: null,
  contextHandoffId: null,
};

const itemBase = {
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "failed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
} as const;

/** A Claude `Read`, which lands as a dynamic tool with the path in its input. */
export const readItem: Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }> = {
  ...itemBase,
  id: TurnItemId.make("item:read"),
  ordinal: 101,
  type: "dynamic_tool",
  toolName: "Read",
  input: { file_path: "src/a.ts" },
};

export const editItem: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("item:edit"),
  ordinal: 102,
  type: "file_change",
  fileName: "src/a.ts",
};

/** A timeline item that is not a tool call. */
export const noticeItem: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("item:notice"),
  ordinal: 103,
  type: "system_notice",
  message: "Compacted.",
};

export const usage: OrchestrationV2ProviderTurnTokenUsage = {
  usedTokens: 4100,
  inputTokens: 4000,
  cachedInputTokens: 3000,
  outputTokens: 100,
  reasoningOutputTokens: 20,
  updatedAt: "2026-10-12T00:00:00.000Z",
};

export const providerTurnId = ProviderTurnId.make("provider-turn:telemetry-1");

/** `provider-turn.updated` for one provider turn of the run, carrying `tokenUsage` when given. */
export const turnUpdated = (
  tokenUsage: OrchestrationV2ProviderTurnTokenUsage | undefined,
): Extract<OrchestrationV2DomainEvent, { readonly type: "provider-turn.updated" }> => ({
  id: nextEventId(),
  type: "provider-turn.updated",
  threadId,
  runId,
  providerInstanceId,
  occurredAt: at,
  payload: {
    id: providerTurnId,
    providerThreadId: ProviderThreadId.make("provider-thread:telemetry"),
    nodeId: NodeId.make("node:telemetry"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: at,
    completedAt: null,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  },
});

export const runEvent = (
  type: "run.created" | "run.updated",
  payload: OrchestrationV2Run = run,
): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type,
  threadId,
  runId,
  providerInstanceId,
  occurredAt: at,
  payload,
});

export const itemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type: "turn-item.updated",
  threadId,
  runId,
  providerInstanceId,
  occurredAt: at,
  payload,
});

export const threadEvent = (
  type:
    | "thread.created"
    | "thread.settled"
    | "thread.unsettled"
    | "thread.pinned"
    | "thread.pull-request-synced"
    | "thread.visited",
  payload: OrchestrationV2AppThread = thread,
  occurredAt: DateTime.Utc = at,
): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type,
  threadId,
  providerInstanceId,
  occurredAt,
  payload,
});

/** The command id `ThreadSettlementService` settles a thread under. */
export const sweepCommandId = CommandId.make(`server:auto-settle:${threadId}:1`);

export const correction: LearningCorrection = {
  id: 1,
  projectId,
  threadId,
  failureKind: "manual",
  causeClass: "unclassified",
  declaredMode: "defect",
  description: "Wrong file.",
  sourceEventIds: [],
  sourceKey: null,
  classifiedAt: null,
  classificationReason: null,
  createdAt: "2026-10-02T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
};

/** A reviewer's approval of the fixture thread. */
export const verdict: ReviewVerdict = {
  id: "thread%3Areviewer:checkpoint%3Atelemetry",
  projectId,
  reviewedThreadId: threadId,
  reviewerThreadId: ThreadId.make("thread:reviewer"),
  checkpointId: CheckpointId.make("checkpoint:telemetry"),
  outcome: "approve",
  failureMode: null,
  summary: "Looks right.",
  correctionId: null,
  createdAt: "2026-10-02T12:00:00.000Z",
  invalidatedAt: null,
};

/** A promotion delivered after its record was opened. */
export const promotion: LearningPromotion = {
  id: 1,
  itemId: 1,
  projectId,
  failureMode: "defect",
  ownerKind: "prompt",
  state: "delivered",
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
};

/** The handover `ItemStore.deliveredAt` lists for that promotion. */
export const delivery: ItemDelivery = {
  failureMode: promotion.failureMode,
  deliveredAt: promotion.updatedAt,
};
