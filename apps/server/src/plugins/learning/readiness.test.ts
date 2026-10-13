import { assert, describe, it } from "@effect/vitest";

import { promotersCheck, sweepsCheck } from "./readiness.ts";

const sweeps = (...names: ReadonlyArray<string>) =>
  names.map((name) => ({ plugin: "learning", name }));

describe("sweepsCheck", () => {
  it("is ready when the three sweeps run for real", () => {
    const check = sweepsCheck({
      dryRun: false,
      sweeps: [
        ...sweeps("classify", "promote", "regressions"),
        { plugin: "kanban", name: "writers" },
      ],
    });
    assert.strictEqual(check.status, "ready");
  });

  it("names a missing sweep, and a dry run that keeps them from acting", () => {
    const missing = sweepsCheck({ dryRun: false, sweeps: sweeps("classify", "promote") });
    assert.strictEqual(missing.status, "attention");
    assert.strictEqual(
      missing.sentence,
      "The regressions sweep is not registered, so corrections are not turned into items; restart the server.",
    );
    const dry = sweepsCheck({ dryRun: true, sweeps: sweeps("classify", "promote", "regressions") });
    assert.strictEqual(dry.status, "attention");
  });
});

describe("promotersCheck", () => {
  it("is ready when every candidate's owner kind has a promoter", () => {
    assert.strictEqual(promotersCheck([], []).status, "ready");
    assert.strictEqual(
      promotersCheck([{ ownerKind: "policy" }], ["policy", "prompt"]).status,
      "ready",
    );
  });

  it("names the owner kinds whose candidates wait", () => {
    const check = promotersCheck(
      [
        { ownerKind: "project_knowledge" },
        { ownerKind: "policy" },
        { ownerKind: "project_knowledge" },
      ],
      ["policy"],
    );
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "2 candidates for project knowledge wait: no promoter takes that owner kind yet.",
    );
  });
});
