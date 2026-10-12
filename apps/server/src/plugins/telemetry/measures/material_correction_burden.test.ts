import { assert, it } from "@effect/vitest";
import { type LearningCorrection, ProjectId, ThreadId } from "@t3tools/contracts";
import { accepted, FROM, input, INSIDE, TO } from "./fixtures.ts";
import { materialCorrectionBurden } from "./material_correction_burden.ts";

const correction = (createdAt: string): LearningCorrection => ({
  id: 1,
  projectId: ProjectId.make("project:1"),
  threadId: ThreadId.make("thread:1"),
  failureKind: "manual",
  causeClass: "unclassified",
  declaredMode: null,
  description: "Wrong file.",
  sourceEventIds: [],
  sourceKey: null,
  createdAt,
  updatedAt: createdAt,
});

it("counts the window's corrections per accepted outcome", () => {
  const result = materialCorrectionBurden(
    input({
      threads: [accepted(), accepted({ thread_id: "thread:2" })],
      corrections: [correction(INSIDE), correction(INSIDE), correction(INSIDE)],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 1.5, 2]);
});

it("is unavailable in an empty window, and while the learning plugin is off", () => {
  assert.strictEqual(
    materialCorrectionBurden(input()).missingReason,
    "No accepted outcome in the window.",
  );
  const off = materialCorrectionBurden(input({ threads: [accepted()], corrections: undefined }));
  assert.strictEqual(off.state, "unavailable");
  assert.match(off.missingReason ?? "", /learning plugin/);
});

it("leaves out a correction made at the window's end, which the learning plugin lists", () => {
  const result = materialCorrectionBurden(
    input({ threads: [accepted()], corrections: [correction(FROM), correction(TO)] }),
  );
  assert.strictEqual(result.value, 1);
});
