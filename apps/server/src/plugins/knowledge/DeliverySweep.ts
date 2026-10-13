import { KnowledgeError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";

/**
 * The supervisor sweep that keeps each project's pages and index blocks current. A project whose
 * recorded delivery differs from what its accepted pages render to, for an agent in use, is
 * installed through `KnowledgeStore`, but only at a session boundary: while any thread in the
 * project has a run, it waits, leaves nothing behind, and the next tick looks again. A hand edit
 * leaves the recorded delivery as it was, so the sweep never overwrites one; `verify` reports it
 * and an install repairs it. `examined` counts projects, `acted` installs, `flags` installs that
 * failed. A dry run counts the installs it would make and writes nothing.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* KnowledgeStore.KnowledgeStore;

  /**
   * Read fresh each time, from the host's thread service where the sweep runs. A run that is only
   * waiting has no `activeRunId` in the shell, so its `activityRunStatus` counts as well. Without
   * the service no boundary can be seen, so the project counts as busy.
   */
  const hasActiveRun = Effect.fn("KnowledgeDeliverySweep.hasActiveRun")(function* (
    projectId: ProjectId,
  ) {
    const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
    if (Option.isNone(threads)) return true;
    const shells = yield* threads.value.listProjectThreads({ projectId, includeSubagents: true });
    return shells.some(
      (thread) => thread.activeRunId !== null || thread.activityRunStatus === "waiting",
    );
  });

  /**
   * The check `install` repeats under its lock, right before it writes: a person's install can
   * hold the lock long enough for a run to start after the sweep first looked. Seeing one marks
   * the project busy, so the sweep reads the refusal as a wait and not as a failed install.
   */
  const refuseWhileRunning = (projectId: ProjectId, busy: Set<ProjectId>) =>
    hasActiveRun(projectId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("knowledge delivery: could not look for runs", { cause }).pipe(
          Effect.andThen(
            Effect.fail(new KnowledgeError({ code: "io", message: "Could not look for runs." })),
          ),
        ),
      ),
      Effect.flatMap((active) =>
        active
          ? Effect.sync(() => busy.add(projectId)).pipe(
              Effect.andThen(
                Effect.fail(
                  new KnowledgeError({
                    code: "invalid",
                    message: "A run started before the install.",
                  }),
                ),
              ),
            )
          : Effect.void,
      ),
    );

  const run = Effect.fn("KnowledgeDeliverySweep.run")(function* ({
    dryRun,
  }: {
    readonly dryRun: boolean;
  }) {
    // A project with nothing accepted still has blocks to take down while a delivery is recorded.
    const projects = yield* sql<{ readonly project_id: ProjectId }>`
      SELECT project_id FROM knowledge_entry WHERE state = 'accepted'
      UNION SELECT project_id FROM knowledge_delivery
      ORDER BY project_id
    `;
    let examined = 0;
    let acted = 0;
    let flags = 0;
    const busy = new Set<ProjectId>();
    for (const { project_id: projectId } of projects) {
      examined += 1;
      const outdated = yield* store.outdated(projectId).pipe(
        Effect.catchTags({
          // A project the server no longer knows has nothing to install into.
          KnowledgeError: (error) =>
            error.code === "not_found"
              ? Effect.succeed(false)
              : Effect.as(
                  Effect.logWarning("knowledge delivery: could not compare", {
                    projectId,
                    message: error.message,
                  }),
                  false,
                ),
        }),
      );
      if (!outdated) continue;
      const active = yield* hasActiveRun(projectId).pipe(
        Effect.catch((cause) =>
          Effect.as(
            Effect.logWarning("knowledge delivery: could not look for runs", { cause }),
            true,
          ),
        ),
      );
      if (active) continue;
      if (dryRun) {
        acted += 1;
        continue;
      }
      const installed = yield* store
        .install({ projectId }, refuseWhileRunning(projectId, busy))
        .pipe(
          Effect.as("installed" as const),
          Effect.catchTags({
            KnowledgeError: (error) =>
              busy.has(projectId)
                ? Effect.succeed("waiting" as const)
                : Effect.as(
                    Effect.logWarning("knowledge delivery: install failed", {
                      projectId,
                      message: error.message,
                    }),
                    "failed" as const,
                  ),
          }),
        );
      if (installed === "installed") acted += 1;
      if (installed === "failed") flags += 1;
    }
    return { examined, acted, flags };
  });

  return { plugin: "knowledge", name: "delivery", run };
});
