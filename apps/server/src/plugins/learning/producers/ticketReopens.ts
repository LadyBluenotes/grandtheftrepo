import type {
  KanbanIssue,
  KanbanReopenReason,
  LearningDeclaredMode,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as CorrectionStore from "../CorrectionStore.ts";

/** What a reopen reason says went wrong: a defect is one, and a scope change means an unclear spec. */
const MODE_BY_REASON = {
  defect: "defect",
  scope_change: "unclear_spec",
} as const satisfies Record<KanbanReopenReason, LearningDeclaredMode>;

/**
 * A done kanban ticket reopened is one correction on the thread linked to it last, declaring the
 * mode its reason names, keyed by the project, the ticket and the time of the reopen. The kanban
 * store calls it once the reopen is saved, in the caller's fiber, which holds the learning plugin's
 * services while that plugin runs. With learning off or no thread linked nothing is recorded, and
 * a correction that cannot be recorded never fails the reopen.
 */
export const recordTicketReopen = Effect.fn("learning.recordTicketReopen")(function* (
  projectId: ProjectId,
  issue: KanbanIssue,
) {
  const corrections = yield* Effect.serviceOption(CorrectionStore.CorrectionStore);
  const thread = issue.threads.at(-1);
  if (Option.isNone(corrections) || thread === undefined || issue.reopened === null) return;
  const { reason, at } = issue.reopened;
  yield* corrections.value
    .record({
      threadId: thread.id,
      failureKind: "reopened_after_settlement",
      declaredMode: MODE_BY_REASON[reason],
      description: `Ticket ${issue.id} reopened from Done (${reason}): ${issue.title}`,
      sourceEventIds: [],
      sourceKey: `issue:${projectId}:${issue.id}:${at}`,
      occurredAt: DateTime.makeUnsafe(at),
    })
    .pipe(
      Effect.catchTags({
        LearningError: (cause) =>
          Effect.logWarning("learning: ticket reopen not recorded", {
            projectId,
            issueId: issue.id,
            cause,
          }),
      }),
    );
});
