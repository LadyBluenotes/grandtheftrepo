import type { ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as Attention from "../../Attention.ts";
import { unmeasured } from "../../telemetry/measures/index.ts";
import { extractionCandidatesOf } from "../../telemetry/measures/repeatedWork.ts";
import * as Telemetry from "../../telemetry/Telemetry.ts";
import * as ProposalStore from "./ProposalStore.ts";

const PLUGIN_ID = "learning";
const KIND = "deterministic_proposals";

/** One flag per project, keyed so the board's strip and the weekly report place it there. */
const flagKey = (projectId: ProjectId) => `deterministic:${projectId}`;

const flagText = (count: number) =>
  count === 1
    ? "1 proposal to do repeated work without a model waits for review."
    : `${count} proposals to do repeated work without a model wait for review.`;

/**
 * The weekly review of repeated work. Once per project and week, from the first tick after Monday
 * 00:00 UTC, it reads the project's extraction candidates over the seven days before and records
 * up to five proposals, as `ProposalStore.propose` chooses them. A project is reviewed again on the
 * next tick when its measures cannot be read, or are unavailable in every measure, as telemetry
 * answers while it replays the event log; while telemetry is off no week is reviewed. Each tick
 * then saves a draft for every waiting proposal whose target is back, and keeps one
 * `deterministic_proposals` flag per project with undecided proposals, opening the Learning
 * screen's Deterministic tab on it, cleared once none is left. It never calls a model. `examined`
 * counts the projects reviewed and the proposals waiting for a draft, `acted` the proposals
 * recorded, the drafts saved and the flags raised, rewritten or cleared, `flags` the flags standing
 * after the tick. A dry run counts and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ProposalStore.ProposalStore;
  const projects = yield* ProjectService.ProjectService;
  const attention = yield* Attention.Attention;

  const run = ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
      const to = DateTime.startOf(yield* DateTime.now, "week", { weekStartsOn: 1 });
      const windowFrom = DateTime.formatIso(DateTime.subtract(to, { days: 7 }));
      const window = { from: windowFrom, to: DateTime.formatIso(to) };
      const shells = yield* projects.listShells();
      let examined = 0;
      let acted = 0;

      const telemetry = yield* Effect.serviceOption(Telemetry.Telemetry);
      if (Option.isSome(telemetry)) {
        const reviewed = new Set(
          (yield* sql<{ readonly project_id: ProjectId }>`SELECT project_id
            FROM deterministic_runs WHERE window_from = ${windowFrom}`).map(
            (row) => row.project_id,
          ),
        );
        for (const { id: projectId } of shells) {
          if (reviewed.has(projectId)) continue;
          const measured = yield* Effect.result(telemetry.value.measures({ projectId, ...window }));
          if (Result.isFailure(measured)) {
            yield* Effect.logWarning("learning: extraction candidates could not be read", {
              projectId,
              cause: measured.failure,
            });
            continue;
          }
          if (unmeasured(measured.success)) continue;
          examined += 1;
          const { candidates } = extractionCandidatesOf(measured.success);
          acted += yield* store.propose({ projectId, windowFrom, candidates, dryRun });
          if (dryRun) continue;
          const ranAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`INSERT INTO deterministic_runs (project_id, window_from, ran_at)
            VALUES (${projectId}, ${windowFrom}, ${ranAt})
            ON CONFLICT (window_from, project_id) DO NOTHING`;
        }
      }

      const drafts = yield* store.draftWaiting({
        projectIds: new Set(shells.map((shell) => shell.id)),
        dryRun,
      });
      examined += drafts.waiting;
      acted += drafts.drafted;

      const undecided = yield* store.undecided;
      const open = new Map(
        (yield* attention.listOpen({ pluginId: PLUGIN_ID, kind: KIND })).map((flag) => [
          flag.threadId,
          flag.text,
        ]),
      );
      let flags = 0;
      for (const { id: projectId } of shells) {
        const count = undecided.get(projectId) ?? 0;
        if (count === 0) continue;
        flags += 1;
        const key = flagKey(projectId);
        const text = flagText(count);
        const standing = open.get(key);
        open.delete(key);
        if (standing === text) continue;
        acted += 1;
        if (dryRun) continue;
        yield* attention.raise({
          pluginId: PLUGIN_ID,
          threadId: key,
          kind: KIND,
          text,
          resumeAction: {
            label: "Review",
            target: "plugin",
            pluginId: PLUGIN_ID,
            tab: "deterministic",
            recordId: projectId,
          },
        });
      }
      // What is left names a project with nothing undecided, or one that is gone.
      for (const key of open.keys()) {
        acted += 1;
        if (!dryRun) yield* attention.clear({ pluginId: PLUGIN_ID, threadId: key, kind: KIND });
      }
      return { examined, acted, flags };
    });

  return { plugin: PLUGIN_ID, name: "deterministic", run };
});
