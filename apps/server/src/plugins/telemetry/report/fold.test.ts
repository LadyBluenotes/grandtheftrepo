import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  BEFORE,
  correction,
  FROM,
  fullInput,
  INSIDE,
  item,
  LATER,
  pullRequest,
  thread,
  TO,
} from "./fixtures.ts";
import { foldReport, MAX_SECTION_ITEMS, reportRange } from "./fold.ts";
import { renderHtml } from "./renderHtml.ts";

const SECTIONS = [
  "delivered",
  "findings",
  "decisions",
  "knowledgeChanges",
  "prompts",
  "failures",
  "pullRequests",
  "unresolved",
  "attention",
  "efficiency",
] as const;

it("the same rows always give the same report, in whatever order they were loaded", () => {
  const input = fullInput();
  const report = foldReport(input);
  assert.deepEqual(foldReport(fullInput()), report);
  assert.strictEqual(renderHtml(foldReport(fullInput())), renderHtml(report));
  const shuffled = foldReport({
    ...input,
    threads: input.threads.toReversed(),
    flags: input.flags.toReversed(),
    verdicts: input.verdicts?.toReversed(),
    learning: input.learning && {
      ...input.learning,
      corrections: input.learning.corrections.toReversed(),
      items: input.learning.items.toReversed(),
      promotions: input.learning.promotions.toReversed(),
    },
  });
  assert.deepEqual(shuffled, report);
});

it("a full week fills all ten sections", () => {
  const report = foldReport(fullInput());
  assert.deepEqual(
    SECTIONS.map((name) => [name, report[name].state, report[name].count]),
    [
      ["delivered", "ok", 1],
      ["findings", "ok", 2],
      ["decisions", "ok", 1],
      ["knowledgeChanges", "ok", 1],
      ["prompts", "ok", 1],
      ["failures", "ok", 2],
      ["pullRequests", "ok", 2],
      ["unresolved", "ok", 2],
      ["attention", "ok", 1],
      ["efficiency", "ok", 2],
    ],
  );
});

