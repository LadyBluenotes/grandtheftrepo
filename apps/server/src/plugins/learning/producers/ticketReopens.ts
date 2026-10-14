import type {
  KanbanIssue,
  KanbanReopenReason,
  LearningDeclaredMode,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
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
 * services while that plugin runs. A ticket can link any thread id, so the core's thread shell
 * must place the thread in the ticket's project; only then may the learning plugin learn the
 * thread from the ticket before its own replay reaches it. With learning off, no thread linked, or
 * a thread the core does not place in the project, nothing is recorded, and a correction that
 * cannot be recorded never fails the reopen.
 */
export const recordTicketReopen = Effect.fn("learning.recordTicketReopen")(function* (
  projectId: ProjectId,
  issue: KanbanIssue,
) {
  const corrections = yield* Effect.serviceOption(CorrectionStore.CorrectionStore);
  const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
  const thread = issue.threads.at(-1);
  if (
    Option.isNone(corrections) ||
    Option.isNone(threads) ||
    thread === undefined ||
    issue.reopened === null
  )
    return;
  const shell = yield* threads.value.getThreadShell(thread.id).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("learning: ticket reopen not recorded, thread unreadable", {
        projectId,
        issueId: issue.id,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  );
  if (shell === undefined) return;
  if (shell?.projectId !== projectId) {
    return yield* Effect.logWarning("learning: ticket reopen not recorded, thread not in project", {
      projectId,
      issueId: issue.id,
      threadId: thread.id,
    });
  }
  const { reason, at } = issue.reopened;
  yield* corrections.value
    .recordForProject({
      projectId,
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
