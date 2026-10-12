import {
  POLICY_AGENTS,
  POLICY_ENVIRONMENT_PROJECT_ID,
  type PolicyAgent,
  type PolicyError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Files from "./InstructionFiles.ts";
import { needsDelivery } from "./needsDelivery.ts";
import * as PolicyService from "./PolicyService.ts";
import { sha256 } from "./Render.ts";

interface AcceptedRow {
  readonly project_id: ProjectId;
  readonly key: string;
  readonly version: number;
}

interface DeliveredRow {
  readonly agent: PolicyAgent;
  readonly version: number;
  readonly rulesHash: string;
  readonly verifiedAt: string | null;
}

/**
 * The supervisor sweep that makes policy delivery automatic. Every accepted policy that an
 * agent's instruction file does not carry current, because it was never installed, a newer
 * version was accepted, `RULES.md` changed, or the last install was not verified, is installed
 * and verified through `PolicyService`, but only at a session boundary: a project's policy waits
 * while any thread in the project has a run, and a `*` policy while any thread does. A waiting
 * policy leaves nothing behind and the next tick looks again. `examined` counts policy and
 * agent pairs, `acted` installs, `flags` deliveries a failed install or verification left
 * unverified. A dry run counts the installs it would make and writes nothing.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const policies = yield* PolicyService.PolicyService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const rulesPath = yield* Files.rulesPath();
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

  const warn = (step: string, filePath: string, error: PolicyError) =>
    Effect.logWarning(`policy delivery: ${step} failed`, {
      path: filePath,
      message: error.message,
    });

  const run = Effect.fn("DeliverySweep.run")(
    function* ({ dryRun }: { readonly dryRun: boolean }) {
      const rulesHash = sha256((yield* Files.read(rulesPath)) ?? "");
      const accepted = yield* sql<AcceptedRow>`
        SELECT project_id, "key", version FROM policies
        WHERE state = 'accepted' ORDER BY project_id, "key"
      `;
      let examined = 0;
      let acted = 0;
      let flags = 0;
      if (accepted.length === 0) return { examined, acted, flags };

      const targets = yield* Files.targets();
      const agents = yield* Effect.filter(POLICY_AGENTS, (agent) =>
        fs.exists(path.dirname(targets[agent])),
      );
      /** Projects found busy this tick; nothing installs for them until the next one. */
      const busy = new Set<ProjectId>();

      for (const { project_id: projectId, key, version } of accepted) {
        const delivered = new Map(
          (yield* sql<DeliveredRow>`
            SELECT agent, version, rules_hash AS rulesHash, verified_at AS verifiedAt
            FROM deliveries WHERE project_id = ${projectId} AND "key" = ${key}
          `).map((row) => [row.agent, row]),
        );
        for (const agent of agents) {
          examined += 1;
          if (!needsDelivery({ version, rulesHash, delivery: delivered.get(agent) })) continue;
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
          const installed = yield* policies.install(target).pipe(
            Effect.map(([result]) => (result?.status === "installed" ? "installed" : "skipped")),
            Effect.catchTags({
              PolicyError: (error) => Effect.as(warn("install", targets[agent], error), "failed"),
            }),
          );
          // Skipped means the directory went away since the check; the next tick looks again.
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

  return { plugin: "policy", name: "delivery", run };
});
