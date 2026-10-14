import type {
  DeterministicProposal,
  DeterministicProposalState,
  LearningCorrection,
  LearningItem,
  LearningOwnerKind,
  LearningPromotion,
  ProjectId,
  PullRequestReviewDecision,
  PullRequestState,
  ReviewVerdict,
  TelemetryMeasuresResult,
  TelemetryReport,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/** The most items a section lists; its `count` is all of them. */
export const MAX_SECTION_ITEMS = 20;

/** A linked pull request as its latest sync saw it. Instants are normalized ISO strings. */
export interface ReportPullRequest {
  /** Host, repository and number, the same for the pull request linked from any thread. */
  readonly key: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: PullRequestState;
  readonly reviewDecision: PullRequestReviewDecision | null;
  /**
   * When it merged or closed; null while open, or when the host gave neither time. A null one is
   * in no range: it counts only where its state alone matters, such as a delivered thread.
   */
  readonly closedAt: string | null;
  readonly linkedAt: string;
  /** When the snapshot holding the state, title and times was synced from the host. */
  readonly syncedAt: string;
}

export interface ReportThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly settledAt: string | null;
  readonly pullRequests: ReadonlyArray<ReportPullRequest>;
}

/** Everything one report reads, loaded by `ReportService`. The range is `[from, to)`. */
export interface ReportInput {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly from: string;
  readonly to: string;
  /**
   * The project's threads the report can name: the active ones, and the archived ones the
   * plugin's thread rows say settled or merged in the range.
   */
  readonly threads: ReadonlyArray<ReportThread>;
  /**
   * Why the plugin's thread rows cannot be read yet, the reason the measures give; null when
   * they can. While set, the sections built from the threads those rows name are unavailable.
   */
  readonly threadRowsUnavailable: string | null;
  readonly measures: TelemetryMeasuresResult;
  /**
   * Every open attention flag, with the project it is raised on when it is on a project rather
   * than a thread, as a budget breach is. The fold keeps this project's and its threads'.
   */
  readonly flags: ReadonlyArray<{
    readonly threadId: string;
    readonly projectId: string | null;
    readonly text: string;
  }>;
  /** Verdicts given in the range. Undefined while the review plugin is not running. */
  readonly verdicts: ReadonlyArray<ReviewVerdict> | undefined;
  /** Undefined while the learning plugin is not running. */
  readonly learning:
    | {
        /** Corrections from `from` through `to`, which the learning plugin includes. */
        readonly corrections: ReadonlyArray<LearningCorrection>;
        /** Every item of the project. */
        readonly items: ReadonlyArray<LearningItem>;
        /** Promotions whose draft was delivered in the range to project knowledge or prompts. */
        readonly promotions: ReadonlyArray<LearningPromotion>;
        /** Owner kinds a plugin hands items to. */
        readonly promoters: ReadonlyArray<LearningOwnerKind>;
        /**
         * Proposals decided in the range, and those still undecided that were found in a week
         * starting before `to`: the review proposes from a week once it has ended.
         */
        readonly proposals: ReadonlyArray<DeterministicProposal>;
      }
    | undefined;
}

type Section<K extends keyof TelemetryReport> = TelemetryReport[K];

const ok = <Item>(items: ReadonlyArray<Item>, missingReason: string | null = null) => ({
  state: "ok" as const,
  missingReason,
  count: items.length,
  items: items.slice(0, MAX_SECTION_ITEMS),
});

const unavailable = (missingReason: string) => ({
  state: "unavailable" as const,
  missingReason,
  count: 0,
  items: [],
});

const notRunning = (plugin: string) => `The ${plugin} plugin is not running.`;

/**
 * Archived threads are loaded only when the plugin's rows say they settled in the range or their
 * latest merge falls in it: the rows keep a thread's latest merge, not every one.
 */
const ARCHIVED_LIMIT =
  "Archived threads count only when they settled in the range or their latest merge falls in it.";

