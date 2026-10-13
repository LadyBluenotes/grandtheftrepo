import { assert, it } from "@effect/vitest";
import {
  type LearningCorrection,
  type LearningDeclaredMode,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { FROM, input, INSIDE, TO } from "./fixtures.ts";
import { knownErrorRecurrence } from "./known_error_recurrence.ts";

const PROMOTED = "2026-10-03T00:00:00.000Z";
const AFTER = "2026-10-04T00:00:00.000Z";

const correction = (
  declaredMode: LearningDeclaredMode | null,
  createdAt: string,
): LearningCorrection => ({
  id: 1,
  projectId: ProjectId.make("project:1"),
  threadId: ThreadId.make("thread:1"),
  failureKind: declaredMode === null ? "provider_turn_failed" : "review_verdict",
  causeClass: declaredMode ?? "unclassified",
  declaredMode,
  description: "Wrong.",
  sourceEventIds: [],
  sourceKey: null,
  classifiedAt: null,
  classificationReason: null,
  createdAt,
  updatedAt: createdAt,
});

const defectPromoted = { failureMode: "defect", promotedAt: PROMOTED };

it("is the share of the window's declared corrections whose mode was already promoted", () => {
  const result = knownErrorRecurrence(
    input({
      promotedItems: [defectPromoted],
      corrections: [
        correction("defect", AFTER),
        correction("defect", INSIDE),
        // A mode with no promoted item, and one with no declared mode at all.
        correction("incomplete", AFTER),
        correction("convention", AFTER),
        correction(null, AFTER),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 0.25, 4]);
});

it("is unavailable in an empty window, and while the learning plugin is off", () => {
  for (const empty of [
    input(),
    // Corrections that name no mode, or fall outside the window, are not in the sample.
    input({
      promotedItems: [defectPromoted],
      corrections: [correction(null, AFTER), correction("defect", TO)],
    }),
  ]) {
    const result = knownErrorRecurrence(empty);
    assert.deepEqual(
      [result.state, result.value, result.sampleSize, result.missingReason],
      ["unavailable", null, 0, "No correction with a declared failure mode in the window."],
    );
  }

  for (const off of [
    input({ corrections: undefined, promotedItems: undefined }),
    input({ corrections: [correction("defect", AFTER)], promotedItems: undefined }),
  ]) {
    const result = knownErrorRecurrence(off);
    assert.deepEqual(
      [result.state, result.value, result.sampleSize, result.missingReason],
      [
        "unavailable",
        null,
        0,
        "Corrections and learning items come from the learning plugin, which is not running.",
      ],
    );
  }
});

it("does not count a correction made before, or at the moment of, the promotion", () => {
  const result = knownErrorRecurrence(
    input({
      promotedItems: [defectPromoted],
      corrections: [
        correction("defect", FROM),
        correction("defect", INSIDE),
        correction("defect", PROMOTED),
      ],
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [0, 3]);
});

it("answers zero, not unavailable, when nothing was promoted before a declared correction", () => {
  const result = knownErrorRecurrence(
    input({ promotedItems: [], corrections: [correction("defect", AFTER)] }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 0, 1]);
});
