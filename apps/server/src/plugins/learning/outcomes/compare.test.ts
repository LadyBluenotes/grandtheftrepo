import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { flagFor, flagKind, judge, latestComplete, respondedTo, windows } from "./compare.ts";

describe("judge", () => {
  it("is ineffective when three or more recurred and that is more than half of before", () => {
    assert.strictEqual(judge({ before: 5, after: 4 }), "ineffective");
    assert.strictEqual(judge({ before: 5, after: 5 }), "ineffective");
    assert.strictEqual(judge({ before: 5, after: 3 }), "ineffective");
    assert.strictEqual(judge({ before: 3, after: 3 }), "ineffective");
    assert.strictEqual(judge({ before: 5, after: 9 }), "ineffective");
  });

  it("is settled when nothing recurred", () => {
    assert.strictEqual(judge({ before: 5, after: 0 }), "settled");
    assert.strictEqual(judge({ before: 3, after: 0 }), "settled");
  });

  it("is improved when after is at most half of before, however many are left", () => {
    assert.strictEqual(judge({ before: 5, after: 1 }), "improved");
    assert.strictEqual(judge({ before: 5, after: 2 }), "improved");
    assert.strictEqual(judge({ before: 20, after: 3 }), "improved");
    assert.strictEqual(judge({ before: 6, after: 3 }), "improved");
    assert.strictEqual(judge({ before: 20, after: 10 }), "improved");
    assert.strictEqual(judge({ before: 20, after: 11 }), "ineffective");
  });

  it("is inconclusive for two after from three before: too little change to call", () => {
    assert.strictEqual(judge({ before: 3, after: 2 }), "inconclusive");
  });

  it("has nothing to compare under three recurrences before, whatever came after", () => {
    assert.strictEqual(judge({ before: 2, after: 0 }), "inconclusive");
    assert.strictEqual(judge({ before: 2, after: 6 }), "inconclusive");
    assert.strictEqual(judge({ before: 0, after: 0 }), "inconclusive");
  });
});

describe("windows", () => {
  it("is 28 days either side of the adoption, with the adoption instant in the after window", () => {
    assert.deepStrictEqual(windows("2026-10-01T12:00:00.000Z"), {
      before: { from: "2026-09-03T12:00:00.000Z", to: "2026-10-01T12:00:00.000Z" },
      after: { from: "2026-10-01T12:00:00.000Z", to: "2026-10-29T12:00:00.000Z" },
    });
  });

  it("completes the after window exactly 28 days after the adoption", () => {
    const now = DateTime.makeUnsafe("2026-10-29T12:00:00.000Z");
    assert.strictEqual(latestComplete(now), "2026-10-01T12:00:00.000Z");
  });
});

describe("respondedTo", () => {
  const adopted = "2026-10-01T12:00:00.000Z";

  it("is true only for a disposition set after the adoption", () => {
    assert.isTrue(respondedTo(adopted, "2026-10-01T12:00:00.001Z"));
    assert.isFalse(respondedTo(adopted, adopted));
    assert.isFalse(respondedTo(adopted, "2026-09-30T08:00:00.000Z"));
    assert.isFalse(respondedTo(adopted, null));
  });
});

describe("flagFor", () => {
  const input = { failureMode: "scope_drift", ownerKind: "project_knowledge", after: 4 } as const;

  it("names the mode, the count and the owner kind of an ineffective handover", () => {
    assert.deepStrictEqual(flagFor("ineffective", input), {
      kind: "promotion_ineffective",
      text: "Scope drift recurred 4 times in the four weeks after its project knowledge handover.",
    });
  });

  it("tells a person a settled item can be closed", () => {
    assert.deepStrictEqual(flagFor("settled", { ...input, after: 0 }), {
      kind: "promotion_settled",
      text: "Scope drift has not recurred in four weeks; close the item if it is done.",
    });
  });

  it("raises nothing for an improvement or an inconclusive verdict", () => {
    assert.isNull(flagFor("improved", input));
    assert.isNull(flagFor("inconclusive", input));
    assert.isNull(flagKind("improved"));
    assert.isNull(flagKind("inconclusive"));
  });
});
