import { assert, describe, it } from "@effect/vitest";

import { ratesCheck, reactorCheck, weeklyReportCheck } from "./readiness.ts";

describe("ratesCheck", () => {
  it("is ready when the snapshot holds rates", () => {
    assert.strictEqual(ratesCheck(412).status, "ready");
  });

  it("sends a person to Usage when there is no snapshot", () => {
    const check = ratesCheck("missing");
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(check.target, "usage");
    assert.strictEqual(ratesCheck(0).status, "attention");
  });
});

describe("weeklyReportCheck", () => {
  it("is ready while the project's task is enabled", () => {
    assert.strictEqual(weeklyReportCheck({ enabled: true }).status, "ready");
  });

  it("needs the task to exist and be enabled", () => {
    assert.strictEqual(weeklyReportCheck(undefined).status, "attention");
    const disabled = weeklyReportCheck({ enabled: false });
    assert.strictEqual(disabled.status, "attention");
    assert.strictEqual(disabled.target, "scheduled_tasks");
  });
});

describe("reactorCheck", () => {
  it("is ready once the tables hold every committed event", () => {
    assert.strictEqual(reactorCheck(null).status, "ready");
  });

  it("passes on why the tables are not ready", () => {
    const check = reactorCheck("Telemetry is still replaying the event log.");
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(check.sentence, "Telemetry is still replaying the event log.");
  });
});
