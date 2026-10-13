import {
  type ProjectId,
  type RoutingTier,
  type RoutingTiers,
  type TelemetryBudget,
  type TelemetryMeasure,
  type TelemetryMeasuresResult,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Attention from "../../Attention.ts";
import * as TierMapService from "../../routing/TierMapService.ts";
import { unmeasured } from "../measures/index.ts";
import {
  MAX_PER_CALL,
  TIER_INDEPENDENT_MEASURES,
  toolOutputFlagText,
} from "../measures/toolOutput.ts";
import type * as Telemetry from "../Telemetry.ts";
import * as BudgetStore from "./BudgetStore.ts";

const PLUGIN_ID = "telemetry";
const FLAG_KIND = "budget_breach";
const RESUME_ACTION = { label: "Open budgets", target: "settings" } as const;

/** A flag is per budget and project: a budget with no project is judged in each one apart. */
const flagKey = (budgetId: number, projectId: ProjectId) => `budget:${budgetId}:${projectId}`;

/** The project a budget flag's key names, or undefined when the key is not a budget flag's. */
export const budgetFlagProject = (key: string) => /^budget:\d+:(.+)$/.exec(key)?.[1];

const isBreach = (budget: TelemetryBudget, value: number) =>
  budget.direction === "lower_is_better" ? value > budget.threshold : value < budget.threshold;

/** Up to two decimals, so tokens per turn read as whole numbers. */
const show = (value: number) => String(Math.round(value * 100) / 100);

const flagText = (budget: TelemetryBudget, value: number, project: string) =>
  `${budget.measure} for the ${budget.tier} tier is ${show(value)} ${
    budget.direction === "lower_is_better" ? "over" : "under"
  } its budget of ${show(budget.threshold)} in ${project}.`;

/**
 * What a judgment of one budget in one project rests on, besides the project's rows: the window,
 * the budget's terms, and the model its tier resolves to.
 */
const terms = (windowFrom: string, budget: TelemetryBudget, tierModel: string) =>
  [
    windowFrom,
    budget.measure,
    budget.tier,
    tierModel,
    budget.threshold,
    budget.direction,
    budget.minSample,
  ].join(" ");

/**
 * Builds the budgets sweep. For each enabled budget and each project it judges, it asks
 * `measures` for the last seven whole UTC days on the budget's tier. A window that is
 * `unavailable`, or has fewer samples than the budget's minimum, is not judged. The budget's state
 * in a project is its newest event there: a breach on the wrong side of the threshold appends one
 * `breach` event and raises one `budget_breach` flag, and a value back inside while in breach
 * appends one `recovery` and clears the flag; anything else writes nothing. An event is written
 * only while the budget still has the terms it was judged on, so one removed or edited during the
 * measuring gets none. A breach whose flag is not open, as after a budget is enabled again, raises
 * it again without an event, and the flag of a budget that was removed or disabled, or of a
 * project that is gone, is cleared.
 *
 * A measure that reads no tier is asked for without one, so its budget judges every run whatever
 * tier the budget names, routing plugin on or off.
 *
 * The window's rows are all in the past, so a budget is measured in a project once per window,
 * set of terms and model its tier resolves to; one whose measures could not be read, or were not
 * measured yet, as while telemetry replays the event log or the routing plugin is off, is asked
 * again on the next tick. A dry run counts, writes nothing and remembers nothing.
 */
export const sweep = (measures: Telemetry.Telemetry["Service"]["measures"]) =>
  Effect.gen(function* () {
    const store = yield* BudgetStore.BudgetStore;
    const attention = yield* Attention.Attention;
    const projects = yield* ProjectService.ProjectService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    /** A thread's title for a flag, or its id when the thread cannot be read. */
    const threadTitle = (threadId: string) =>
      threads.getThreadShell(ThreadId.make(threadId)).pipe(
        Effect.map((shell) => shell?.title ?? threadId),
        Effect.orElseSucceed(() => threadId),
      );

    /**
     * What a breach's flag says. A budget on the largest tool result names that result's tool and
     * thread, with a hint for the tool; any other says how far over its threshold the value is.
     */
    const breachText = (
      budget: TelemetryBudget,
      measure: TelemetryMeasure,
      value: number,
      project: string,
    ) =>
      Effect.gen(function* () {
        const largest = measure.detail?.largest?.[0];
        return budget.measure === MAX_PER_CALL && largest !== undefined
          ? toolOutputFlagText(largest, yield* threadTitle(largest.threadId))
          : flagText(budget, value, project);
      });

    /** Each budget and project's flag key to the terms it was last judged on. */
    const judged = new Map<string, string>();

    const run = ({ dryRun }: { readonly dryRun: boolean }) =>
      Effect.gen(function* () {
        const to = DateTime.startOf(yield* DateTime.now, "day");
        const window = {
          from: DateTime.formatIso(DateTime.subtract(to, { days: 7 })),
          to: DateTime.formatIso(to),
        };
        const budgets = (yield* store.list({})).filter((budget) => budget.enabled);
        const shells = yield* projects.listShells();
        const titles = new Map(shells.map((shell) => [shell.id, shell.title]));
        const open = new Set(
          (yield* attention.listOpen({ pluginId: PLUGIN_ID, kind: FLAG_KIND })).map(
            (flag) => flag.threadId,
          ),
        );

        // Read where the sweep runs: the routing plugin is a sibling, absent while it is off.
        const tierMap = yield* Effect.serviceOption(TierMapService.TierMapService);
        const tiersByProject = new Map<ProjectId, RoutingTiers | undefined>();
        /** What the tier resolves to in the project now, for the memo; the measures read it too. */
        const tierModel = (projectId: ProjectId, tier: RoutingTier) =>
          Effect.gen(function* () {
            if (Option.isNone(tierMap)) return "routing off";
            if (!tiersByProject.has(projectId)) {
              const read = yield* Effect.result(tierMap.value.get({ projectId }));
              tiersByProject.set(projectId, Result.isSuccess(read) ? read.success : undefined);
            }
            const resolved = tiersByProject.get(projectId)?.[tier].resolved;
            // Unread tiers fail the measures as well, so this never reaches the memo.
            if (resolved === undefined) return "unread";
            return resolved === null
              ? "no model"
              : `${resolved.providerInstanceId}/${resolved.model}`;
          });

        // One request per project and tier, shared by every budget on that tier. Without a tier
        // every run counts, for the measures that read none.
        const results = new Map<string, TelemetryMeasuresResult | undefined>();
        const measured = (projectId: ProjectId, tier: RoutingTier | undefined) =>
          Effect.gen(function* () {
            const key = `${projectId}\n${tier ?? ""}`;
            if (results.has(key)) return results.get(key);
            const answer = yield* Effect.result(
              measures({ projectId, ...window, ...(tier === undefined ? {} : { tier }) }),
            );
            if (Result.isFailure(answer)) {
              yield* Effect.logWarning("telemetry: budget measures could not be read", {
                projectId,
                tier,
                cause: answer.failure,
              });
            }
            const result =
              Result.isSuccess(answer) && !unmeasured(answer.success) ? answer.success : undefined;
            results.set(key, result);
            return result;
          });

        const covered = new Set<string>();
        let examined = 0;
        let acted = 0;
        let flags = 0;
        for (const budget of budgets) {
          // A project the server no longer lists is not judged, and its flag clears below.
          const projectIds =
            budget.projectId === null
              ? shells.map((shell) => shell.id)
              : titles.has(budget.projectId)
                ? [budget.projectId]
                : [];
          for (const projectId of projectIds) {
            const threadId = flagKey(budget.id, projectId);
            covered.add(threadId);
            // A measure that reads no tier counts every run, so no tier's model decides its terms.
            const tier = TIER_INDEPENDENT_MEASURES.has(budget.measure) ? undefined : budget.tier;
            const stamp = terms(
              window.from,
              budget,
              tier === undefined ? "every run" : yield* tierModel(projectId, tier),
            );
            if (judged.get(threadId) === stamp) continue;
            const result = yield* measured(projectId, tier);
            if (result === undefined) continue;
            const measure = result.find((candidate) => candidate.measure === budget.measure);
            const value = measure?.value ?? null;
            if (measure !== undefined && value !== null && measure.sampleSize >= budget.minSample) {
              examined += 1;
              const breached = isBreach(budget, value);
              const inBreach = budget.latest.some(
                (event) => event.projectId === projectId && event.kind === "breach",
              );
              const flag = { pluginId: PLUGIN_ID, threadId, kind: FLAG_KIND } as const;
              const event = {
                projectId,
                windowFrom: window.from,
                windowTo: window.to,
                value,
                sampleSize: measure.sampleSize,
              };
              if (breached && (!inBreach || !open.has(threadId))) {
                // The flag follows the event: a budget changed meanwhile gets neither.
                const recorded =
                  dryRun || inBreach || (yield* store.record(budget, { ...event, kind: "breach" }));
                if (recorded) {
                  acted += 1;
                  flags += 1;
                  if (!dryRun) {
                    yield* attention.raise({
                      ...flag,
                      text: yield* breachText(
                        budget,
                        measure,
                        value,
                        titles.get(projectId) ?? projectId,
                      ),
                      resumeAction: RESUME_ACTION,
                    });
                  }
                }
              } else if (!breached && inBreach) {
                const recorded =
                  dryRun || (yield* store.record(budget, { ...event, kind: "recovery" }));
                if (recorded) {
                  acted += 1;
                  if (!dryRun) yield* attention.clear(flag);
                }
              } else if (!breached && open.has(threadId)) {
                // A recovery whose flag failed to clear after it was written.
                acted += 1;
                if (!dryRun) yield* attention.clear(flag);
              }
            }
            // Only once its writes are done: a failed one leaves the pair to the next tick.
            if (!dryRun) judged.set(threadId, stamp);
          }
        }
        const stale = [...open].filter((threadId) => !covered.has(threadId));
        acted += stale.length;
        if (!dryRun) {
          // A budget disabled and enabled again is judged afresh, which raises its flag again.
          for (const threadId of judged.keys()) if (!covered.has(threadId)) judged.delete(threadId);
          for (const threadId of stale) {
            yield* attention.clear({ pluginId: PLUGIN_ID, threadId, kind: FLAG_KIND });
          }
        }
        return { examined, acted, flags };
      });

    return { plugin: PLUGIN_ID, name: "budgets", run };
  });