it("delivered: a merged pull request on a thread settled in the range is one item", () => {
  const report = foldReport({
    ...fullInput(),
    threads: [
      thread("thread:shipped", {
        title: "Ship login",
        settledAt: INSIDE,
        pullRequests: [pullRequest(1, { state: "merged", closedAt: INSIDE })],
      }),
      // The host gave no merge time: the state alone makes it delivered.
      thread("thread:untimed", {
        title: "Untimed merge",
        settledAt: LATER,
        pullRequests: [pullRequest(4, { state: "merged" })],
      }),
      // Settled in the range, but nothing merged.
      thread("thread:abandoned", {
        settledAt: INSIDE,
        pullRequests: [pullRequest(2, { state: "closed", closedAt: INSIDE })],
      }),
      // Merged, but settled at `to`, which the range leaves out.
      thread("thread:late", {
        settledAt: TO,
        pullRequests: [pullRequest(3, { state: "merged", closedAt: INSIDE })],
      }),
    ],
  });
  assert.deepEqual(report.delivered.items, [
    {
      threadId: ThreadId.make("thread:shipped"),
      title: "Ship login",
      settledAt: INSIDE,
      pullRequests: [
        { repository: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1" },
      ],
    },
    {
      threadId: ThreadId.make("thread:untimed"),
      title: "Untimed merge",
      settledAt: LATER,
      pullRequests: [
        { repository: "acme/app", number: 4, url: "https://github.com/acme/app/pull/4" },
      ],
    },
  ]);
});

it("findings: the range's verdicts by outcome and failure mode, and unavailable without review", () => {
  const input = fullInput();
  assert.deepEqual(
    foldReport(input).findings.items.map((finding) => [
      finding.verdictId,
      finding.outcome,
      finding.failureMode,
      finding.title,
    ]),
    [
      ["verdict:1", "approve", null, "Ship login"],
      ["verdict:2", "changes_requested", "defect", "Fix the flaky test"],
    ],
  );
  assert.deepEqual(foldReport({ ...input, verdicts: undefined }).findings, {
    state: "unavailable",
    missingReason: "The review plugin is not running.",
    count: 0,
    items: [],
  });
});

it("decisions: dispositions a person set in the range, whenever evidence last moved the item", () => {
  const input = fullInput();
  const report = foldReport({
    ...input,
    learning: input.learning && {
      ...input.learning,
      items: [
        ...input.learning.items,
        // Decided in the range; evidence after the range moved `updatedAt` out of it.
        item(5, {
          failureMode: "missing_verification",
          ownerKind: "policy",
          state: "candidate",
          dispositionBy: "person",
          dispositionAt: INSIDE,
          updatedAt: TO,
        }),
      ],
    },
  });
  // Item 3 was decided before the range, though its `updatedAt` is inside it.
  assert.deepEqual(report.decisions.items, [
    {
      itemId: 5,
      failureMode: "missing_verification",
      state: "candidate",
      ownerKind: "policy",
      decidedAt: INSIDE,
    },
    { itemId: 2, failureMode: "incomplete", state: "closed", ownerKind: null, decidedAt: LATER },
  ]);
});

it("knowledge and prompt changes: deliveries to each owner kind, until no plugin promotes it", () => {
  const input = fullInput();
  const report = foldReport(input);
  assert.deepEqual(report.knowledgeChanges.items, [
    { promotionId: 1, itemId: 1, failureMode: "convention", deliveredAt: INSIDE },
  ]);
  assert.deepEqual(report.prompts.items, [
    { promotionId: 2, itemId: 2, failureMode: "unclear_spec", deliveredAt: LATER },
  ]);

  const noPromoters = foldReport({
    ...input,
    learning: input.learning && { ...input.learning, promoters: [] },
  });
  assert.deepEqual(
    [noPromoters.knowledgeChanges, noPromoters.prompts].map((part) => [
      part.state,
      part.missingReason,
    ]),
    [
      ["unavailable", "No plugin hands learning items to project knowledge yet."],
      ["unavailable", "No plugin hands learning items to prompts yet."],
    ],
  );
});

it("failures: the range's corrections by kind, leaving out the one at `to`", () => {
  assert.deepEqual(
    foldReport(fullInput()).failures.items.map((failure) => [
      failure.correctionId,
      failure.failureKind,
      failure.title,
    ]),
    [
      [2, "changes_requested", "Fix the flaky test"],
      [1, "provider_turn_failed", "Fix the flaky test"],
    ],
  );
});

it("learning off: its sections are unavailable, naming the plugin", () => {
  const report = foldReport({ ...fullInput(), learning: undefined });
  assert.deepEqual(
    (["decisions", "knowledgeChanges", "prompts", "failures"] as const).map((name) => [
      report[name].state,
      report[name].missingReason,
    ]),
    Array.from({ length: 4 }, () => ["unavailable", "The learning plugin is not running."]),
  );
  // Pull requests still answer; the learning items they would sit beside are named as missing.
  assert.deepEqual(
    [report.unresolved.state, report.unresolved.items.map((entry) => entry.kind)],
    ["ok", ["pull_request"]],
  );
  assert.match(report.unresolved.missingReason ?? "", /learning plugin/);
});

it("pull requests: open now or closed in the range, once each, by state", () => {
  const shared = pullRequest(5, { state: "merged", closedAt: INSIDE });
  const report = foldReport({
    ...fullInput(),
    threads: [
      thread("thread:a", { pullRequests: [shared, pullRequest(6)] }),
      // The same pull request linked from a second thread.
      thread("thread:b", { pullRequests: [shared] }),
      thread("thread:c", {
        pullRequests: [
          pullRequest(7, { state: "closed", closedAt: BEFORE }),
          // Merged, but the host gave neither a merge nor a close time: in no range.
          pullRequest(9, { state: "merged" }),
          // Linked only after the range.
          pullRequest(8, { linkedAt: TO }),
        ],
      }),
    ],
  });
  assert.deepEqual(
    report.pullRequests.items.map((pr) => [pr.number, pr.state]),
    [
      [6, "open"],
      [5, "merged"],
    ],
  );
});

it("unresolved: open learning items, most seen first, then pull requests with changes requested", () => {
  const input = fullInput();
  const report = foldReport({
    ...input,
    learning: input.learning && {
      ...input.learning,
      items: [
        ...input.learning.items,
        item(9, { failureMode: "efficiency_regression:cost", occurrences: 5 }),
      ],
    },
  });
  assert.deepEqual(
    report.unresolved.items.map((entry) =>
      entry.kind === "learning_item" ? [entry.kind, entry.failureMode] : [entry.kind, entry.number],
    ),
    [
      ["learning_item", "efficiency_regression:cost"],
      ["learning_item", "defect"],
      ["pull_request", 2],
    ],
  );
});

it("attention: open flags on this project's threads only", () => {
  assert.deepEqual(foldReport(fullInput()).attention.items, [
    {
      threadId: ThreadId.make("thread:open"),
      title: "Fix the flaky test",
      text: "2 threads are writing to this project at once.",
    },
  ]);
});

it("efficiency: the measures as telemetry answers them", () => {
  const input = fullInput();
  assert.deepEqual(foldReport(input).efficiency.items, input.measures);
});

it("a section lists at most 20 items and counts all of them", () => {
  const corrections = Array.from({ length: 25 }, (_, index) => correction(index + 1));
  const input = fullInput();
  const report = foldReport({
    ...input,
    learning: input.learning && { ...input.learning, corrections },
  });
  assert.strictEqual(report.failures.count, 25);
  assert.strictEqual(report.failures.items.length, MAX_SECTION_ITEMS);
  assert.include(renderHtml(report), "Showing 20 of 25.");
});

it("a range is half-open, defaults to the last seven whole UTC days, and must run forward", () => {
  const now = DateTime.makeUnsafe("2026-10-12T09:30:00.000Z");
  assert.deepEqual(reportRange({}, now), Result.succeed({ from: FROM, to: TO }));
  assert.deepEqual(
    reportRange({ from: "2026-10-05T00:00:00Z", to: "2026-10-06T00:00:00Z" }, now),
    Result.succeed({ from: FROM, to: "2026-10-06T00:00:00.000Z" }),
  );
  assert.deepEqual(
    reportRange({ from: TO, to: FROM }, now),
    Result.fail("Report range is invalid"),
  );
  assert.deepEqual(
    reportRange({ from: FROM, to: FROM }, now),
    Result.fail("Report range is invalid"),
  );
  assert.isTrue(Result.isFailure(reportRange({ from: FROM }, now)));
  assert.isTrue(Result.isFailure(reportRange({ from: "last week", to: TO }, now)));
});
