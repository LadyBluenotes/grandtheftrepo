import { assert, describe, it } from "@effect/vitest";

import { directoryCheck, stopCheck } from "./readiness.ts";

describe("directoryCheck", () => {
  it("is ready when the issue folder exists and is writable", () => {
    assert.strictEqual(directoryCheck("/wiki/repo/issues", "writable").status, "ready");
  });

  it("sends a person to the board to create a missing folder", () => {
    const check = directoryCheck("/wiki/repo/issues", "missing");
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "/wiki/repo/issues does not exist yet; add a card for this project on the board to create it.",
    );
    assert.strictEqual(check.target, "board");
    assert.strictEqual(directoryCheck("/wiki/repo/issues", "read_only").status, "attention");
  });
});

describe("stopCheck", () => {
  it("is ready while no stop is set", () => {
    assert.strictEqual(stopCheck(null).status, "ready");
  });

  it("names the reason a stop was set", () => {
    const check = stopCheck({
      setAt: "2026-10-01T00:00:00.000Z",
      setBy: "user",
      reason: "runaway agent",
    });
    assert.strictEqual(check.status, "attention");
    assert.strictEqual(
      check.sentence,
      "An emergency stop is set (runaway agent), so nothing starts threads on its own; clear it on the board.",
    );
  });
});
