import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "../baseSchemas.ts";
import { PullRequestState } from "../pullRequest.ts";
import { DeterministicProposalState } from "./deterministic.ts";
import {
  LearningDeclaredMode,
  LearningFailureKind,
  LearningItemState,
  LearningOwnerKind,
  ReviewFailureMode,
} from "./learning.ts";
import { definePluginMethods } from "./method.ts";
import { ReviewOutcome } from "./review.ts";
import { TelemetryError, TelemetryExtractionForm, TelemetryMeasure } from "./telemetry.ts";

/**
 * A project's range: `from` inclusive, `to` exclusive, both instants in UTC, `to` after `from`.
 * Omit both for the last seven whole UTC days.
 */
export const TelemetryReportInput = Schema.Struct({
  projectId: ProjectId,
  from: Schema.optional(IsoDateTime),
  to: Schema.optional(IsoDateTime),
});
export type TelemetryReportInput = typeof TelemetryReportInput.Type;

/**
 * One part of the report. `unavailable` names the plugin that is off; an `ok` section can still
 * say in `missingReason` what it had to leave out. `items` holds at most 20; `count` is all of them.
 */
const section = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({
    state: Schema.Literals(["ok", "unavailable"]),
    missingReason: Schema.NullOr(Schema.String),
    count: NonNegativeInt,
    items: Schema.Array(item),
  });

const PullRequestRef = {
  repository: Schema.String,
  number: PositiveInt,
  url: Schema.String,
};

/** A thread's title, null when the thread was not loaded, such as one archived outside the range. */
const ThreadTitle = Schema.NullOr(Schema.String);

const Promotion = Schema.Struct({
  promotionId: Schema.Int,
  itemId: Schema.Int,
  failureMode: Schema.String,
  deliveredAt: IsoDateTime,
});

/** How many proposals in one state a report counts, and their estimated tokens a week. */
const ProposalTally = Schema.Struct({ count: NonNegativeInt, estimatedTokens: NonNegativeInt });
const NO_PROPOSALS = { count: 0, estimatedTokens: 0 };

/** What happened in one project over one range, from data the server already holds. */
export const TelemetryReport = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  from: IsoDateTime,
  to: IsoDateTime,
  /** Threads settled in the range with a merged pull request. */
  delivered: section(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      settledAt: IsoDateTime,
      pullRequests: Schema.Array(Schema.Struct(PullRequestRef)),
    }),
  ),
  /** Review verdicts given in the range, by outcome and failure mode. */
  findings: section(
    Schema.Struct({
      verdictId: Schema.String,
      threadId: ThreadId,
      title: ThreadTitle,
      outcome: ReviewOutcome,
      failureMode: Schema.NullOr(ReviewFailureMode),
      summary: Schema.String,
      createdAt: IsoDateTime,
    }),
  ),
  /** Learning items a person set the disposition of in the range, by when they set it. */
  decisions: section(
    Schema.Struct({
      itemId: Schema.Int,
      failureMode: Schema.String,
      state: LearningItemState,
      ownerKind: Schema.NullOr(LearningOwnerKind),
      decidedAt: IsoDateTime,
    }),
  ),
  /** Learning items handed to project knowledge in the range. */
  knowledgeChanges: section(Promotion),
  /** Learning items handed to prompts in the range. */
  prompts: section(Promotion),
  /** Corrections recorded in the range, by kind. */
  failures: section(
    Schema.Struct({
      correctionId: Schema.Int,
      threadId: ThreadId,
      title: ThreadTitle,
      failureKind: LearningFailureKind,
      declaredMode: Schema.NullOr(LearningDeclaredMode),
      description: Schema.String,
      createdAt: IsoDateTime,
    }),
  ),
  /** Linked pull requests open now or merged or closed in the range, by state. */
  pullRequests: section(
    Schema.Struct({ ...PullRequestRef, title: Schema.String, state: PullRequestState }),
  ),
  /** Open learning items, and open pull requests with changes requested. */
  unresolved: section(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("learning_item"),
        itemId: Schema.Int,
        failureMode: Schema.String,
        occurrences: Schema.Int,
        updatedAt: IsoDateTime,
      }),
      Schema.Struct({
        kind: Schema.Literal("pull_request"),
        ...PullRequestRef,
        title: Schema.String,
      }),
    ]),
  ),
  /** Open attention flags on the project's threads, and on the project itself (budget breaches). */
  attention: section(
    Schema.Struct({
      /** Null for a flag on the project rather than a thread. */
      threadId: Schema.NullOr(ThreadId),
      title: ThreadTitle,
      text: Schema.String,
    }),
  ),
  /** The efficiency measures over the range, as `telemetry.measures` answers them. */
  efficiency: section(TelemetryMeasure),
  /**
   * Proposals to do repeated work without a model: those accepted or dismissed in the range, and
   * those still undecided, with the estimated tokens each saves in a week like the one it was
   * found in. `totals` counts every one of them, not only the items listed. A report from a server
   * without this section reads it as unavailable.
   */
  deterministic: Schema.Struct({
    ...section(
      Schema.Struct({
        proposalId: Schema.Int,
        form: TelemetryExtractionForm,
        title: Schema.String,
        state: DeterministicProposalState,
        estimatedTokens: NonNegativeInt,
        decidedAt: Schema.NullOr(IsoDateTime),
        dismissReason: Schema.NullOr(Schema.String),
      }),
    ).fields,
    totals: Schema.Struct({
      accepted: ProposalTally,
      undecided: ProposalTally,
      dismissed: ProposalTally,
    }),
  }).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        state: "unavailable" as const,
        missingReason: "The server did not report this section.",
        count: 0,
        items: [],
        totals: { accepted: NO_PROPOSALS, undecided: NO_PROPOSALS, dismissed: NO_PROPOSALS },
      }),
    ),
  ),
});
export type TelemetryReport = typeof TelemetryReport.Type;

/** The report and the same report as one self-contained HTML page. */
export const TelemetryReportResult = Schema.Struct({
  report: TelemetryReport,
  html: Schema.String,
});
export type TelemetryReportResult = typeof TelemetryReportResult.Type;

/**
 * Apart from `TELEMETRY_METHODS` so the report and the measures can change without touching the
 * same table; the telemetry dispatch table spreads both.
 */
export const TELEMETRY_REPORT_METHODS = definePluginMethods({
  report: {
    method: "telemetry.report",
    gateway: "read",
    input: TelemetryReportInput,
    output: TelemetryReportResult,
    error: TelemetryError,
  },
});
