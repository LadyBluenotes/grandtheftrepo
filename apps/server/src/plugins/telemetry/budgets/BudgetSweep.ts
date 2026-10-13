import type {
  ProjectId,
  RoutingTier,
  TelemetryBudget,
  TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as Attention from "../../Attention.ts";
import { unmeasured } from "../measures/index.ts";
import type * as Telemetry from "../Telemetry.ts";
import * as BudgetStore from "./BudgetStore.ts";

const PLUGIN_ID = "telemetry";
const FLAG_KIND = "budget_breach";
const RESUME_ACTION = { label: "Open budgets", target: "settings" } as const;

/** A flag is per budget and project: a budget with no project is judged in each one apart. */
const flagKey = (budgetId: number, projectId: ProjectId) => `budget:${budgetId}:${projectId}`;

const isBreach = (budget: TelemetryBudget, value: number) =>
  budget.direction === "lower_is_better" ? value > budget.threshold : value < budget.threshold;

/** Up to two decimals, so tokens per turn read as whole numbers. */
const show = (value: number) => String(Math.round(value * 100) / 100);

const flagText = (budget: TelemetryBudget, value: number, project: string) =>
  `${budget.measure} for the ${budget.tier} tier is ${show(value)} ${
    budget.direction === "lower_is_better" ? "over" : "under"
  } its budget of ${show(budget.threshold)} in ${project}.`;

/** What a judgment of one budget in one project rests on, besides the project's rows. */
const terms = (windowFrom: string, budget: TelemetryBudget) =>
  [
    windowFrom,
    budget.measure,
    budget.tier,
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
 * clears the flag and appends one `recovery`; anything else writes nothing. A breach whose flag
 * is not open, as after a budget is enabled again, raises it again without an event, and the flag
 * of a budget that was removed or disabled, or of a project that is gone, is cleared.
 *
 * The window's rows are all in the past, so a budget is measured in a project once per window and
 * set of terms; one whose measures could not be read, or were not measured yet, as while telemetry
 * replays the event log or the routing plugin is off, is asked again on the next tick. A dry run
 * counts and writes nothing.
 */
export const sweep = (measures: Telemetry.Telemetry["Service"]["measures"]) =>
  Effect.gen(function* () {
    const store = yield* BudgetStore.BudgetStore;
    const attention = yield* Attention.Attention;
    const projects = yield* ProjectService.ProjectService;
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
        // One request per project and tier, shared by every budget on that tier.
        const results = new Map<string, TelemetryMeasuresResult | undefined>();
        const measured = (projectId: ProjectId, tier: RoutingTier) =>
          Effect.gen(function* () {
            const key = `${projectId}\n${tier}`;
            if (results.has(key)) return results.get(key);
            const answer = yield* Effect.result(measures({ projectId, ...window, tier }));
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
          const projectIds =
            budget.projectId === null ? shells.map((shell) => shell.id) : [budget.projectId];
          for (const projectId of projectIds) {
            const threadId = flagKey(budget.id, projectId);
            covered.add(threadId);
            const stamp = terms(window.from, budget);
            if (judged.get(threadId) === stamp) continue;
            const result = yield* measured(projectId, budget.tier);
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
                budgetId: budget.id,
                projectId,
                windowFrom: window.from,
                windowTo: window.to,
                value,
                threshold: budget.threshold,
                sampleSize: measure.sampleSize,
              };
              if (breached && (!inBreach || !open.has(threadId))) {
                acted += 1;
                flags += 1;
                if (!dryRun) {
                  if (!inBreach) yield* store.record({ ...event, kind: "breach" });
                  yield* attention.raise({
                    ...flag,
                    text: flagText(budget, value, titles.get(projectId) ?? projectId),
                    resumeAction: RESUME_ACTION,
                  });
                }
              } else if (!breached && inBreach) {
                acted += 1;
                if (!dryRun) {
                  // Cleared first: a failed write after it is retried as a breach to recover.
                  yield* attention.clear(flag);
                  yield* store.record({ ...event, kind: "recovery" });
                }
              }
            }
            // Only once its writes are done: a failed one leaves the pair to the next tick.
            judged.set(threadId, stamp);
          }
        }
        // A budget disabled and enabled again is judged afresh, which raises its flag again.
        for (const threadId of judged.keys()) if (!covered.has(threadId)) judged.delete(threadId);
        const stale = [...open].filter((threadId) => !covered.has(threadId));
        acted += stale.length;
        if (!dryRun) {
          for (const threadId of stale) {
            yield* attention.clear({ pluginId: PLUGIN_ID, threadId, kind: FLAG_KIND });
          }
        }
        return { examined, acted, flags };
      });

    return { plugin: PLUGIN_ID, name: "budgets", run };
  });