/** Orders by each key in turn. Strings compare by code unit, so the order is the same everywhere. */
const byKeys =
  <T>(...keys: ReadonlyArray<(value: T) => string | number>) =>
  (left: T, right: T) => {
    for (const key of keys) {
      const a = key(left);
      const b = key(right);
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  };

const STATE_ORDER: Record<PullRequestState, number> = { open: 0, merged: 1, closed: 2 };

const PROPOSAL_ORDER: Record<DeterministicProposalState, number> = {
  accepted: 0,
  pending: 1,
  waiting: 2,
  dismissed: 3,
};

/** Every listed proposal by decision, counted before the section keeps only its first items. */
const tallyProposals = (
  proposals: ReadonlyArray<{
    readonly state: DeterministicProposalState;
    readonly estimatedTokens: number;
  }>,
): TelemetryReport["deterministic"]["totals"] => {
  const tally = (states: ReadonlyArray<DeterministicProposalState>) => {
    const counted = proposals.filter((proposal) => states.includes(proposal.state));
    return {
      count: counted.length,
      estimatedTokens: counted.reduce((total, proposal) => total + proposal.estimatedTokens, 0),
    };
  };
  return {
    accepted: tally(["accepted"]),
    undecided: tally(["pending", "waiting"]),
    dismissed: tally(["dismissed"]),
  };
};

/**
 * The range a report covers, as normalized ISO instants: the one given, or with neither bound
 * given, the last seven whole UTC days before `now`.
 */
export const reportRange = (
  input: { readonly from?: string | undefined; readonly to?: string | undefined },
  now: DateTime.Utc,
): Result.Result<{ readonly from: string; readonly to: string }, string> => {
  if (input.from === undefined && input.to === undefined) {
    const to = DateTime.startOf(now, "day");
    return Result.succeed({
      from: DateTime.formatIso(DateTime.subtract(to, { days: 7 })),
      to: DateTime.formatIso(to),
    });
  }
  if (input.from === undefined || input.to === undefined) {
    return Result.fail("Report range is invalid: give both from and to, or neither.");
  }
  const from = DateTime.make(input.from);
  const to = DateTime.make(input.to);
  if (Option.isNone(from) || Option.isNone(to)) {
    return Result.fail("Report range is invalid: from and to must be ISO instants.");
  }
  if (!DateTime.isGreaterThan(to.value, from.value)) return Result.fail("Report range is invalid");
  return Result.succeed({ from: DateTime.formatIso(from.value), to: DateTime.formatIso(to.value) });
};

/**
 * The report over loaded rows: no clock, no database, so the same input always gives the same
 * report. A section whose plugin is off is `unavailable`, naming the plugin.
 */

/** A proposal's source window: an undecided one counts once its week ended inside the range. */
const PROPOSAL_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const foldReport = (input: ReportInput): TelemetryReport => {
  const inRange = (at: string | null) => at !== null && at >= input.from && at < input.to;
  const threads = input.threads.toSorted(byKeys((thread) => thread.id));
  const byId = new Map<string, ReportThread>(threads.map((thread) => [thread.id, thread]));
  const titleOf = (threadId: string) => byId.get(threadId)?.title ?? null;

  const delivered: Section<"delivered">["items"] = threads.flatMap((thread) => {
    const merged = thread.pullRequests.filter((pr) => pr.state === "merged");
    if (thread.settledAt === null || !inRange(thread.settledAt) || merged.length === 0) return [];
    return [
      {
        threadId: thread.id,
        title: thread.title,
        settledAt: thread.settledAt,
        pullRequests: merged
          .toSorted(
            byKeys(
              (pr) => pr.repository,
              (pr) => pr.number,
            ),
          )
          .map(({ repository, number, url }) => ({ repository, number, url })),
      },
    ];
  });

  // A pull request linked from two threads is listed once: as its latest synced snapshot says,
  // linked since its earliest link. Each thread's link syncs on its own.
  const pullRequests = new Map<string, ReportPullRequest>();
  for (const thread of threads) {
    for (const pr of thread.pullRequests) {
      const seen = pullRequests.get(pr.key);
      if (seen === undefined) {
        pullRequests.set(pr.key, pr);
        continue;
      }
      const latest = pr.syncedAt > seen.syncedAt ? pr : seen;
      const linkedAt = pr.linkedAt < seen.linkedAt ? pr.linkedAt : seen.linkedAt;
      pullRequests.set(pr.key, { ...latest, linkedAt });
    }
  }
  const linked = [...pullRequests.values()].toSorted(
    byKeys(
      (pr) => STATE_ORDER[pr.state],
      (pr) => pr.repository,
      (pr) => pr.number,
    ),
  );
  const changesRequested = linked.filter(
    (pr) => pr.state === "open" && pr.reviewDecision === "changes-requested",
  );

  const { learning, verdicts, threadRowsUnavailable } = input;
  const handedTo = (ownerKind: LearningOwnerKind, owner: string) => {
    if (learning === undefined) return unavailable(notRunning("learning"));
    if (!learning.promoters.includes(ownerKind)) {
      return unavailable(`No plugin hands learning items to ${owner} yet.`);
    }
    return ok(
      learning.promotions
        .flatMap(({ deliveredAt, ...promotion }) =>
          promotion.ownerKind === ownerKind && deliveredAt !== null && inRange(deliveredAt)
            ? [{ ...promotion, deliveredAt }]
            : [],
        )
        .toSorted(
          byKeys(
            (promotion) => promotion.deliveredAt,
            (promotion) => promotion.id,
          ),
        )
        .map((promotion) => ({
          promotionId: promotion.id,
          itemId: promotion.itemId,
          failureMode: promotion.failureMode,
          deliveredAt: promotion.deliveredAt,
        })),
    );
  };

  const openItems: Section<"unresolved">["items"] =
    learning === undefined
      ? []
      : learning.items
          .filter((item) => item.state === "open")
          .toSorted(
            byKeys(
              (item) => -item.occurrences,
              (item) => item.id,
            ),
          )
          .map((item) => ({
            kind: "learning_item" as const,
            itemId: item.id,
            failureMode: item.failureMode,
            occurrences: item.occurrences,
            updatedAt: item.updatedAt,
          }));

  const proposals: Section<"deterministic">["items"] = (learning?.proposals ?? [])
    .filter((proposal) =>
      proposal.decidedAt === null
        ? Date.parse(proposal.windowFrom) + PROPOSAL_WEEK_MS <= Date.parse(input.to)
        : inRange(proposal.decidedAt),
    )
    .toSorted(
      byKeys(
        (proposal) => PROPOSAL_ORDER[proposal.state],
        (proposal) => -proposal.estimatedTokens,
        (proposal) => proposal.id,
      ),
    )
    .map((proposal) => ({
      proposalId: proposal.id,
      form: proposal.form,
      title: proposal.title,
      state: proposal.state,
      estimatedTokens: proposal.estimatedTokens,
      decidedAt: proposal.decidedAt,
      dismissReason: proposal.dismissReason,
    }));

  return {
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    from: input.from,
    to: input.to,
    delivered:
      threadRowsUnavailable !== null
        ? unavailable(threadRowsUnavailable)
        : ok(
            delivered.toSorted(
              byKeys(
                (item) => item.settledAt,
                (item) => item.threadId,
              ),
            ),
          ),
    findings:
      verdicts === undefined
        ? unavailable(notRunning("review"))
        : ok(
            verdicts
              .filter((verdict) => inRange(verdict.createdAt))
              .toSorted(
                byKeys(
                  (verdict) => verdict.outcome,
                  (verdict) => verdict.failureMode ?? "",
                  (verdict) => verdict.createdAt,
                  (verdict) => verdict.id,
                ),
              )
              .map((verdict) => ({
                verdictId: verdict.id,
                threadId: verdict.reviewedThreadId,
                title: titleOf(verdict.reviewedThreadId),
                outcome: verdict.outcome,
                failureMode: verdict.failureMode,
                summary: verdict.summary,
                createdAt: verdict.createdAt,
              })),
          ),
    decisions:
      learning === undefined
        ? unavailable(notRunning("learning"))
        : ok(
            // By when the person set it: an item's `updatedAt` also moves with new evidence.
            learning.items
              .flatMap(({ dispositionAt, ...item }) =>
                item.dispositionBy === "person" && dispositionAt !== null && inRange(dispositionAt)
                  ? [
                      {
                        itemId: item.id,
                        failureMode: item.failureMode,
                        state: item.state,
                        ownerKind: item.ownerKind,
                        decidedAt: dispositionAt,
                      },
                    ]
                  : [],
              )
              .toSorted(
                byKeys(
                  (decision) => decision.decidedAt,
                  (decision) => decision.itemId,
                ),
              ),
          ),
    knowledgeChanges: handedTo("project_knowledge", "project knowledge"),
    prompts: handedTo("prompt", "prompts"),
    failures:
      learning === undefined
        ? unavailable(notRunning("learning"))
        : ok(
            learning.corrections
              .filter((correction) => inRange(correction.createdAt))
              .toSorted(
                byKeys(
                  (correction) => correction.failureKind,
                  (correction) => correction.createdAt,
                  (correction) => correction.id,
                ),
              )
              .map((correction) => ({
                correctionId: correction.id,
                threadId: correction.threadId,
                title: titleOf(correction.threadId),
                failureKind: correction.failureKind,
                declaredMode: correction.declaredMode,
                description: correction.description,
                createdAt: correction.createdAt,
              })),
          ),
    pullRequests:
      threadRowsUnavailable !== null
        ? unavailable(threadRowsUnavailable)
        : ok(
            linked
              .filter(
                (pr) => pr.linkedAt < input.to && (pr.state === "open" || inRange(pr.closedAt)),
              )
              .map(({ repository, number, url, title, state }) => ({
                repository,
                number,
                url,
                title,
                state,
              })),
            ARCHIVED_LIMIT,
          ),
    unresolved:
      threadRowsUnavailable !== null
        ? unavailable(threadRowsUnavailable)
        : ok(
            [
              ...openItems,
              ...changesRequested.map(({ repository, number, url, title }) => ({
                kind: "pull_request" as const,
                repository,
                number,
                url,
                title,
              })),
            ],
            learning === undefined
              ? `Open learning items are left out: the learning plugin is not running. ${ARCHIVED_LIMIT}`
              : ARCHIVED_LIMIT,
          ),
    attention: ok(
      input.flags
        .toSorted(
          byKeys(
            (flag) => flag.threadId,
            (flag) => flag.text,
          ),
        )
        .flatMap((flag): Section<"attention">["items"] => {
          if (flag.projectId !== null) {
            return flag.projectId === input.projectId
              ? [{ threadId: null, title: null, text: flag.text }]
              : [];
          }
          const thread = byId.get(flag.threadId);
          return thread === undefined
            ? []
            : [{ threadId: thread.id, title: thread.title, text: flag.text }];
        }),
    ),
    efficiency: ok(input.measures),
    deterministic:
      learning === undefined
        ? { ...unavailable(notRunning("learning")), totals: tallyProposals([]) }
        : { ...ok(proposals), totals: tallyProposals(proposals) },
  };
};
