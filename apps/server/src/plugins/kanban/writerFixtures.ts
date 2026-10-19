/** Thread shells for the tests that drive the writers sweep through the read model. */
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const projectA = ProjectId.make("project:a");
export const projectB = ProjectId.make("project:b");
const epoch = Date.parse("2026-10-12T00:00:00.000Z");
const at = (seconds: number) => DateTime.makeUnsafe(epoch + seconds * 1000);

/** A thread with a run that began `startedSeconds` after the epoch; `status` is that run's. */
export const thread = (
  id: string,
  options: {
    readonly projectId?: ProjectId;
    readonly startedSeconds?: number;
    readonly mode?: "default" | "plan";
    readonly status?: OrchestrationV2RunStatus | "idle";
    readonly nativeSubagent?: boolean;
  } = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  const status = options.status ?? "running";
  const active = status === "preparing" || status === "starting" || status === "running";
  const live = active || status === "waiting";
  const startedAt = at(options.startedSeconds ?? 0);
  return {
    id: threadId,
    projectId: options.projectId ?? projectA,
    title: `Thread ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: options.mode ?? "default",
    createdBy: "user",
    creationSource: options.nativeSubagent === true ? "provider" : "web",
    branch: null,
    worktreePath: null,
    lineage: {
      rootThreadId: threadId,
      parentThreadId: null,
      relationshipToParent: options.nativeSubagent === true ? "subagent" : null,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: RunId.make(`run:${id}`),
    latestRunRequestedAt: startedAt,
    activeRunId: active ? RunId.make(`run:${id}`) : null,
    activityRunStatus: live ? status : null,
    activityRunStartedAt: live ? startedAt : null,
    status,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: startedAt,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: startedAt,
    updatedAt: startedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    pinnedAt: null,
    deletedAt: null,
  };
};
