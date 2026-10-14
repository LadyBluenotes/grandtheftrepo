import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as AttentionService from "./AttentionService.ts";
import * as SettleCapture from "./capture/SettleCapture.ts";
import * as DecisionSweep from "./DecisionSweep.ts";
import * as FindingService from "./findings/FindingService.ts";
import * as KanbanStore from "./KanbanStore.ts";
import * as Checks from "./readiness.ts";
import * as SpecReactor from "./spec/SpecReactor.ts";
import * as SpecService from "./spec/SpecService.ts";
import * as StopGate from "./StopGate.ts";
import * as WriterSweep from "./WriterSweep.ts";

/**
 * Status follows linked work, forward only: a thread starting moves its card to
 * In Progress, a finished turn to In Review, a merged pull request or settled
 * thread to Done. Cards in Triage or Inbox never move on their own. The writers
 * sweep watches for two agents writing the same project, the decisions sweep for conflicted
 * decisions.
 */
const start = Effect.gen(function* () {
  const store = yield* KanbanStore.KanbanStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const advance = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.created":
        return store.advance(event.payload.projectId, event.payload.id, "in_progress");
      case "thread.settled":
        return store.advance(event.payload.projectId, event.payload.id, "done");
      case "thread.pull-request-synced":
        return event.payload.pullRequests?.some((link) => link.snapshot?.state === "merged")
          ? store.advance(event.payload.projectId, event.payload.id, "done")
          : Effect.void;
      case "run.updated": {
        if (event.payload.status !== "completed") return Effect.void;
        const threadId = event.payload.threadId;
        // Loaded projects answer without a read; otherwise the shell names the project.
        return Effect.flatMap(store.linkedProject(threadId), (projectId) =>
          projectId !== undefined
            ? store.advance(projectId, threadId, "in_review")
            : Effect.flatMap(threads.getThreadShell(threadId), (shell) =>
                shell === null
                  ? Effect.void
                  : store.advance(shell.projectId, threadId, "in_review"),
              ),
        );
      }
      default:
        return Effect.void;
    }
  };

  // A second sweep under this plugin's own name is a defect, not a state the plugin can run in.
  yield* WriterSweep.register.pipe(Effect.orDie);
  yield* DecisionSweep.register.pipe(Effect.orDie);
  yield* forkParked(
    store.sweepArchive.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.asVoid),
  );
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      advance(event).pipe(
        Effect.catch((cause) => Effect.logWarning("kanban: automation step failed", { cause })),
      ),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban: automation stream failed", { cause }),
      ),
    ),
  );
});

/**
 * The store, the stop gate, the attention rows, spec drafting, findings, settle-time capture and
 * readiness plus the automation, for the plugin's layer.
 */
export const layer = Layer.mergeAll(
  Layer.effectDiscard(start),
  SpecReactor.layer,
  Checks.layer,
).pipe(
  Layer.provideMerge(SettleCapture.layer),
  Layer.provideMerge(Layer.merge(SpecService.layer, FindingService.layer)),
  Layer.provideMerge(Layer.mergeAll(KanbanStore.layer, StopGate.layer, AttentionService.layer)),
);
