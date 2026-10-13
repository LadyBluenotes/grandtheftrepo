import { KnowledgeError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Attention from "../Attention.ts";
import * as DeliveryDrift from "../DeliveryDrift.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";

/**
 * The supervisor sweep that keeps each project's pages and index blocks current. It catches up
 * through `KnowledgeStore.catchUp`, writing only the page files and blocks whose recorded delivery
 * is stale, and only at a session boundary: while any thread in the project has a run, it waits,
 * leaves nothing behind, and the next tick looks again. A file that no longer holds what was
 * delivered was edited by hand and is never written by the sweep; `verify` reports it and a
 * person's install repairs it.
 *
 * After the catch-ups it checks every page file and index block an install recorded, and keeps one
 * `delivery_drift` flag, `knowledge:<project>:<delivery>:<path>`, for each that was edited or
 * deleted since, at any time and with or without a run. A person's install puts the accepted
 * pages back, after which the next tick clears the flag. Like a catch-up it never writes one.
 *
 * `examined` counts projects, `acted` catch-ups and flags raised, rewritten or cleared, `flags`
 * catch-ups that failed plus the drift flags standing. A dry run counts what it would do and
 * changes nothing.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* KnowledgeStore.KnowledgeStore;
  const attention = yield* Attention.Attention;

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
   * The check `catchUp` repeats under its lock, right before it writes: a person's install can
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

  /** A project with nothing accepted still has blocks to take down while a delivery is recorded. */
  const projectsToTend = sql<{ readonly project_id: ProjectId }>`
    SELECT project_id FROM knowledge_entry WHERE state = 'accepted'
    UNION SELECT project_id FROM knowledge_delivery
    ORDER BY project_id
  `;

  const catchUpDue = Effect.fn("KnowledgeDeliverySweep.catchUp")(function* ({
    dryRun,
  }: {
    readonly dryRun: boolean;
  }) {
    const projects = yield* projectsToTend;
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
              ? Effect.succeed(false as const)
              : Effect.as(
                  Effect.logWarning("knowledge delivery: could not compare", {
                    projectId,
                    message: error.message,
                  }),
                  "failed" as const,
                ),
        }),
      );
      // Files the sweep cannot read are flagged like files it cannot write.
      if (outdated === "failed") flags += 1;
      if (outdated !== true) continue;
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
      const installed = yield* store.catchUp(projectId, refuseWhileRunning(projectId, busy)).pipe(
        Effect.map((wrote) => (wrote ? ("installed" as const) : ("unchanged" as const))),
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

  /**
   * One flag per recorded page file and agent index block, keyed
   * `knowledge:<project>:<delivery>:<path>`, with the delivery as the store names it (`page:<key>`,
   * or the agent). A project the server no longer knows has nothing to judge, so its flags clear;
   * one whose files could not be read keeps the flags it had.
   */
  const flagDrift = Effect.fn("KnowledgeDeliverySweep.flagDrift")(function* ({
    dryRun,
  }: {
    readonly dryRun: boolean;
  }) {
    const judged = new Map<string, string | undefined>();
    const unread: Array<string> = [];
    for (const { project_id: projectId } of yield* projectsToTend) {
      const prefix = `knowledge:${projectId}:`;
      const targets = yield* store.drift(projectId).pipe(
        Effect.catchTags({
          KnowledgeError: (error) =>
            error.code === "not_found"
              ? Effect.succeed([])
              : Effect.as(
                  Effect.logWarning("knowledge delivery: could not check for edits", {
                    projectId,
                    message: error.message,
                  }),
                  undefined,
                ),
        }),
      );
      if (targets === undefined) {
        unread.push(prefix);
        continue;
      }
      for (const target of targets) {
        judged.set(
          `${prefix}${target.id}:${target.path}`,
          target.status === "ok"
            ? undefined
            : DeliveryDrift.flagText({
                what:
                  target.page === undefined
                    ? "The knowledge index"
                    : `The knowledge page "${target.page}"`,
                path: target.path,
                change: target.status,
              }),
        );
      }
    }
    return yield* DeliveryDrift.reconcile(attention, {
      pluginId: "knowledge",
      dryRun,
      judged,
      leave: (flag) => unread.some((prefix) => flag.startsWith(prefix)),
    });
  });

  const run = Effect.fn("KnowledgeDeliverySweep.run")(function* (input: {
    readonly dryRun: boolean;
  }) {
    const catchUps = yield* catchUpDue(input);
    const drift = yield* flagDrift(input);
    return {
      examined: catchUps.examined,
      acted: catchUps.acted + drift.changes,
      flags: catchUps.flags + drift.standing,
    };
  });

  return { plugin: "knowledge", name: "delivery", run };
});
