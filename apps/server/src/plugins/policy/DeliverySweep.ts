import {
  POLICY_AGENTS,
  POLICY_ENVIRONMENT_PROJECT_ID,
  PolicyError,
  type PolicyAgent,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Attention from "../Attention.ts";
import * as DeliveryDrift from "../DeliveryDrift.ts";
import * as Blocks from "../InstructionBlocks.ts";
import * as Files from "./InstructionFiles.ts";
import { needsDelivery } from "./needsDelivery.ts";
import * as PolicyService from "./PolicyService.ts";
import { blockId, policyMarkers } from "./Render.ts";

interface AcceptedRow {
  readonly project_id: ProjectId;
  readonly key: string;
  readonly version: number;
}

interface DeliveredRow {
  readonly agent: PolicyAgent;
  readonly version: number;
  readonly rulesHash: string;
  readonly targetPath: string;
  readonly verifiedAt: string | null;
}

interface RecordedRow {
  readonly project_id: ProjectId;
  readonly key: string;
  readonly agent: PolicyAgent;
  readonly targetPath: string;
  readonly renderedHash: string;
}

/**
 * The supervisor sweep that makes policy delivery automatic. Every accepted policy that an
 * agent's instruction file does not carry current, because it was never installed, a newer
 * version was accepted, `RULES.md` changed, the agent's file moved, or the last install was not
 * verified, is installed and verified through `PolicyService`, but only at a session boundary: a
 * project's policy waits while any thread in the project has a run, and a `*` policy while any
 * thread does. A waiting policy leaves nothing behind and the next tick looks again.
 *
 * After the installs it checks every delivery it recorded and keeps one `delivery_drift` flag per
 * project and agent file whose block was edited or deleted since. It never writes such a block: a
 * person may have edited it on purpose, and an install from the Policies screen or `policy.install`
 * puts the accepted version back, after which the next tick clears the flag.
 *
 * `examined` counts policy and agent pairs, `acted` installs and flags raised, rewritten or
 * cleared, `flags` deliveries a failed install or verification left unverified plus the drift
 * flags standing. A dry run counts what it would do and changes nothing.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const policies = yield* PolicyService.PolicyService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const rulesPath = yield* Files.rulesPath();
  const attention = yield* Attention.Attention;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ServerSettings.ServerSettingsService
  >();

  /**
   * Read fresh each time it is asked. A run that is only waiting has no `activeRunId` in the
   * shell, so its `activityRunStatus` counts as well.
   */
  const hasActiveRun = Effect.fn("DeliverySweep.hasActiveRun")(function* (projectId: ProjectId) {
    const shells =
      projectId === POLICY_ENVIRONMENT_PROJECT_ID
        ? (yield* threads.getShellSnapshot({ location: "active" })).threads
        : yield* threads.listProjectThreads({ projectId, includeSubagents: true });
    return shells.some(
      (thread) => thread.activeRunId !== null || thread.activityRunStatus === "waiting",
    );
  });

  /**
   * The check `install` repeats under its lock, right before it writes: a manual install can hold
   * the lock long enough for a run to start after the sweep first looked. Seeing one marks the
   * project busy, so the sweep reads the refusal as a wait and not as a failed install.
   */
  const refuseWhileRunning = (projectId: ProjectId, busy: Set<ProjectId>) =>
    hasActiveRun(projectId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("policy delivery: could not look for runs", { cause }).pipe(
          Effect.andThen(
            Effect.fail(new PolicyError({ code: "io", message: "Could not look for runs." })),
          ),
        ),
      ),
      Effect.flatMap((active) =>
        active
          ? Effect.sync(() => busy.add(projectId)).pipe(
              Effect.andThen(
                Effect.fail(
                  new PolicyError({
                    code: "invalid",
                    message: "A run started before the install.",
                  }),
                ),
              ),
            )
          : Effect.void,
      ),
    );

  const warn = (step: string, filePath: string, error: PolicyError) =>
    Effect.logWarning(`policy delivery: ${step} failed`, {
      path: filePath,
      message: error.message,
    });

  const installDue = Effect.fn("DeliverySweep.install")(
    function* ({ dryRun }: { readonly dryRun: boolean }) {
      const rulesHash = Blocks.sha256((yield* Blocks.read(rulesPath)) ?? "");
      const accepted = yield* sql<AcceptedRow>`
        SELECT project_id, "key", version FROM policies
        WHERE state = 'accepted' ORDER BY project_id, "key"
      `;
      let examined = 0;
      let acted = 0;
      let flags = 0;
      if (accepted.length === 0) return { examined, acted, flags };

      const targets = yield* Blocks.targets();
      const agents = yield* Effect.filter(POLICY_AGENTS, (agent) =>
        fs.exists(path.dirname(targets[agent])),
      );
      /** Projects found busy this tick; nothing installs for them until the next one. */
      const busy = new Set<ProjectId>();

      for (const { project_id: projectId, key, version } of accepted) {
        const delivered = new Map(
          (yield* sql<DeliveredRow>`
            SELECT agent, version, rules_hash AS rulesHash, target_path AS targetPath,
              verified_at AS verifiedAt
            FROM deliveries WHERE project_id = ${projectId} AND "key" = ${key}
          `).map((row) => [row.agent, row]),
        );
        for (const agent of agents) {
          examined += 1;
          const targetPath = targets[agent];
          if (!needsDelivery({ version, rulesHash, targetPath, delivery: delivered.get(agent) })) {
            continue;
          }
          if (busy.has(projectId)) continue;
          if (yield* hasActiveRun(projectId)) {
            busy.add(projectId);
            continue;
          }
          if (dryRun) {
            acted += 1;
            continue;
          }

          const target = { projectId, key, agents: [agent] };
          // One agent at a time, so a file that cannot be written does not hold back the others.
          const installed = yield* policies
            .install(target, refuseWhileRunning(projectId, busy))
            .pipe(
              Effect.map(([result]) => (result?.status === "installed" ? "installed" : "skipped")),
              Effect.catchTags({
                PolicyError: (error) =>
                  busy.has(projectId)
                    ? Effect.succeed("skipped")
                    : Effect.as(warn("install", targetPath, error), "failed"),
              }),
            );
          // Skipped means the directory went away since the check or a run started while the
          // install waited for its lock; the next tick looks again.
          if (installed === "skipped") continue;
          if (installed === "failed") {
            flags += 1;
            continue;
          }
          acted += 1;
          const verified = yield* policies.verify(target).pipe(
            Effect.flatMap(([result]) =>
              result?.status === "ok"
                ? Effect.succeed(true)
                : Effect.as(
                    Effect.logWarning("policy delivery: the installed block is not there", {
                      path: targets[agent],
                      status: result?.status,
                    }),
                    false,
                  ),
            ),
            Effect.catchTags({
              PolicyError: (error) => Effect.as(warn("verify", targets[agent], error), false),
            }),
          );
          if (!verified) flags += 1;
        }
      }
      return { examined, acted, flags };
    },
    (effect) => Effect.provideContext(effect, services),
  );

  /**
   * One flag per project, agent and file, `policy:<projectId>:<agent>:<path>`, for the project's
   * policies delivered into it: a file holds every policy's block, so the flag names those of the
   * project that changed. The project is second in the key so the project's board can list it
   * (`kanban/attentionRows.ts`), which lists a `policy:*:` flag of the whole environment on every
   * board. Each file is read once. A block is judged against the hash its install recorded, not the
   * version accepted now, so a block that is merely waiting for a run to end is intact, and one
   * that was edited, or whose file or markers are gone, is not. A file that cannot be read keeps
   * the flag it had. The read
   * takes no install lock, so a person's install landing mid-read can show one block ahead of its
   * record for a tick; the next tick settles the flag either way.
   */
  const flagDrift = Effect.fn("DeliverySweep.flagDrift")(
    function* ({ dryRun }: { readonly dryRun: boolean }) {
      const recorded = yield* sql<RecordedRow>`
        SELECT project_id, "key", agent, target_path AS targetPath, rendered_hash AS renderedHash
        FROM deliveries ORDER BY project_id, "key", agent
      `;
      const judged = new Map<string, string | undefined>();
      const unread = new Set<string>();
      /** What each file read, so a file several projects have blocks in is read once. */
      const files = new Map<string, Result.Result<string | undefined, unknown>>();
      for (const [flag, rows] of Map.groupBy(
        recorded,
        (row) => `policy:${row.project_id}:${row.agent}:${row.targetPath}`,
      )) {
        const [first] = rows;
        if (first === undefined) continue;
        let read = files.get(first.targetPath);
        if (read === undefined) {
          read = yield* Effect.result(Blocks.read(first.targetPath));
          files.set(first.targetPath, read);
          if (Result.isFailure(read)) {
            yield* Effect.logWarning("policy delivery: could not read an instruction file", {
              path: first.targetPath,
              cause: read.failure,
            });
          }
        }
        if (Result.isFailure(read)) {
          unread.add(flag);
          continue;
        }
        const text = read.success;
        const changed = rows.flatMap((row) => {
          const id = blockId(row.project_id, row.key);
          const found =
            text === undefined
              ? ({ kind: "absent" } satisfies Blocks.FoundBlock)
              : Blocks.findBlock(text, policyMarkers(id));
          if (found.kind === "found" && found.hash === row.renderedHash) return [];
          return [
            { id, change: found.kind === "absent" ? ("removed" as const) : ("edited" as const) },
          ];
        });
        const ids = changed.map((block) => block.id);
        judged.set(
          flag,
          changed.length === 0
            ? undefined
            : DeliveryDrift.flagText({
                what: `The ${DeliveryDrift.quoted(ids)} policy block${ids.length > 1 ? "s" : ""}`,
                path: first.targetPath,
                change: changed.every((block) => block.change === "removed")
                  ? "removed"
                  : changed.every((block) => block.change === "edited")
                    ? "edited"
                    : "edited or removed",
                plural: ids.length > 1,
              }),
        );
      }
      return yield* DeliveryDrift.reconcile(attention, {
        pluginId: "policy",
        dryRun,
        judged,
        leave: (flag) => unread.has(flag),
      });
    },
    (effect) => Effect.provideContext(effect, services),
  );

  const run = Effect.fn("DeliverySweep.run")(function* (input: { readonly dryRun: boolean }) {
    const installs = yield* installDue(input);
    const drift = yield* flagDrift(input);
    return {
      examined: installs.examined,
      acted: installs.acted + drift.changes,
      flags: installs.flags + drift.standing,
    };
  });

  return { plugin: "policy", name: "delivery", run };
});
