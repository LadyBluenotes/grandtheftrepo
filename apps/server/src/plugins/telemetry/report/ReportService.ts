import {
  type LearningOwnerKind,
  type OrchestrationV2ThreadShell,
  TelemetryError,
  type TelemetryReportInput,
  type TelemetryReportResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Attention from "../../Attention.ts";
import * as CorrectionStore from "../../learning/CorrectionStore.ts";
import * as ItemStore from "../../learning/items/ItemStore.ts";
import * as Promoter from "../../learning/Promoter.ts";
import * as VerdictStore from "../../review/VerdictStore.ts";
import * as Telemetry from "../Telemetry.ts";
import { foldReport, reportRange, type ReportThread } from "./fold.ts";
import { renderHtml } from "./renderHtml.ts";

/** The owner kinds whose handovers the report lists. */
const REPORTED_OWNER_KINDS: ReadonlyArray<LearningOwnerKind> = ["project_knowledge", "prompt"];

const failWith =
  (message: string) =>
  <E>(cause: E) =>
    Effect.logWarning("telemetry: report could not be built", { cause }).pipe(
      Effect.andThen(Effect.fail(new TelemetryError({ message }))),
    );

/** An instant the host or a projection gave, normalized so it compares with the range; null when it does not parse. */
const instant = (value: string | null | undefined) => {
  const parsed = value == null ? Option.none() : DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : null;
};

/** What the fold reads of a thread: its title, settlement and synced pull requests. */
const toReportThread = (shell: OrchestrationV2ThreadShell): ReportThread => ({
  id: shell.id,
  title: shell.title,
  settledAt: shell.settledAt === null ? null : DateTime.formatIso(shell.settledAt),
  pullRequests: visibleThreadPullRequests(shell.pullRequests ?? []).flatMap((link) => {
    const { snapshot } = link;
    if (snapshot === null) return [];
    return [
      {
        key: threadPullRequestKeyOf(link),
        repository: link.repository,
        number: link.number,
        url: link.url,
        title: snapshot.title,
        state: snapshot.state,
        reviewDecision: snapshot.reviewDecision ?? null,
        // Only the host's merge or close time: `updatedAt` is any later activity, not the end.
        closedAt:
          snapshot.state === "open" ? null : instant(snapshot.mergedAt ?? snapshot.closedAt),
        linkedAt: instant(link.linkedAt) ?? link.linkedAt,
      },
    ];
  }),
});

/**
 * A project's activity over a range, folded from what the server and the sibling plugins already
 * hold: no table of its own. Sections from the learning and review plugins are read where the call
 * runs, so a plugin that is off makes its sections `unavailable` rather than failing the report.
 */
export class ReportService extends Context.Service<
  ReportService,
  {
    readonly report: (
      input: TelemetryReportInput,
    ) => Effect.Effect<TelemetryReportResult, TelemetryError>;
  }
>()("t3/plugins/telemetry/report/ReportService") {}

const make = Effect.gen(function* () {
  const telemetry = yield* Telemetry.Telemetry;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const attention = yield* Attention.Attention;

  const report: ReportService["Service"]["report"] = (input) =>
    Effect.gen(function* () {
      const range = reportRange(input, yield* DateTime.now);
      if (Result.isFailure(range)) return yield* new TelemetryError({ message: range.failure });
      const { from, to } = range.success;
      const { projectId } = input;
      const project = yield* projects.getShell(projectId);
      if (Option.isNone(project)) {
        return yield* new TelemetryError({ message: `Project ${projectId} was not found.` });
      }
      // The measures wait for the reactor, whose thread rows name the archived threads below.
      const measures = yield* telemetry.measures({ projectId, from, to });

      const readThreads = Effect.catch(failWith("The project's threads could not be read."));
      const active = yield* threads
        .listProjectThreads({ projectId, includeSubagents: true })
        .pipe(readThreads);
      const loaded = new Set<string>(active.map((thread) => thread.id));
      // Archived threads are not in the active list; only those the range touched matter.
      const touched = yield* sql<{ readonly thread_id: ThreadId }>`
        SELECT thread_id FROM telemetry_threads
        WHERE project_id = ${projectId}
          AND ((settled_at >= ${from} AND settled_at < ${to})
            OR (pull_request_merged_at >= ${from} AND pull_request_merged_at < ${to}))
        ORDER BY thread_id`;
      const archived = yield* Effect.forEach(
        touched.filter((row) => !loaded.has(row.thread_id)),
        (row) => threads.getThreadShell(row.thread_id).pipe(readThreads),
      );
      const shells = [
        ...active,
        ...archived.filter(
          (shell): shell is OrchestrationV2ThreadShell =>
            shell !== null && shell.deletedAt === null && shell.projectId === projectId,
        ),
      ];

      const verdictStore = yield* Effect.serviceOption(VerdictStore.VerdictStore);
      const corrections = yield* Effect.serviceOption(CorrectionStore.CorrectionStore);
      const items = yield* Effect.serviceOption(ItemStore.ItemStore);
      const promoters = yield* Effect.serviceOption(Promoter.PromoterRegistry);
      const learning =
        Option.isSome(corrections) && Option.isSome(items) && Option.isSome(promoters)
          ? {
              corrections: yield* corrections.value.list({ projectId, from, to }),
              items: yield* items.value.list({ projectId }),
              promotions: yield* items.value.deliveredIn({
                projectId,
                ownerKinds: REPORTED_OWNER_KINDS,
                from,
                to,
              }),
              promoters: yield* promoters.value.ownerKinds,
            }
          : undefined;

      const folded = foldReport({
        projectId,
        projectTitle: project.value.title,
        from,
        to,
        threads: shells.map(toReportThread),
        measures,
        flags: yield* attention.listOpen({}),
        verdicts: Option.isSome(verdictStore)
          ? yield* verdictStore.value.listWindow({ projectId, from, to })
          : undefined,
        learning,
      });
      return { report: folded, html: renderHtml(folded) };
    }).pipe(
      Effect.catchTags({
        SqlError: failWith("The telemetry or attention database could not be read."),
        ProjectOperationError: failWith("The project could not be read."),
        LearningError: failWith("The learning plugin's corrections or items could not be read."),
        ReviewVerdictError: failWith("The review plugin's verdicts could not be read."),
      }),
    );

  return ReportService.of({ report });
});

/** Needs `Telemetry` for the efficiency section, so the plugin's layer builds it first. */
export const layer = Layer.effect(ReportService, make);
