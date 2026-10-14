import type { KanbanIssue, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as Attention from "../../Attention.ts";
import * as PluginSupervisor from "../../PluginSupervisor.ts";
import * as KanbanStore from "../KanbanStore.ts";

const PLUGIN_ID = "kanban";
const FLAG_KIND = "unowned_finding";
const RESUME_ACTION = { label: "Open board", target: "board" } as const;

/** How many days a Triage finding may go without an owner before it is flagged. */
const UNOWNED_AFTER_DAYS = 3;

/** One flag per project, keyed so the strip and the weekly report find it (`attentionKeys.ts`). */
const flagKey = (projectId: ProjectId) => `findings:${projectId}`;

const flagText = (count: number) =>
  count === 1
    ? `1 finding in Triage has had no owner for over ${UNOWNED_AFTER_DAYS} days; review it to take it on.`
    : `${count} findings in Triage have had no owner for over ${UNOWNED_AFTER_DAYS} days; review each to take it on.`;

/**
 * The findings on the project's unarchived Triage cards, and how many of them nobody has reviewed
 * though they were captured at or before `cutoff`, in epoch milliseconds. A finding's reviewer owns
 * it, so one with no review has no owner and any review takes it on. A capture time that is not an
 * instant, as a hand edit can leave, is never old enough.
 */
const countUnowned = (issues: ReadonlyArray<KanbanIssue>, cutoff: number) => {
  const findings = issues
    .filter((issue) => issue.status === "triage" && issue.archivedAt === null)
    .flatMap((issue) => issue.findings);
  const unowned = findings.filter(
    (finding) =>
      finding.review === null &&
      Option.match(DateTime.make(finding.proposedAt), {
        onNone: () => false,
        onSome: (at) => DateTime.toEpochMillis(at) <= cutoff,
      }),
  );
  return { examined: findings.length, unowned: unowned.length };
};

/**
 * Builds the findings sweep. Per project it counts the Triage findings nobody has owned for
 * `UNOWNED_AFTER_DAYS` and keeps one `unowned_finding` flag with the count, so ten such findings
 * are one row on the strip. The flag is cleared once none is left, its text follows the count, and
 * a tick that finds what the last one found writes nothing. A project with no board folder has no
 * findings and gets no folder; one whose board cannot be read keeps the flag it had, and a project
 * that is gone loses it. It never reviews or moves a finding. A dry run counts and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const store = yield* KanbanStore.KanbanStore;
  const projects = yield* ProjectService.ProjectService;
  const attention = yield* Attention.Attention;

  return Effect.fn("UnownedSweep.run")(function* (input: { readonly dryRun: boolean }) {
    const now = yield* DateTime.now;
    const cutoff = DateTime.toEpochMillis(DateTime.subtract(now, { days: UNOWNED_AFTER_DAYS }));
    const judged = new Map<string, string | undefined>();
    const unread = new Set<string>();
    let examined = 0;
    for (const project of yield* projects.listShells()) {
      const key = flagKey(project.id);
      const issues = yield* Effect.result(store.issues(project.id));
      if (Result.isFailure(issues)) {
        yield* Effect.logWarning("kanban: findings could not be read", {
          projectId: project.id,
          cause: issues.failure,
        });
        unread.add(key);
        continue;
      }
      const counted = countUnowned(issues.success, cutoff);
      examined += counted.examined;
      judged.set(key, counted.unowned === 0 ? undefined : flagText(counted.unowned));
    }
    const { changes, standing } = yield* Attention.reconcile(attention, {
      pluginId: PLUGIN_ID,
      kind: FLAG_KIND,
      resumeAction: RESUME_ACTION,
      dryRun: input.dryRun,
      judged,
      leave: (key) => unread.has(key),
    });
    return { examined, acted: input.dryRun ? 0 : changes, flags: standing };
  });
});

/** Registers the sweep with the supervisor; called from the plugin's layer. */
export const register = Effect.gen(function* () {
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  const run = yield* sweep;
  yield* supervisor.register({ plugin: PLUGIN_ID, name: "findings", run });
});
