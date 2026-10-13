import {
  type LearningCorrection,
  type LearningItem,
  type LearningPromotion,
  ProjectId,
  type ReviewVerdict,
  type TelemetryMeasure,
  ThreadId,
  CheckpointId,
} from "@t3tools/contracts";

import type { ReportInput, ReportPullRequest, ReportThread } from "./fold.ts";

/** The report tests' range: the week from Monday 5 October 2026. */
export const FROM = "2026-10-05T00:00:00.000Z";
export const TO = "2026-10-12T00:00:00.000Z";
export const INSIDE = "2026-10-06T00:00:00.000Z";
export const LATER = "2026-10-07T00:00:00.000Z";
export const BEFORE = "2026-10-01T00:00:00.000Z";

const projectId = ProjectId.make("project:report");

export const pullRequest = (
  number: number,
  overrides: Partial<ReportPullRequest> = {},
): ReportPullRequest => ({
  key: `github.com:acme/app#${number}`,
  repository: "acme/app",
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  title: `Change ${number}`,
  state: "open",
  reviewDecision: null,
  closedAt: null,
  linkedAt: BEFORE,
  ...overrides,
});

export const thread = (id: string, overrides: Partial<ReportThread> = {}): ReportThread => ({
  id: ThreadId.make(id),
  title: `Thread ${id}`,
  settledAt: null,
  pullRequests: [],
  ...overrides,
});

const verdict = (id: string, overrides: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  id,
  projectId,
  reviewedThreadId: ThreadId.make("thread:shipped"),
  reviewerThreadId: ThreadId.make("thread:reviewer"),
  checkpointId: CheckpointId.make(`checkpoint:${id}`),
  outcome: "approve",
  failureMode: null,
  summary: "Looks right.",
  correctionId: null,
  createdAt: INSIDE,
  invalidatedAt: null,
  ...overrides,
});

export const correction = (
  id: number,
  overrides: Partial<LearningCorrection> = {},
): LearningCorrection => ({
  id,
  projectId,
  threadId: ThreadId.make("thread:open"),
  failureKind: "provider_turn_failed",
  causeClass: "unclassified",
  declaredMode: null,
  description: "The provider turn failed.",
  sourceEventIds: [],
  sourceKey: `source:${id}`,
  classifiedAt: null,
  classificationReason: null,
  createdAt: INSIDE,
  updatedAt: INSIDE,
  ...overrides,
});

export const item = (id: number, overrides: Partial<LearningItem> = {}): LearningItem => ({
  id,
  projectId,
  failureMode: "defect",
  occurrences: 2,
  state: "open",
  ownerKind: null,
  dispositionBy: "rule",
  dispositionAt: null,
  reason: "Routed by rule.",
  createdAt: BEFORE,
  updatedAt: INSIDE,
  ...overrides,
});

const promotion = (id: number, overrides: Partial<LearningPromotion> = {}): LearningPromotion => ({
  id,
  itemId: id,
  projectId,
  failureMode: "convention",
  ownerKind: "project_knowledge",
  state: "delivered",
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  createdAt: BEFORE,
  updatedAt: INSIDE,
  ...overrides,
});

const measure = (name: string, value: number | null): TelemetryMeasure => ({
  measure: name,
  state: value === null ? "unavailable" : "ok",
  value,
  unit: "ratio",
  direction: "lower_is_better",
  sampleSize: value === null ? 0 : 4,
  missingReason: value === null ? "No turns in the window." : null,
  provenance: [],
});

/**
 * A week in which every section has something: a thread delivered with a merged pull request, one
 * still open with changes requested, verdicts, corrections, a person's decision, a handover to
 * each owner kind, an attention flag and two measures. Each list also holds a row the range or the
 * project leaves out.
 */
export const fullInput = (): ReportInput => ({
  projectId,
  projectTitle: "Acme app",
  from: FROM,
  to: TO,
  threads: [
    thread("thread:shipped", {
      title: "Ship login",
      settledAt: INSIDE,
      pullRequests: [pullRequest(1, { state: "merged", closedAt: INSIDE })],
    }),
    thread("thread:open", {
      title: "Fix the flaky test",
      pullRequests: [pullRequest(2, { reviewDecision: "changes-requested" })],
    }),
    // Settled and merged the week before: neither delivered nor listed.
    thread("thread:last-week", {
      settledAt: BEFORE,
      pullRequests: [pullRequest(3, { state: "merged", closedAt: BEFORE })],
    }),
  ],
  threadRowsUnavailable: null,
  measures: [measure("first_review_acceptance", 0.75), measure("repeated_reads", null)],
  flags: [
    {
      threadId: "thread:open",
      projectId: null,
      text: "2 threads are writing to this project at once.",
    },
    { threadId: "thread:other-project", projectId: null, text: "Two writers elsewhere." },
    {
      threadId: "budget:2:project:report",
      projectId: "project:report",
      text: "cost_per_accepted_outcome for the strong tier is 4.2 over its budget of 3 in Acme app.",
    },
    {
      threadId: "budget:2:project:elsewhere",
      projectId: "project:elsewhere",
      text: "Over budget elsewhere.",
    },
  ],
  verdicts: [
    verdict("verdict:2", {
      reviewedThreadId: ThreadId.make("thread:open"),
      outcome: "changes_requested",
      failureMode: "defect",
      summary: "The retry hides the failure.",
      createdAt: LATER,
    }),
    verdict("verdict:1"),
    // At `to`, which the range leaves out.
    verdict("verdict:3", { createdAt: TO }),
  ],
  learning: {
    corrections: [
      correction(2, { failureKind: "changes_requested", createdAt: LATER }),
      correction(1),
      // The learning plugin lists corrections at `to`; the report's range leaves them out.
      correction(3, { createdAt: TO }),
    ],
    items: [
      item(1, { failureMode: "defect", occurrences: 3 }),
      item(2, {
        failureMode: "incomplete",
        state: "closed",
        dispositionBy: "person",
        dispositionAt: LATER,
        reason: "Set by a person.",
        updatedAt: LATER,
      }),
      // A person's choice from before the range, which new evidence moved into it.
      item(3, {
        failureMode: "scope_drift",
        state: "closed",
        dispositionBy: "person",
        dispositionAt: BEFORE,
        updatedAt: INSIDE,
      }),
      item(4, { failureMode: "convention", state: "candidate", ownerKind: "project_knowledge" }),
    ],
    promotions: [
      promotion(1),
      promotion(2, { failureMode: "unclear_spec", ownerKind: "prompt", updatedAt: LATER }),
    ],
    promoters: ["project_knowledge", "prompt"],
  },
});
